import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { getTableConfig, type AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { createCanonicalSchema } from "./canonical-schema.js";
import {
  applyPatchChanges,
  oauthRefreshTokens,
  oauthRefreshTokenTombstones,
  projectHandoffs,
  projectExecutions,
  workspaceSessions,
} from "./schema.js";

const sqlite = new Database(":memory:");
try {
  createCanonicalSchema(sqlite);
  assertCanonicalTableParity("oauth_refresh_tokens", oauthRefreshTokens);
  assertCanonicalTableParity(
    "oauth_refresh_token_tombstones",
    oauthRefreshTokenTombstones,
  );
  assertCanonicalTableParity("workspace_sessions", workspaceSessions);
  assertCanonicalTableParity("project_handoffs", projectHandoffs);
  assertCanonicalTableParity("project_executions", projectExecutions);
  assertCanonicalTableParity("apply_patch_changes", applyPatchChanges);

  const refreshTokens = getTableConfig(oauthRefreshTokens);
  assert.equal(
    refreshTokens.columns.find((column) => column.name === "family_id")?.notNull,
    true,
  );
  assert.ok(
    refreshTokens.checks.some((entry) =>
      entry.name === "oauth_refresh_tokens_family_id_check"
    ),
  );

  const tombstones = getTableConfig(oauthRefreshTokenTombstones);
  assert.deepEqual(
    new Set(tombstones.checks.map((entry) => entry.name)),
    new Set([
      "oauth_refresh_token_tombstones_family_id_check",
      "oauth_refresh_token_tombstones_authorization_epoch_check",
      "oauth_refresh_token_tombstones_expiry_check",
    ]),
  );
  const executions = getTableConfig(projectExecutions);
  assert.ok(
    executions.checks.some((entry) =>
      entry.name === "project_executions_handoff_retired_link_check"
    ),
  );
} finally {
  sqlite.close();
}

function assertCanonicalTableParity(
  tableName:
    | "oauth_refresh_tokens"
    | "oauth_refresh_token_tombstones"
    | "workspace_sessions"
    | "project_handoffs"
    | "project_executions"
    | "apply_patch_changes",
  table: AnySQLiteTable,
): void {
  const drizzle = getTableConfig(table);
  const canonicalColumns = sqlite.prepare(
    `select name from pragma_table_info('${tableName}') order by cid`,
  ).pluck().all() as string[];
  const canonicalIndexes = sqlite.prepare(`
    select name
    from pragma_index_list('${tableName}')
    where origin = 'c'
    order by name
  `).pluck().all() as string[];
  assert.deepEqual(
    drizzle.columns.map((column) => column.name),
    canonicalColumns,
  );
  assert.deepEqual(
    drizzle.indexes.map((entry) => entry.config.name).sort(),
    canonicalIndexes,
  );
}
