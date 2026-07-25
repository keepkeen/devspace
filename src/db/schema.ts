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
    mode: text("mode").notNull(),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    dirtySource: text("dirty_source").notNull(),
    managed: text("managed").notNull(),
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
    uniqueIndex("workspace_sessions_active_checkout_principal_canonical_root_uq")
      .on(table.connectionPrincipalId, table.canonicalRoot)
      .where(sql`${table.canonicalRoot} is not null and ${table.mode} = 'checkout' and ${table.status} = 'active'`),
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
      columns: [table.connectionPrincipalId, table.operationId],
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
  (table) => [index("connection_principals_last_used_idx").on(table.lastUsedAt)],
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
    subjectHash: text("subject_hash"),
    organizationHash: text("organization_hash"),
    grantedScopesJson: text("granted_scopes_json").notNull(),
    allowedRootIdsJson: text("allowed_root_ids_json").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    uniqueIndex("oauth_grants_identity_uq")
      .on(table.grantId, table.principalId, table.clientId),
    index("oauth_grants_client_id_idx").on(table.clientId, table.lastUsedAt),
    index("oauth_grants_principal_id_idx").on(table.principalId, table.lastUsedAt),
    index("oauth_grants_subject_hash_idx").on(table.subjectHash),
    check("oauth_grants_authorization_epoch_check", sql`${table.authorizationEpoch} >= 1`),
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

export const oauthPrincipalReconnectCodes = sqliteTable(
  "oauth_principal_reconnect_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => connectionPrincipals.principalId, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("oauth_principal_reconnect_codes_principal_idx").on(table.principalId),
    index("oauth_principal_reconnect_codes_expires_idx").on(table.expiresAt),
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
    check("oauth_refresh_tokens_authorization_epoch_check", sql`${table.authorizationEpoch} >= 1`),
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
    workspaceMode: text("workspace_mode", { enum: ["checkout", "worktree"] }).notNull(),
    sourceRoot: text("source_root"),
    managed: text("managed").notNull(),
    dirtySource: text("dirty_source").notNull(),
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
  ],
);

export const oauthRevocationDirtyWorktreeArtifacts = sqliteTable(
  "oauth_revocation_dirty_worktree_artifacts",
  {
    jobId: integer("job_id").primaryKey(),
    connectionPrincipalId: text("connection_principal_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceRoot: text("workspace_root").notNull(),
    sourceRoot: text("source_root"),
    reason: text("reason").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    index("oauth_revocation_dirty_worktree_artifacts_recorded_idx")
      .on(table.recordedAt, table.jobId),
  ],
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type MutationOperationRow = typeof mutationOperations.$inferSelect;
export type NewMutationOperationRow = typeof mutationOperations.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type OAuthRevocationCleanupJobRow = typeof oauthRevocationCleanupJobs.$inferSelect;
export type OAuthRevocationDirtyWorktreeArtifactRow =
  typeof oauthRevocationDirtyWorktreeArtifacts.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
