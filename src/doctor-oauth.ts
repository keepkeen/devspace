import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ALL_AUTHORIZED_ROOTS_ID } from "./authorization-roots.js";

export interface DoctorOAuthInspection {
  databasePresent: boolean;
  schemaVersion?: number;
  legacyWildcardGrants?: number;
  error?: "unavailable";
}

/**
 * Inspect OAuth grant health without invoking canonical migrations or changing
 * journal mode. `devspace doctor` must remain diagnostic even when the binary
 * is newer than the database used by a running backend.
 */
export function inspectDoctorOAuthState(
  stateDir: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): DoctorOAuthInspection {
  const path = join(stateDir, "devspace.sqlite");
  if (!existsSync(path)) return { databasePresent: false };

  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
    sqlite.pragma("query_only = ON");
    sqlite.pragma("busy_timeout = 1000");

    const schemaVersion = tableExists(sqlite, "devspace_schema_migrations")
      ? (sqlite.prepare(
          "select max(version) as version from devspace_schema_migrations",
        ).get() as { version: number | null }).version ?? 0
      : 0;
    if (!tableExists(sqlite, "oauth_grants")) {
      return { databasePresent: true, schemaVersion, legacyWildcardGrants: 0 };
    }

    const columns = new Set(
      (sqlite.prepare("pragma table_info(oauth_grants)").all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    if (!columns.has("allowed_root_ids_json") || !columns.has("revoked_at")) {
      return { databasePresent: true, schemaVersion, error: "unavailable" };
    }
    const absoluteExpiry = columns.has("absolute_expires_at")
      ? "and (absolute_expires_at is null or absolute_expires_at > @nowSeconds)"
      : "";
    const rows = sqlite.prepare(`
      select allowed_root_ids_json as allowedRootIdsJson
      from oauth_grants
      where revoked_at is null
      ${absoluteExpiry}
    `).all({ nowSeconds }) as Array<{ allowedRootIdsJson: string }>;
    let legacyWildcardGrants = 0;
    for (const row of rows) {
      const value = JSON.parse(row.allowedRootIdsJson) as unknown;
      if (
        Array.isArray(value) &&
        value.some((entry) => entry === ALL_AUTHORIZED_ROOTS_ID)
      ) {
        legacyWildcardGrants += 1;
      }
    }
    return { databasePresent: true, schemaVersion, legacyWildcardGrants };
  } catch {
    return { databasePresent: true, error: "unavailable" };
  } finally {
    sqlite?.close();
  }
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(sqlite.prepare(`
    select 1 from sqlite_master where type = 'table' and name = ?
  `).get(table));
}
