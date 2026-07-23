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
    ownerClientId: text("owner_client_id").notNull().default("__legacy_unowned__"),
    alias: text("alias"),
    root: text("root").notNull(),
    canonicalRoot: text("canonical_root"),
    status: text("status", { enum: ["active", "closed", "revoked"] })
      .notNull()
      .default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    dirtySource: text("dirty_source").notNull().default("false"),
    managed: text("managed").notNull().default("false"),
    writeAccess: text("write_access", { enum: ["read_only", "read_write"] })
      .notNull()
      .default("read_write"),
    stateGeneration: integer("state_generation").notNull().default(1),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
    index("workspace_sessions_owner_status_idx").on(table.ownerClientId, table.status, table.lastUsedAt),
    uniqueIndex("workspace_sessions_id_owner_uq").on(table.id, table.ownerClientId),
    uniqueIndex("workspace_sessions_owner_alias_uq")
      .on(table.ownerClientId, table.alias)
      .where(sql`${table.alias} is not null`),
    uniqueIndex("workspace_sessions_active_checkout_owner_canonical_root_uq")
      .on(table.ownerClientId, table.canonicalRoot)
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
    ownerClientId: text("owner_client_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    tool: text("tool").notNull(),
    operationId: text("operation_id").notNull(),
    workspaceGeneration: integer("workspace_generation").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state", { enum: ["pending", "settled", "outcome_unknown"] }).notNull(),
    resultJson: text("result_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerClientId, table.operationId],
    }),
    foreignKey({
      columns: [table.workspaceId, table.ownerClientId],
      foreignColumns: [workspaceSessions.id, workspaceSessions.ownerClientId],
    }).onDelete("cascade"),
    index("mutation_operations_expires_at_idx").on(table.expiresAt),
    check(
      "mutation_operations_state_check",
      sql`${table.state} in ('pending', 'settled', 'outcome_unknown')`,
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
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
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
