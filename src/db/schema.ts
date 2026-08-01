import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    connectionPrincipalId: text("connection_principal_id").notNull(),
    alias: text("alias").notNull(),
    root: text("root").notNull(),
    canonicalRoot: text("canonical_root"),
    status: text("status", { enum: ["active", "closed", "revoked"] })
      .notNull(),
    writeAccess: text("write_access", { enum: ["read_only", "read_write"] })
      .notNull(),
    stateGeneration: integer("state_generation").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
    index("workspace_sessions_principal_status_idx").on(table.connectionPrincipalId, table.status, table.lastUsedAt),
    uniqueIndex("workspace_sessions_id_principal_uq").on(table.id, table.connectionPrincipalId),
    uniqueIndex("workspace_sessions_principal_alias_uq")
      .on(table.connectionPrincipalId, table.alias),
    check(
      "workspace_sessions_write_access_check",
      sql`${table.writeAccess} in ('read_only', 'read_write')`,
    ),
    check("workspace_sessions_state_generation_check", sql`${table.stateGeneration} >= 1`),
    check(
      "workspace_sessions_status_check",
      sql`${table.status} in ('active', 'closed', 'revoked')`,
    ),
  ],
);

export const mutationOperations = sqliteTable(
  "mutation_operations",
  {
    connectionPrincipalId: text("connection_principal_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    tool: text("tool").notNull(),
    operationId: text("operation_id").notNull(),
    workspaceGeneration: integer("workspace_generation").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state", { enum: [
      "pending",
      "settled",
      "outcome_unknown",
      "verified_committed",
      "verified_not_started",
      "acknowledged_unknown",
    ] }).notNull(),
    resultJson: text("result_json"),
    resolutionMethod: text("resolution_method"),
    evidenceType: text("evidence_type"),
    evidenceJson: text("evidence_json"),
    resolvedAt: text("resolved_at"),
    operatorRef: text("operator_ref"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.connectionPrincipalId, table.workspaceId, table.operationId],
    }),
    foreignKey({
      columns: [table.workspaceId, table.connectionPrincipalId],
      foreignColumns: [workspaceSessions.id, workspaceSessions.connectionPrincipalId],
    }).onDelete("cascade"),
    index("mutation_operations_expires_at_idx").on(table.expiresAt),
    index("mutation_operations_state_updated_idx").on(table.state, table.updatedAt),
    check(
      "mutation_operations_state_check",
      sql`${table.state} in ('pending', 'settled', 'outcome_unknown', 'verified_committed', 'verified_not_started', 'acknowledged_unknown')`,
    ),
    check(
      "mutation_operations_workspace_generation_check",
      sql`${table.workspaceGeneration} >= 1`,
    ),
  ],
);

export const applyPatchChanges = sqliteTable(
  "apply_patch_changes",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    connectionPrincipalId: text("connection_principal_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    operationId: text("operation_id").notNull(),
    tool: text("tool").notNull().default("apply_patch"),
    workspaceGeneration: integer("workspace_generation").notNull(),
    appliedAt: text("applied_at").notNull(),
    patch: text("patch").notNull(),
    filesJson: text("files_json").notNull(),
    summaryJson: text("summary_json").notNull(),
  },
  (table) => [
    uniqueIndex("apply_patch_changes_operation_uq").on(
      table.connectionPrincipalId,
      table.workspaceId,
      table.operationId,
    ),
    foreignKey({
      columns: [
        table.connectionPrincipalId,
        table.workspaceId,
        table.operationId,
      ],
      foreignColumns: [
        mutationOperations.connectionPrincipalId,
        mutationOperations.workspaceId,
        mutationOperations.operationId,
      ],
    }).onDelete("cascade"),
    index("apply_patch_changes_workspace_sequence_idx").on(
      table.connectionPrincipalId,
      table.workspaceId,
      table.sequence,
    ),
    check("apply_patch_changes_tool_check", sql`${table.tool} = 'apply_patch'`),
    check(
      "apply_patch_changes_workspace_generation_check",
      sql`${table.workspaceGeneration} >= 1`,
    ),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
  (table) => [index("oauth_clients_issued_at_idx").on(table.issuedAt)],
);

export const connectionPrincipals = sqliteTable(
  "connection_principals",
  {
    principalId: text("principal_id").primaryKey(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("connection_principals_last_used_idx").on(table.lastUsedAt),
    check("connection_principals_owner_check", sql`${table.principalId} = 'owner'`),
  ],
);

export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    grantId: text("grant_id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => connectionPrincipals.principalId),
    grantedScopesJson: text("granted_scopes_json").notNull(),
    allowedRootIdsJson: text("allowed_root_ids_json").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    absoluteExpiresAt: integer("absolute_expires_at"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("oauth_grants_identity_uq")
      .on(table.grantId, table.principalId, table.clientId),
    index("oauth_grants_client_id_idx").on(table.clientId, table.lastUsedAt),
    index("oauth_grants_principal_id_idx").on(table.principalId, table.lastUsedAt),
    check("oauth_grants_authorization_epoch_check", sql`${table.authorizationEpoch} >= 1`),
    check(
      "oauth_grants_absolute_expires_at_check",
      sql`${table.absoluteExpiresAt} is null or ${table.absoluteExpiresAt} >= 1`,
    ),
  ],
);

export const projectHandoffs = sqliteTable(
  "project_handoffs",
  {
    handoffId: text("handoff_id").primaryKey(),
    projectRef: text("project_ref").notNull(),
    projectFingerprint: text("project_fingerprint").notNull(),
    title: text("title").notNull(),
    progress: text("progress").notNull(),
    status: text("status", { enum: ["resumable", "completed"] }).notNull(),
    revision: integer("revision").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("project_handoffs_project_id_uq")
      .on(table.projectFingerprint, table.handoffId),
    index("project_handoffs_project_status_idx")
      .on(table.projectFingerprint, table.status, table.updatedAt, table.handoffId),
    check(
      "project_handoffs_title_check",
      sql`length(cast(${table.title} as blob)) between 1 and 256 and instr(${table.title}, char(0)) = 0`,
    ),
    check(
      "project_handoffs_progress_check",
      sql`length(cast(${table.progress} as blob)) between 1 and 8192 and instr(${table.progress}, char(0)) = 0`,
    ),
    check(
      "project_handoffs_status_check",
      sql`${table.status} in ('resumable', 'completed')`,
    ),
    check("project_handoffs_revision_check", sql`${table.revision} >= 1`),
    check(
      "project_handoffs_completion_check",
      sql`(
        ${table.status} = 'completed'
        and ${table.completedAt} is not null
      ) or (
        ${table.status} = 'resumable'
        and ${table.completedAt} is null
      )`,
    ),
  ],
);

export const projectExecutions = sqliteTable(
  "project_executions",
  {
    executionId: text("execution_id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => connectionPrincipals.principalId),
    clientId: text("client_id").notNull(),
    grantId: text("grant_id").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    projectRef: text("project_ref").notNull(),
    projectFingerprint: text("project_fingerprint").notNull(),
    sourceRoot: text("source_root").notNull(),
    canonicalSourceRoot: text("canonical_source_root").notNull(),
    workspaceId: text("workspace_id")
      .references(() => workspaceSessions.id, { onDelete: "set null" }),
    handoffId: text("handoff_id"),
    handoffRetired: integer("handoff_retired", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status", {
      enum: ["provisioning", "active", "revoked", "quarantined", "closed"],
    }).notNull(),
    stateGeneration: integer("state_generation").notNull(),
    createOperationId: text("create_operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_executions_create_operation_uq")
      .on(table.grantId, table.authorizationEpoch, table.createOperationId),
    index("project_executions_authorization_idx")
      .on(
        table.principalId,
        table.clientId,
        table.grantId,
        table.authorizationEpoch,
        table.status,
        table.lastUsedAt,
      ),
    index("project_executions_project_idx")
      .on(table.projectFingerprint, table.status, table.lastUsedAt),
    index("project_executions_handoff_idx").on(table.handoffId),
    foreignKey({
      columns: [table.projectFingerprint, table.handoffId],
      foreignColumns: [projectHandoffs.projectFingerprint, projectHandoffs.handoffId],
    }),
    check(
      "project_executions_authorization_epoch_check",
      sql`${table.authorizationEpoch} >= 1`,
    ),
    check(
      "project_executions_status_check",
      sql`${table.status} in ('provisioning', 'active', 'revoked', 'quarantined', 'closed')`,
    ),
    check(
      "project_executions_state_generation_check",
      sql`${table.stateGeneration} >= 1`,
    ),
    check(
      "project_executions_handoff_retired_check",
      sql`${table.handoffRetired} in (0, 1)`,
    ),
    check(
      "project_executions_handoff_retired_link_check",
      sql`${table.handoffRetired} = 0 or ${table.handoffId} is null`,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    level: text("level", { enum: ["error", "warn", "info", "debug"] }).notNull(),
    event: text("event").notNull(),
    requestId: text("request_id"),
    tool: text("tool"),
    oauthClientRef: text("oauth_client_ref"),
    connectionRef: text("connection_ref"),
    workspaceActivityRef: text("workspace_activity_ref"),
    operationRef: text("operation_ref"),
    errorCode: text("error_code"),
    errorCategory: text("error_category"),
    errorFingerprint: text("error_fingerprint"),
    detailsJson: text("details_json").notNull(),
  },
  (table) => [
    index("audit_events_ts_idx").on(table.ts, table.id),
    index("audit_events_event_ts_idx").on(table.event, table.ts, table.id),
    index("audit_events_tool_ts_idx").on(table.tool, table.ts, table.id),
    index("audit_events_connection_ts_idx").on(table.connectionRef, table.ts, table.id),
  ],
);

export const oauthAuthorizationLimits = sqliteTable(
  "oauth_authorization_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    scope: text("scope", { enum: ["session", "client", "ip", "global"] }).notNull(),
    tokens: integer("tokens").notNull(),
    updatedAt: integer("updated_at").notNull(),
    failureStreak: integer("failure_streak").notNull(),
    blockedUntil: integer("blocked_until").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("oauth_authorization_limits_expires_idx").on(table.expiresAt)],
);

export const oauthAuthorizationSelections = sqliteTable(
  "oauth_authorization_selections",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    authorizationSessionKey: text("authorization_session_key").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("oauth_authorization_selections_expires_idx").on(table.expiresAt),
    check(
      "oauth_authorization_selections_expiry_check",
      sql`${table.expiresAt} = ${table.createdAt} + 300000`,
    ),
  ],
);

export const oauthAuthorizationCodes = sqliteTable(
  "oauth_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    grantId: text("grant_id").notNull(),
    principalId: text("principal_id")
      .notNull()
      .references(() => connectionPrincipals.principalId),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scopesJson: text("scopes_json").notNull(),
    resource: text("resource"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.grantId, table.principalId, table.clientId],
      foreignColumns: [oauthGrants.grantId, oauthGrants.principalId, oauthGrants.clientId],
    }).onDelete("cascade"),
    index("oauth_authorization_codes_expires_idx").on(table.expiresAt),
    index("oauth_authorization_codes_client_id_idx").on(table.clientId),
    check(
      "oauth_authorization_codes_expiry_check",
      sql`${table.expiresAt} = ${table.createdAt} + 300000`,
    ),
    check("oauth_authorization_codes_epoch_check", sql`${table.authorizationEpoch} >= 1`),
  ],
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => connectionPrincipals.principalId),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
  (table) => [
    foreignKey({
      columns: [table.grantId, table.principalId, table.clientId],
      foreignColumns: [oauthGrants.grantId, oauthGrants.principalId, oauthGrants.clientId],
    }).onDelete("cascade"),
    index("oauth_access_tokens_grant_id_idx").on(table.grantId),
    index("oauth_access_tokens_client_id_idx").on(table.clientId),
    index("oauth_access_tokens_expires_at_idx").on(table.expiresAt),
    check("oauth_access_tokens_authorization_epoch_check", sql`${table.authorizationEpoch} >= 1`),
  ],
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: text("grant_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => connectionPrincipals.principalId),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    familyId: text("family_id").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
  (table) => [
    foreignKey({
      columns: [table.grantId, table.principalId, table.clientId],
      foreignColumns: [oauthGrants.grantId, oauthGrants.principalId, oauthGrants.clientId],
    }).onDelete("cascade"),
    index("oauth_refresh_tokens_grant_id_idx").on(table.grantId),
    index("oauth_refresh_tokens_client_id_idx").on(table.clientId),
    index("oauth_refresh_tokens_expires_at_idx").on(table.expiresAt),
    index("oauth_refresh_tokens_family_id_idx").on(table.familyId),
    check("oauth_refresh_tokens_authorization_epoch_check", sql`${table.authorizationEpoch} >= 1`),
    check(
      "oauth_refresh_tokens_family_id_check",
      sql`length(${table.familyId}) between 16 and 128`,
    ),
  ],
);

export const oauthRefreshTokenTombstones = sqliteTable(
  "oauth_refresh_token_tombstones",
  {
    tokenHash: text("token_hash").primaryKey(),
    familyId: text("family_id").notNull(),
    grantId: text("grant_id").notNull(),
    clientId: text("client_id").notNull(),
    principalId: text("principal_id").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    consumedAt: integer("consumed_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("oauth_refresh_token_tombstones_family_idx")
      .on(table.familyId, table.expiresAt),
    index("oauth_refresh_token_tombstones_expires_idx").on(table.expiresAt),
    check(
      "oauth_refresh_token_tombstones_family_id_check",
      sql`length(${table.familyId}) between 16 and 128`,
    ),
    check(
      "oauth_refresh_token_tombstones_authorization_epoch_check",
      sql`${table.authorizationEpoch} >= 1`,
    ),
    check(
      "oauth_refresh_token_tombstones_expiry_check",
      sql`${table.expiresAt} > ${table.consumedAt}`,
    ),
  ],
);

export const oauthOwnerCredential = sqliteTable(
  "oauth_owner_credential",
  {
    id: integer("id").primaryKey(),
    salt: text("salt").notNull(),
    verifier: text("verifier").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const oauthRevocationCleanupJobs = sqliteTable(
  "oauth_revocation_cleanup_jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    connectionPrincipalId: text("connection_principal_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    projectExecutionId: text("project_execution_id")
      .references(() => projectExecutions.executionId),
    status: text("status", { enum: ["pending", "claimed", "failed", "completed"] })
      .notNull()
      .default("pending"),
    claimToken: text("claim_token"),
    leaseExpiresAt: text("lease_expires_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("oauth_revocation_cleanup_jobs_principal_workspace_uq")
      .on(table.connectionPrincipalId, table.workspaceId),
    index("oauth_revocation_cleanup_jobs_status_idx")
      .on(table.status, table.leaseExpiresAt, table.createdAt, table.id),
    index("oauth_revocation_cleanup_jobs_completed_idx")
      .on(table.completedAt, table.id)
      .where(sql`${table.status} = 'completed'`),
    uniqueIndex("oauth_revocation_cleanup_jobs_execution_uq")
      .on(table.projectExecutionId)
      .where(sql`${table.projectExecutionId} is not null`),
    check(
      "oauth_revocation_cleanup_jobs_attempts_check",
      sql`${table.attempts} >= 0`,
    ),
    check(
      "oauth_revocation_cleanup_jobs_claim_check",
      sql`(
        ${table.status} = 'claimed'
        and ${table.claimToken} is not null
        and ${table.leaseExpiresAt} is not null
      ) or (
        ${table.status} != 'claimed'
        and ${table.claimToken} is null
        and ${table.leaseExpiresAt} is null
      )`,
    ),
    check(
      "oauth_revocation_cleanup_jobs_completion_check",
      sql`(
        ${table.status} = 'completed'
        and ${table.completedAt} is not null
      ) or (
        ${table.status} != 'completed'
        and ${table.completedAt} is null
      )`,
    ),
  ],
);

export const legacyManagedWorktreeArtifacts = sqliteTable(
  "legacy_managed_worktree_artifacts",
  {
    artifactId: integer("artifact_id").primaryKey({ autoIncrement: true }),
    artifactKind: text("artifact_kind", { enum: ["workspace", "dirty_artifact"] }).notNull(),
    sourceSchemaVersion: integer("source_schema_version").notNull(),
    legacyWorkspaceId: text("legacy_workspace_id").notNull(),
    legacyConnectionPrincipalId: text("legacy_connection_principal_id"),
    legacyAlias: text("legacy_alias"),
    workspaceRoot: text("workspace_root").notNull(),
    canonicalRoot: text("canonical_root"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    dirtySource: text("dirty_source"),
    managed: text("managed"),
    previousStatus: text("previous_status", { enum: ["active", "closed", "revoked"] }),
    writeAccess: text("write_access", { enum: ["read_only", "read_write"] }),
    stateGeneration: integer("state_generation"),
    workspaceCreatedAt: text("workspace_created_at"),
    workspaceLastUsedAt: text("workspace_last_used_at"),
    legacyJobId: integer("legacy_job_id"),
    reason: text("reason"),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    index("legacy_managed_worktree_artifacts_recorded_idx")
      .on(table.recordedAt, table.artifactId),
    index("legacy_managed_worktree_artifacts_workspace_idx")
      .on(table.legacyWorkspaceId, table.artifactKind),
    check(
      "legacy_managed_worktree_artifacts_source_version_check",
      sql`${table.sourceSchemaVersion} >= 0`,
    ),
    check(
      "legacy_managed_worktree_artifacts_state_generation_check",
      sql`${table.stateGeneration} is null or ${table.stateGeneration} >= 1`,
    ),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type MutationOperationRow = typeof mutationOperations.$inferSelect;
export type NewMutationOperationRow = typeof mutationOperations.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type OAuthRevocationCleanupJobRow = typeof oauthRevocationCleanupJobs.$inferSelect;
export type LegacyManagedWorktreeArtifactRow =
  typeof legacyManagedWorktreeArtifacts.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type ProjectHandoffRow = typeof projectHandoffs.$inferSelect;
export type NewProjectHandoffRow = typeof projectHandoffs.$inferInsert;
export type ProjectExecutionRow = typeof projectExecutions.$inferSelect;
export type NewProjectExecutionRow = typeof projectExecutions.$inferInsert;
