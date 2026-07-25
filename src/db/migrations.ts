import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  createCanonicalSchema,
  CURRENT_DATABASE_SCHEMA_VERSION,
  validateCanonicalDatabase,
} from "./canonical-schema.js";
import { DEVSPACE_CAPABILITY_SCOPES } from "../oauth-scopes.js";
import { ALL_AUTHORIZED_ROOTS_ID } from "../authorization-roots.js";

const LEGACY_UNOWNED_PRINCIPAL = "__legacy_unowned__";
const LEGACY_FULL_SCOPE = "devspace";

type Row = Record<string, unknown>;

interface NormalizedPrincipal {
  principalId: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}

interface NormalizedOAuthClient {
  clientId: string;
  principalId: string | null;
  clientJson: string;
  issuedAt: number;
}

interface NormalizedOAuthGrant {
  grantId: string;
  clientId: string;
  principalId: string;
  subjectHash: string | null;
  organizationHash: string | null;
  grantedScopes: string[];
  allowedRootIds: string[];
  authorizationEpoch: number;
  createdAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}

interface NormalizedWorkspace {
  id: string;
  connectionPrincipalId: string;
  alias: string;
  root: string;
  canonicalRoot: string | null;
  status: "active" | "closed" | "revoked";
  mode: "checkout" | "worktree";
  sourceRoot: string | null;
  baseRef: string | null;
  baseSha: string | null;
  dirtySource: "true" | "false";
  managed: "true" | "false";
  writeAccess: "read_only" | "read_write";
  stateGeneration: number;
  createdAt: string;
  lastUsedAt: string;
}

interface NormalizedOperation {
  connectionPrincipalId: string;
  workspaceId: string;
  tool: string;
  operationId: string;
  workspaceGeneration: number;
  requestHash: string;
  state:
    | "pending"
    | "settled"
    | "outcome_unknown"
    | "verified_committed"
    | "verified_not_started"
    | "acknowledged_unknown";
  resultJson: string | null;
  resolutionMethod: string | null;
  evidenceType: string | null;
  evidenceJson: string | null;
  resolvedAt: string | null;
  operatorRef: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface DatabasePreparationResult {
  migrated: boolean;
  sourceVersion: number;
  backupPath?: string;
}

export function prepareDatabaseFile(path: string): DatabasePreparationResult {
  if (!existsSync(path)) return { migrated: false, sourceVersion: 0 };

  const source = new Database(path);
  let sourceVersion = 0;
  try {
    source.pragma("busy_timeout = 5000");
    source.pragma("foreign_keys = ON");
    source.pragma("wal_checkpoint(TRUNCATE)");
    sourceVersion = databaseSchemaVersion(source);
    if (sourceVersion > CURRENT_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${sourceVersion} is newer than this DevSpace version supports (${CURRENT_DATABASE_SCHEMA_VERSION}).`,
      );
    }
    if (sourceVersion === CURRENT_DATABASE_SCHEMA_VERSION) {
      validateCanonicalDatabase(source);
      return { migrated: false, sourceVersion };
    }
    if (sourceVersion === 0 && userTableNames(source).length === 0) {
      return { migrated: false, sourceVersion };
    }
  } finally {
    source.close();
  }

  const temporaryPath = `${path}.v${CURRENT_DATABASE_SCHEMA_VERSION}-migrating-${process.pid}-${randomUUID()}`;
  const backupPath = uniqueBackupPath(path);
  let sourceDatabase: Database.Database | undefined;
  let targetDatabase: Database.Database | undefined;
  try {
    sourceDatabase = new Database(path, { readonly: true, fileMustExist: true });
    sourceDatabase.pragma("busy_timeout = 5000");
    sourceDatabase.pragma("foreign_keys = ON");

    targetDatabase = new Database(temporaryPath);
    targetDatabase.pragma("journal_mode = DELETE");
    targetDatabase.pragma("synchronous = FULL");
    targetDatabase.pragma("foreign_keys = ON");

    const migrate = targetDatabase.transaction(() => {
      createCanonicalSchema(targetDatabase!);
      migrateLegacyData(sourceDatabase!, targetDatabase!, sourceVersion);
    });
    migrate.immediate();
    validateCanonicalDatabase(targetDatabase);
    targetDatabase.close();
    targetDatabase = undefined;
    sourceDatabase.close();
    sourceDatabase = undefined;
    chmodSync(temporaryPath, 0o600);

    removeSqliteSidecars(path);
    renameSync(path, backupPath);
    try {
      renameSync(temporaryPath, path);
    } catch (error) {
      renameSync(backupPath, path);
      throw error;
    }
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
    return { migrated: true, sourceVersion, backupPath };
  } catch (error) {
    try {
      targetDatabase?.close();
    } catch {
      // Preserve the migration error.
    }
    try {
      sourceDatabase?.close();
    } catch {
      // Preserve the migration error.
    }
    rmSync(temporaryPath, { force: true });
    removeSqliteSidecars(temporaryPath);
    throw error;
  }
}

export function migrateDatabase(sqlite: Database.Database): void {
  const version = databaseSchemaVersion(sqlite);
  if (version === 0 && userTableNames(sqlite).length === 0) {
    const create = sqlite.transaction(() => createCanonicalSchema(sqlite));
    create.immediate();
  } else if (version !== CURRENT_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${version || "legacy"} must be upgraded before opening.`,
    );
  }
  validateCanonicalDatabase(sqlite);
}

function migrateLegacyData(
  source: Database.Database,
  target: Database.Database,
  sourceVersion: number,
): void {
  const now = new Date().toISOString();
  const principalMap = normalizePrincipals(source, now);
  const clients = normalizeOAuthClients(source, sourceVersion, principalMap, now);
  const grants = normalizeOAuthGrants(source, clients, principalMap, now);
  const clientPrincipalMap = new Map(
    clients
      .filter((client): client is NormalizedOAuthClient & { principalId: string } => Boolean(client.principalId))
      .map((client) => [client.clientId, client.principalId]),
  );
  const legacyOwner = resolveLegacyOwner(principalMap, clients);
  const workspaces = normalizeWorkspaces(
    source,
    sourceVersion,
    principalMap,
    clientPrincipalMap,
    legacyOwner,
    now,
  );
  normalizeDuplicateCheckouts(workspaces);

  insertPrincipals(target, principalMap.values());
  insertOAuthClients(target, clients);
  insertOAuthGrants(target, grants);
  insertWorkspaces(target, workspaces);
  insertLoadedAgentFiles(source, target, new Set(workspaces.map((workspace) => workspace.id)));
  insertMutationOperations(
    target,
    normalizeMutationOperations(source, workspaces, sourceVersion, clientPrincipalMap, legacyOwner),
  );
  insertOAuthOwnerCredential(source, target);
  insertOAuthTokens(source, target, "oauth_access_tokens", grants, principalMap);
  insertOAuthTokens(source, target, "oauth_refresh_tokens", grants, principalMap);
  insertReconnectCodes(source, target, principalMap);
  insertAuthorizationLimits(source, target);
  insertCleanupJobs(source, target, sourceVersion, clientPrincipalMap, legacyOwner);
  insertDirtyArtifacts(source, target, sourceVersion, clientPrincipalMap, legacyOwner);
  insertLocalAgentSessions(source, target);
}

function normalizePrincipals(
  source: Database.Database,
  now: string,
): Map<string, NormalizedPrincipal> {
  const principals = new Map<string, NormalizedPrincipal>();
  for (const row of tableRows(source, "connection_principals")) {
    const principalId = requiredString(row, "principal_id");
    mergePrincipal(principals, {
      principalId,
      createdAt: optionalString(row, "created_at") ?? now,
      lastUsedAt: optionalString(row, "last_used_at") ?? now,
      revokedAt: nullableString(row, "revoked_at"),
    });
  }
  return principals;
}

function normalizeOAuthClients(
  source: Database.Database,
  sourceVersion: number,
  principals: Map<string, NormalizedPrincipal>,
  now: string,
): NormalizedOAuthClient[] {
  const hasPrincipalColumn = tableColumns(source, "oauth_clients").has("principal_id");
  return tableRows(source, "oauth_clients").map((row) => {
    const clientId = requiredString(row, "client_id");
    let principalId = hasPrincipalColumn ? nullableString(row, "principal_id") : clientId;
    if (!principalId && sourceVersion < 13) principalId = clientId;
    if (principalId) {
      const existing = principals.get(principalId);
      if (!existing) {
        mergePrincipal(principals, {
          principalId,
          createdAt: now,
          lastUsedAt: now,
          revokedAt: null,
        });
      } else if (existing.revokedAt) {
        principalId = null;
      }
    }
    return {
      clientId,
      principalId,
      clientJson: requiredString(row, "client_json"),
      issuedAt: nonNegativeInteger(row.issued_at, 0),
    };
  });
}

function normalizeOAuthGrants(
  source: Database.Database,
  clients: readonly NormalizedOAuthClient[],
  principals: ReadonlyMap<string, NormalizedPrincipal>,
  now: string,
): NormalizedOAuthGrant[] {
  const clientIds = new Set(clients.map((client) => client.clientId));
  const persisted = tableRows(source, "oauth_grants");
  if (persisted.length > 0) {
    return persisted.flatMap((row): NormalizedOAuthGrant[] => {
      const clientId = optionalString(row, "client_id");
      const principalId = optionalString(row, "principal_id");
      if (
        !clientId ||
        !principalId ||
        !clientIds.has(clientId) ||
        !principals.has(principalId) ||
        principals.get(principalId)?.revokedAt
      ) return [];
      const grantedScopes = normalizeOAuthScopes(
        nullableString(row, "granted_scopes_json"),
      ) ?? migratedClientScopes(source, clientId);
      return [{
        grantId: requiredString(row, "grant_id"),
        clientId,
        principalId,
        subjectHash: nullableString(row, "subject_hash"),
        organizationHash: nullableString(row, "organization_hash"),
        grantedScopes,
        allowedRootIds: normalizeAllowedRootIds(
          nullableString(row, "allowed_root_ids_json"),
        ),
        authorizationEpoch: positiveInteger(row.authorization_epoch, 1),
        createdAt: optionalString(row, "created_at") ?? now,
        lastUsedAt: optionalString(row, "last_used_at") ?? now,
        revokedAt: nullableString(row, "revoked_at"),
      }];
    });
  }

  const grants: NormalizedOAuthGrant[] = [];
  for (const client of clients) {
    if (!client.principalId || principals.get(client.principalId)?.revokedAt) continue;
    const grantedScopes = migratedClientScopes(source, client.clientId);
    const createdAt = client.issuedAt > 0
      ? new Date(client.issuedAt * 1_000).toISOString()
      : now;
    grants.push({
      grantId: migratedGrantId(client.clientId, client.principalId),
      clientId: client.clientId,
      principalId: client.principalId,
      subjectHash: null,
      organizationHash: null,
      grantedScopes,
      allowedRootIds: [ALL_AUTHORIZED_ROOTS_ID],
      authorizationEpoch: 1,
      createdAt,
      lastUsedAt: principals.get(client.principalId)?.lastUsedAt ?? createdAt,
      revokedAt: null,
    });
  }
  return grants;
}

function migratedClientScopes(source: Database.Database, clientId: string): string[] {
  const requested = new Set<string>();
  for (const table of ["oauth_access_tokens", "oauth_refresh_tokens"] as const) {
    for (const row of tableRows(source, table)) {
      if (optionalString(row, "client_id") !== clientId) continue;
      for (const scope of normalizeOAuthScopes(nullableString(row, "scopes_json")) ?? []) {
        requested.add(scope);
      }
    }
  }
  const scopes = DEVSPACE_CAPABILITY_SCOPES.filter((scope) => requested.has(scope));
  return scopes.length > 0 ? scopes : [...DEVSPACE_CAPABILITY_SCOPES];
}

function migratedGrantId(clientId: string, principalId: string): string {
  const digest = createHash("sha256")
    .update("devspace-migrated-oauth-grant-v1\0", "utf8")
    .update(clientId, "utf8")
    .update("\0", "utf8")
    .update(principalId, "utf8")
    .digest("base64url")
    .slice(0, 32);
  return `grant-${digest}`;
}

function resolveLegacyOwner(
  principals: Map<string, NormalizedPrincipal>,
  clients: readonly NormalizedOAuthClient[],
): string | undefined {
  const active = [...principals.values()]
    .filter((principal) => principal.revokedAt === null)
    .map((principal) => principal.principalId)
    .sort();
  if (active.length === 1) return active[0];
  if (active.length > 1) return undefined;

  const clientPrincipals = [...new Set(
    clients.map((client) => client.principalId).filter((value): value is string => Boolean(value)),
  )];
  return clientPrincipals.length === 1 ? clientPrincipals[0] : undefined;
}

function normalizeWorkspaces(
  source: Database.Database,
  sourceVersion: number,
  principals: Map<string, NormalizedPrincipal>,
  clientPrincipalMap: ReadonlyMap<string, string>,
  legacyOwner: string | undefined,
  now: string,
): NormalizedWorkspace[] {
  const columns = tableColumns(source, "workspace_sessions");
  const ownerColumn = columns.has("connection_principal_id")
    ? "connection_principal_id"
    : columns.has("owner_client_id")
      ? "owner_client_id"
      : undefined;
  const raw = tableRows(source, "workspace_sessions").map((row): Omit<NormalizedWorkspace, "alias"> & {
    requestedAlias?: string;
  } => {
    const id = requiredString(row, "id");
    const root = requiredString(row, "root");
    const mode = enumValue(row.mode, ["checkout", "worktree"] as const, "checkout");
    let status = enumValue(row.status, ["active", "closed", "revoked"] as const, "active");
    const rawOwner = ownerColumn ? optionalString(row, ownerColumn) : LEGACY_UNOWNED_PRINCIPAL;
    const connectionPrincipalId = canonicalPrincipalId(
      rawOwner,
      sourceVersion,
      principals,
      clientPrincipalMap,
      legacyOwner,
      now,
      `workspace ${id}`,
    );
    const canonical = mode === "checkout" ? canonicalWorkspaceRoot(root) : { path: null, available: true };
    if (mode === "checkout" && status === "active" && !canonical.available) status = "closed";
    const writeAccess = mode === "worktree"
      ? "read_write"
      : enumValue(row.write_access, ["read_only", "read_write"] as const, "read_write");
    return {
      id,
      connectionPrincipalId,
      requestedAlias: optionalString(row, "alias"),
      root,
      canonicalRoot: canonical.path,
      status,
      mode,
      sourceRoot: nullableString(row, "source_root"),
      baseRef: nullableString(row, "base_ref"),
      baseSha: nullableString(row, "base_sha"),
      dirtySource: booleanText(row.dirty_source, "false"),
      managed: booleanText(row.managed, mode === "worktree" ? "true" : "false"),
      writeAccess,
      stateGeneration: positiveInteger(row.state_generation, 1),
      createdAt: optionalString(row, "created_at") ?? now,
      lastUsedAt: optionalString(row, "last_used_at") ?? now,
    };
  });

  const groups = new Map<string, typeof raw>();
  for (const workspace of raw) {
    const group = groups.get(workspace.connectionPrincipalId) ?? [];
    group.push(workspace);
    groups.set(workspace.connectionPrincipalId, group);
  }

  const normalized: NormalizedWorkspace[] = [];
  for (const group of groups.values()) {
    const used = new Set<string>();
    group.sort((left, right) =>
      Number(Boolean(right.requestedAlias && validAlias(right.requestedAlias))) -
        Number(Boolean(left.requestedAlias && validAlias(left.requestedAlias))) ||
      workspaceStatusRank(left.status) - workspaceStatusRank(right.status) ||
      right.lastUsedAt.localeCompare(left.lastUsedAt) ||
      left.id.localeCompare(right.id));
    for (const workspace of group) {
      const candidate = workspace.requestedAlias && validAlias(workspace.requestedAlias)
        ? workspace.requestedAlias.trim()
        : derivedWorkspaceAlias(workspace);
      normalized.push({
        ...workspace,
        alias: uniqueAlias(candidate, used),
      });
    }
  }
  return normalized;
}

function normalizeDuplicateCheckouts(workspaces: NormalizedWorkspace[]): void {
  const groups = new Map<string, NormalizedWorkspace[]>();
  for (const workspace of workspaces) {
    if (
      workspace.status !== "active" ||
      workspace.mode !== "checkout" ||
      workspace.canonicalRoot === null
    ) continue;
    const key = `${workspace.connectionPrincipalId}\0${workspace.canonicalRoot}`;
    const group = groups.get(key) ?? [];
    group.push(workspace);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) =>
      right.lastUsedAt.localeCompare(left.lastUsedAt) || left.id.localeCompare(right.id));
    for (const duplicate of group.slice(1)) duplicate.status = "closed";
  }
}

function insertPrincipals(
  target: Database.Database,
  principals: Iterable<NormalizedPrincipal>,
): void {
  const insert = target.prepare(`
    insert into connection_principals (
      principal_id, created_at, last_used_at, revoked_at
    ) values (?, ?, ?, ?)
  `);
  for (const principal of principals) {
    insert.run(principal.principalId, principal.createdAt, principal.lastUsedAt, principal.revokedAt);
  }
}

function insertOAuthClients(
  target: Database.Database,
  clients: readonly NormalizedOAuthClient[],
): void {
  const insert = target.prepare(`
    insert into oauth_clients (client_id, client_json, issued_at)
    values (?, ?, ?)
  `);
  for (const client of clients) {
    insert.run(client.clientId, client.clientJson, client.issuedAt);
  }
}

function insertOAuthGrants(
  target: Database.Database,
  grants: readonly NormalizedOAuthGrant[],
): void {
  const insert = target.prepare(`
    insert into oauth_grants (
      grant_id, client_id, principal_id, subject_hash, organization_hash,
      granted_scopes_json, allowed_root_ids_json, authorization_epoch,
      created_at, last_used_at, revoked_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const grant of grants) {
    insert.run(
      grant.grantId,
      grant.clientId,
      grant.principalId,
      grant.subjectHash,
      grant.organizationHash,
      JSON.stringify(grant.grantedScopes),
      JSON.stringify(grant.allowedRootIds),
      grant.authorizationEpoch,
      grant.createdAt,
      grant.lastUsedAt,
      grant.revokedAt,
    );
  }
}

function insertWorkspaces(target: Database.Database, workspaces: readonly NormalizedWorkspace[]): void {
  const insert = target.prepare(`
    insert into workspace_sessions (
      id, connection_principal_id, alias, root, canonical_root, status, mode,
      source_root, base_ref, base_sha, dirty_source, managed, write_access,
      state_generation, created_at, last_used_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const workspace of workspaces) {
    insert.run(
      workspace.id,
      workspace.connectionPrincipalId,
      workspace.alias,
      workspace.root,
      workspace.canonicalRoot,
      workspace.status,
      workspace.mode,
      workspace.sourceRoot,
      workspace.baseRef,
      workspace.baseSha,
      workspace.dirtySource,
      workspace.managed,
      workspace.writeAccess,
      workspace.stateGeneration,
      workspace.createdAt,
      workspace.lastUsedAt,
    );
  }
}

function insertLoadedAgentFiles(
  source: Database.Database,
  target: Database.Database,
  workspaceIds: ReadonlySet<string>,
): void {
  const insert = target.prepare(`
    insert or replace into loaded_agent_files (
      workspace_session_id, path, content_hash, content, loaded_at, last_seen_at
    ) values (?, ?, ?, ?, ?, ?)
  `);
  for (const row of tableRows(source, "loaded_agent_files")) {
    const workspaceId = optionalString(row, "workspace_session_id");
    if (!workspaceId || !workspaceIds.has(workspaceId)) continue;
    insert.run(
      workspaceId,
      requiredString(row, "path"),
      requiredString(row, "content_hash"),
      requiredString(row, "content"),
      requiredString(row, "loaded_at"),
      requiredString(row, "last_seen_at"),
    );
  }
}

function normalizeMutationOperations(
  source: Database.Database,
  workspaces: readonly NormalizedWorkspace[],
  sourceVersion: number,
  clientPrincipalMap: ReadonlyMap<string, string>,
  legacyOwner: string | undefined,
): NormalizedOperation[] {
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const columns = tableColumns(source, "mutation_operations");
  const ownerColumn = columns.has("connection_principal_id")
    ? "connection_principal_id"
    : "owner_client_id";
  const candidates = new Map<string, Array<NormalizedOperation & { rowId: number }>>();
  for (const row of tableRows(source, "mutation_operations", true)) {
    const workspaceId = optionalString(row, "workspace_id");
    const operationId = optionalString(row, "operation_id");
    if (!workspaceId || !operationId) continue;
    const workspace = workspaceById.get(workspaceId);
    if (!workspace) continue;
    let principalId: string;
    try {
      principalId = canonicalPrincipalId(
        optionalString(row, ownerColumn),
        sourceVersion,
        new Map([[workspace.connectionPrincipalId, {
          principalId: workspace.connectionPrincipalId,
          createdAt: workspace.createdAt,
          lastUsedAt: workspace.lastUsedAt,
          revokedAt: null,
        }]]),
        clientPrincipalMap,
        legacyOwner,
        workspace.createdAt,
        `operation ${operationId}`,
      );
    } catch {
      continue;
    }
    if (principalId !== workspace.connectionPrincipalId) continue;
    const state = enumValue(
      row.state,
      [
        "pending",
        "settled",
        "outcome_unknown",
        "verified_committed",
        "verified_not_started",
        "acknowledged_unknown",
      ] as const,
      "outcome_unknown",
    );
    const operation: NormalizedOperation & { rowId: number } = {
      connectionPrincipalId: principalId,
      workspaceId,
      tool: optionalString(row, "tool") ?? "unknown",
      operationId,
      workspaceGeneration: positiveInteger(row.workspace_generation, workspace.stateGeneration),
      requestHash: optionalString(row, "request_hash") ?? "unavailable",
      state,
      resultJson: normalizeMutationResult(nullableString(row, "result_json")),
      resolutionMethod: nullableString(row, "resolution_method"),
      evidenceType: nullableString(row, "evidence_type"),
      evidenceJson: nullableString(row, "evidence_json"),
      resolvedAt: nullableString(row, "resolved_at"),
      operatorRef: nullableString(row, "operator_ref"),
      createdAt: optionalString(row, "created_at") ?? workspace.createdAt,
      updatedAt: optionalString(row, "updated_at") ?? workspace.lastUsedAt,
      expiresAt: optionalString(row, "expires_at") ?? workspace.lastUsedAt,
      rowId: nonNegativeInteger(row.__rowid, 0),
    };
    const key = `${principalId}\0${operationId}`;
    const group = candidates.get(key) ?? [];
    group.push(operation);
    candidates.set(key, group);
  }

  return [...candidates.values()].map((group) => {
    group.sort((left, right) =>
      operationPreference(right) - operationPreference(left) ||
      right.updatedAt.localeCompare(left.updatedAt) ||
      right.createdAt.localeCompare(left.createdAt) ||
      right.rowId - left.rowId);
    const { rowId: _rowId, ...selected } = group[0]!;
    return selected;
  });
}

function insertMutationOperations(
  target: Database.Database,
  operations: readonly NormalizedOperation[],
): void {
  const insert = target.prepare(`
    insert into mutation_operations (
      connection_principal_id, workspace_id, tool, operation_id,
      workspace_generation, request_hash, state, result_json,
      resolution_method, evidence_type, evidence_json, resolved_at, operator_ref,
      created_at, updated_at, expires_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const operation of operations) {
    insert.run(
      operation.connectionPrincipalId,
      operation.workspaceId,
      operation.tool,
      operation.operationId,
      operation.workspaceGeneration,
      operation.requestHash,
      operation.state,
      operation.resultJson,
      operation.resolutionMethod,
      operation.evidenceType,
      operation.evidenceJson,
      operation.resolvedAt,
      operation.operatorRef,
      operation.createdAt,
      operation.updatedAt,
      operation.expiresAt,
    );
  }
}

function insertOAuthOwnerCredential(source: Database.Database, target: Database.Database): void {
  const insert = target.prepare(`
    insert into oauth_owner_credential (id, salt, verifier, updated_at)
    values (?, ?, ?, ?)
  `);
  for (const row of tableRows(source, "oauth_owner_credential")) {
    if (nonNegativeInteger(row.id, 0) !== 1) continue;
    insert.run(1, requiredString(row, "salt"), requiredString(row, "verifier"), requiredString(row, "updated_at"));
  }
}

function insertOAuthTokens(
  source: Database.Database,
  target: Database.Database,
  table: "oauth_access_tokens" | "oauth_refresh_tokens",
  grants: readonly NormalizedOAuthGrant[],
  principals: ReadonlyMap<string, NormalizedPrincipal>,
): void {
  const grantByClientId = new Map(grants.map((grant) => [grant.clientId, grant]));
  const insert = target.prepare(`
    insert into ${table} (
      token_hash, grant_id, client_id, principal_id, authorization_epoch,
      scopes_json, expires_at, resource
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of tableRows(source, table)) {
    const clientId = optionalString(row, "client_id");
    const grant = clientId ? grantByClientId.get(clientId) : undefined;
    if (!grant || principals.get(grant.principalId)?.revokedAt) continue;
    const scopes = normalizeOAuthScopes(nullableString(row, "scopes_json"));
    if (!scopes) continue;
    insert.run(
      requiredString(row, "token_hash"),
      grant.grantId,
      clientId,
      grant.principalId,
      grant.authorizationEpoch,
      JSON.stringify(scopes),
      nonNegativeInteger(row.expires_at, 0),
      nullableString(row, "resource"),
    );
  }
}

function insertReconnectCodes(
  source: Database.Database,
  target: Database.Database,
  principals: ReadonlyMap<string, NormalizedPrincipal>,
): void {
  const insert = target.prepare(`
    insert into oauth_principal_reconnect_codes (
      code_hash, principal_id, created_at, expires_at
    ) values (?, ?, ?, ?)
  `);
  for (const row of tableRows(source, "oauth_principal_reconnect_codes")) {
    const principalId = optionalString(row, "principal_id");
    if (!principalId || !principals.has(principalId) || principals.get(principalId)?.revokedAt) continue;
    insert.run(
      requiredString(row, "code_hash"),
      principalId,
      nonNegativeInteger(row.created_at, 0),
      nonNegativeInteger(row.expires_at, 0),
    );
  }
}

function insertAuthorizationLimits(source: Database.Database, target: Database.Database): void {
  const insert = target.prepare(`
    insert into oauth_authorization_limits (
      key_hash, scope, tokens, updated_at, failure_streak, blocked_until, expires_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of tableRows(source, "oauth_authorization_limits")) {
    const scope = enumValue(row.scope, ["session", "client", "ip", "global"] as const, undefined);
    if (!scope) continue;
    insert.run(
      requiredString(row, "key_hash"),
      scope,
      nonNegativeInteger(row.tokens, 0),
      nonNegativeInteger(row.updated_at, 0),
      nonNegativeInteger(row.failure_streak, 0),
      nonNegativeInteger(row.blocked_until, 0),
      nonNegativeInteger(row.expires_at, 0),
    );
  }
}

function insertCleanupJobs(
  source: Database.Database,
  target: Database.Database,
  sourceVersion: number,
  clientPrincipalMap: ReadonlyMap<string, string>,
  legacyOwner: string | undefined,
): void {
  const insert = target.prepare(`
    insert into oauth_revocation_cleanup_jobs (
      id, connection_principal_id, workspace_id, workspace_root, workspace_mode,
      source_root, managed, dirty_source, status, claim_token, lease_expires_at,
      attempts, last_error, created_at, updated_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const used = new Set<string>();
  for (const row of tableRows(source, "oauth_revocation_cleanup_jobs")) {
    const workspaceId = optionalString(row, "workspace_id");
    if (!workspaceId) continue;
    const principalId = canonicalHistoricalPrincipalId(
      row,
      sourceVersion,
      clientPrincipalMap,
      legacyOwner,
    );
    if (!principalId) continue;
    const uniqueKey = `${principalId}\0${workspaceId}`;
    if (used.has(uniqueKey)) continue;
    used.add(uniqueKey);
    const originalStatus = enumValue(
      row.status,
      ["pending", "claimed", "failed", "completed"] as const,
      "pending",
    );
    const status = originalStatus === "claimed" ? "pending" : originalStatus;
    const completedAt = status === "completed"
      ? optionalString(row, "completed_at") ?? optionalString(row, "updated_at") ?? new Date().toISOString()
      : null;
    insert.run(
      positiveInteger(row.id, undefined),
      principalId,
      workspaceId,
      requiredString(row, "workspace_root"),
      enumValue(row.workspace_mode, ["checkout", "worktree"] as const, "checkout"),
      nullableString(row, "source_root"),
      booleanText(row.managed, "false"),
      booleanText(row.dirty_source, "false"),
      status,
      null,
      null,
      nonNegativeInteger(row.attempts, 0),
      nullableString(row, "last_error"),
      requiredString(row, "created_at"),
      requiredString(row, "updated_at"),
      completedAt,
    );
  }
}

function insertDirtyArtifacts(
  source: Database.Database,
  target: Database.Database,
  sourceVersion: number,
  clientPrincipalMap: ReadonlyMap<string, string>,
  legacyOwner: string | undefined,
): void {
  const insert = target.prepare(`
    insert into oauth_revocation_dirty_worktree_artifacts (
      job_id, connection_principal_id, workspace_id, workspace_root,
      source_root, reason, recorded_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of tableRows(source, "oauth_revocation_dirty_worktree_artifacts")) {
    const principalId = canonicalHistoricalPrincipalId(
      row,
      sourceVersion,
      clientPrincipalMap,
      legacyOwner,
    );
    if (!principalId) continue;
    insert.run(
      positiveInteger(row.job_id, undefined),
      principalId,
      requiredString(row, "workspace_id"),
      requiredString(row, "workspace_root"),
      nullableString(row, "source_root"),
      requiredString(row, "reason"),
      requiredString(row, "recorded_at"),
    );
  }
}

function insertLocalAgentSessions(source: Database.Database, target: Database.Database): void {
  const columns = tableColumns(source, "local_agent_sessions");
  const insert = target.prepare(`
    insert into local_agent_sessions (
      id, workspace_id, workspace_root, profile_name, provider, model, thinking,
      provider_session_id, status, latest_response, error, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of tableRows(source, "local_agent_sessions")) {
    insert.run(
      requiredString(row, "id"),
      nullableString(row, "workspace_id"),
      requiredString(row, "workspace_root"),
      requiredString(row, "profile_name"),
      requiredString(row, "provider"),
      nullableString(row, "model"),
      columns.has("thinking") ? nullableString(row, "thinking") : null,
      nullableString(row, "provider_session_id"),
      requiredString(row, "status"),
      nullableString(row, "latest_response"),
      nullableString(row, "error"),
      requiredString(row, "created_at"),
      requiredString(row, "updated_at"),
    );
  }
}

function canonicalHistoricalPrincipalId(
  row: Row,
  sourceVersion: number,
  clientPrincipalMap: ReadonlyMap<string, string>,
  legacyOwner: string | undefined,
): string | undefined {
  const raw = optionalString(row, "connection_principal_id") ?? optionalString(row, "owner_client_id");
  if (!raw || raw === LEGACY_UNOWNED_PRINCIPAL) return legacyOwner;
  return sourceVersion < 11 ? clientPrincipalMap.get(raw) ?? raw : raw;
}

function canonicalPrincipalId(
  raw: string | undefined,
  sourceVersion: number,
  principals: Map<string, NormalizedPrincipal>,
  clientPrincipalMap: ReadonlyMap<string, string>,
  legacyOwner: string | undefined,
  now: string,
  subject: string,
): string {
  if (!raw || raw === LEGACY_UNOWNED_PRINCIPAL) {
    if (!legacyOwner) {
      const candidates = [...principals.values()]
        .filter((principal) => principal.revokedAt === null)
        .map((principal) => principal.principalId)
        .sort();
      throw new Error(
        `Cannot assign ${subject}: legacy ownership is ambiguous across ${candidates.length} active connection principals` +
        `${candidates.length > 0 ? ` (${candidates.join(", ")})` : "."}`,
      );
    }
    return legacyOwner;
  }
  const principalId = sourceVersion < 11 ? clientPrincipalMap.get(raw) ?? raw : raw;
  if (!principals.has(principalId)) {
    mergePrincipal(principals, {
      principalId,
      createdAt: now,
      lastUsedAt: now,
      revokedAt: null,
    });
  }
  return principalId;
}

function mergePrincipal(
  principals: Map<string, NormalizedPrincipal>,
  candidate: NormalizedPrincipal,
): void {
  const existing = principals.get(candidate.principalId);
  if (!existing) {
    principals.set(candidate.principalId, candidate);
    return;
  }
  existing.createdAt = existing.createdAt <= candidate.createdAt ? existing.createdAt : candidate.createdAt;
  existing.lastUsedAt = existing.lastUsedAt >= candidate.lastUsedAt ? existing.lastUsedAt : candidate.lastUsedAt;
  if (!existing.revokedAt && candidate.revokedAt) existing.revokedAt = candidate.revokedAt;
}

function canonicalWorkspaceRoot(path: string): { path: string; available: boolean } {
  try {
    const canonical = realpathSync(path);
    return { path: canonical, available: statSync(canonical).isDirectory() };
  } catch {
    return { path: resolve(path), available: false };
  }
}

function derivedWorkspaceAlias(
  workspace: Omit<NormalizedWorkspace, "alias"> & { requestedAlias?: string },
): string {
  const identity = workspace.sourceRoot ?? workspace.root;
  const name = basename(resolve(identity));
  const sanitized = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .replace(/[-._]+$/u, "")
    .slice(0, 64);
  return validAlias(sanitized) ? sanitized : `workspace-${workspace.id.replace(/[^A-Za-z0-9]/gu, "").slice(0, 12) || "restored"}`;
}

function uniqueAlias(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  for (let suffix = 2; suffix < 100_000; suffix += 1) {
    const marker = `-${suffix}`;
    const next = `${candidate.slice(0, 64 - marker.length)}${marker}`;
    if (used.has(next)) continue;
    used.add(next);
    return next;
  }
  throw new Error(`Unable to allocate a unique Workspace alias for ${candidate}.`);
}

function validAlias(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.trim());
}

function workspaceStatusRank(status: NormalizedWorkspace["status"]): number {
  return status === "active" ? 0 : status === "closed" ? 1 : 2;
}

function operationPreference(operation: NormalizedOperation): number {
  if (operation.state === "verified_committed") return 6;
  if (operation.state === "verified_not_started") return 5;
  if (operation.state === "acknowledged_unknown") return 4;
  if (operation.state === "settled" && operation.resultJson !== null) return 3;
  if (operation.state === "settled") return 2;
  if (operation.state === "outcome_unknown") return 1;
  return 0;
}

function normalizeMutationResult(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.structuredContent && typeof record.structuredContent === "object" && !Array.isArray(record.structuredContent)) {
      const structured = { ...(record.structuredContent as Record<string, unknown>) };
      delete structured.receipt;
      delete structured.workspaceGeneration;
      delete structured.safeToRetry;
      if (structured.continuation && typeof structured.continuation === "object") {
        delete structured.continuation;
      }
      record.structuredContent = structured;
    }
    return JSON.stringify(record);
  } catch {
    return null;
  }
}

function normalizeOAuthScopes(value: string | null): string[] | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) return undefined;
  const requested = new Set(parsed as string[]);
  const unknown = [...requested].filter(
    (scope) => scope !== LEGACY_FULL_SCOPE && !DEVSPACE_CAPABILITY_SCOPES.includes(scope as never),
  );
  if (unknown.length > 0) return undefined;
  if (requested.has(LEGACY_FULL_SCOPE)) {
    for (const scope of DEVSPACE_CAPABILITY_SCOPES) requested.add(scope);
    requested.delete(LEGACY_FULL_SCOPE);
  }
  const scopes = DEVSPACE_CAPABILITY_SCOPES.filter((scope) => requested.has(scope));
  return scopes.length > 0 ? scopes : undefined;
}

function normalizeAllowedRootIds(value: string | null): string[] {
  if (!value) return [ALL_AUTHORIZED_ROOTS_ID];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [ALL_AUTHORIZED_ROOTS_ID];
  }
  if (!Array.isArray(parsed)) return [ALL_AUTHORIZED_ROOTS_ID];
  const ids = [...new Set(parsed.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 128,
  ))];
  if (ids.includes(ALL_AUTHORIZED_ROOTS_ID)) return [ALL_AUTHORIZED_ROOTS_ID];
  return ids.length > 0 ? ids.sort() : [ALL_AUTHORIZED_ROOTS_ID];
}

function tableRows(source: Database.Database, table: string, includeRowId = false): Row[] {
  if (!tableExists(source, table)) return [];
  const prefix = includeRowId ? "rowid as __rowid, " : "";
  return source.prepare(`select ${prefix}* from ${quotedIdentifier(table)}`).all() as Row[];
}

function tableExists(source: Database.Database, table: string): boolean {
  return Boolean(source.prepare(`
    select 1
    from sqlite_master
    where type = 'table' and name = ?
  `).get(table));
}

function tableColumns(source: Database.Database, table: string): Set<string> {
  if (!tableExists(source, table)) return new Set();
  return new Set(
    (source.prepare(`pragma table_info(${quotedIdentifier(table)})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
}

function userTableNames(source: Database.Database): string[] {
  return (source.prepare(`
    select name
    from sqlite_master
    where type = 'table'
      and name not like 'sqlite_%'
      and name != 'devspace_schema_migrations'
    order by name
  `).all() as Array<{ name: string }>).map((row) => row.name);
}

function databaseSchemaVersion(source: Database.Database): number {
  if (!tableExists(source, "devspace_schema_migrations")) return 0;
  const row = source
    .prepare("select max(version) as version from devspace_schema_migrations")
    .get() as { version: number | null };
  return row.version ?? 0;
}

function requiredString(row: Row, key: string): string {
  const value = optionalString(row, key);
  if (!value) throw new Error(`Legacy database field ${key} is missing or empty.`);
  return value;
}

function optionalString(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nullableString(row: Row, key: string): string | null {
  return optionalString(row, key) ?? null;
}

function positiveInteger(value: unknown, fallback: number | undefined): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error("Legacy database contains a missing or invalid positive integer.");
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function booleanText(value: unknown, fallback: "true" | "false"): "true" | "false" {
  if (value === true || value === 1 || value === "true") return "true";
  if (value === false || value === 0 || value === "false") return "false";
  return fallback;
}

function enumValue<const T extends readonly string[], F extends T[number] | undefined>(
  value: unknown,
  values: T,
  fallback: F,
): T[number] | F {
  return typeof value === "string" && values.includes(value) ? value as T[number] : fallback;
}

function quotedIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

function uniqueBackupPath(path: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const candidate = `${path}.pre-v${CURRENT_DATABASE_SCHEMA_VERSION}.${timestamp}.bak`;
  return existsSync(candidate) ? `${candidate}.${randomUUID()}` : candidate;
}

function removeSqliteSidecars(path: string): void {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
