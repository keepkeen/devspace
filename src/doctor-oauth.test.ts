import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { inspectDoctorOAuthState } from "./doctor-oauth.js";

test("doctor OAuth inspection is read-only across legacy and current schemas", () => {
  const root = mkdtempSync(join(tmpdir(), "devspace-doctor-oauth-"));
  try {
    assert.deepEqual(inspectDoctorOAuthState(join(root, "missing")), {
      databasePresent: false,
    });

    const legacyState = join(root, "legacy");
    mkdirSync(legacyState);
    const legacyPath = join(legacyState, "devspace.sqlite");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values
        (16, 'canonical-state-v16', '2026-07-26T00:00:00.000Z');
      create table oauth_grants (
        grant_id text primary key,
        allowed_root_ids_json text not null,
        revoked_at text
      );
      insert into oauth_grants values
        ('wildcard-active', '["*"]', null),
        ('explicit-active', '["root-a"]', null),
        ('wildcard-revoked', '["*"]', '2026-07-26T00:00:00.000Z');
    `);
    legacy.close();
    const legacyEntriesBefore = readdirSync(legacyState).sort();
    const legacyMtimeBefore = statSync(legacyPath, { bigint: true }).mtimeNs;
    assert.deepEqual(inspectDoctorOAuthState(legacyState, 100), {
      databasePresent: true,
      schemaVersion: 16,
      legacyWildcardGrants: 1,
    });
    assert.deepEqual(readdirSync(legacyState).sort(), legacyEntriesBefore);
    assert.equal(statSync(legacyPath, { bigint: true }).mtimeNs, legacyMtimeBefore);

    const currentState = join(root, "current");
    mkdirSync(currentState);
    const current = new Database(join(currentState, "devspace.sqlite"));
    current.exec(`
      create table devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into devspace_schema_migrations values
        (17, 'canonical-state-v17', '2026-07-26T00:00:00.000Z');
      create table oauth_grants (
        grant_id text primary key,
        allowed_root_ids_json text not null,
        absolute_expires_at integer,
        revoked_at text
      );
      insert into oauth_grants values
        ('wildcard-active', '["*"]', 200, null),
        ('wildcard-expired', '["*"]', 50, null),
        ('explicit-active', '["root-a"]', null, null);
    `);
    current.close();
    assert.deepEqual(inspectDoctorOAuthState(currentState, 100), {
      databasePresent: true,
      schemaVersion: 17,
      legacyWildcardGrants: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor OAuth inspection reports malformed grant data without mutating it", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-doctor-oauth-malformed-"));
  try {
    const path = join(stateDir, "devspace.sqlite");
    const sqlite = new Database(path);
    sqlite.exec(`
      create table oauth_grants (
        grant_id text primary key,
        allowed_root_ids_json text not null,
        revoked_at text
      );
      insert into oauth_grants values ('malformed', '{', null);
    `);
    sqlite.close();
    const mtimeBefore = statSync(path, { bigint: true }).mtimeNs;
    assert.deepEqual(inspectDoctorOAuthState(stateDir), {
      databasePresent: true,
      error: "unavailable",
    });
    assert.equal(statSync(path, { bigint: true }).mtimeNs, mtimeBefore);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
