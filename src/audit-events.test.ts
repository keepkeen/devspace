import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuditEventStore } from "./audit-events.js";

test("persistent audit events are queryable, bounded, and omit unsafe fields", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devspace-audit-events-"));
  const store = new AuditEventStore(stateDir, 1_000, 2);
  try {
    store.record({
      ts: "2026-01-01T00:00:00.000Z",
      level: "error",
      event: "mcp_tool_error",
      requestId: "request-1",
      tool: "grep",
      connectionRef: "conn_abc",
      workspaceActivityRef: "act_xyz",
      errorCode: "invalid_pattern",
      errorName: "InvalidSearchPatternError",
      errorFingerprint: "fingerprint-1",
      durationMs: 12,
      phase: "not_started",
      path: "/Users/private/project",
      command: "cat /Users/private/token",
      errorStack: "secret stack",
      token: "secret-token",
    });
    store.record({
      ts: "2026-01-01T00:00:01.000Z",
      level: "info",
      event: "tool_call",
      requestId: "request-2",
      tool: "read",
      connectionRef: "conn_abc",
      success: true,
      tokensPreserved: true,
      clientsPreserved: true,
    });

    const failures = store.query({ event: "mcp_tool_error", connectionRef: "conn_abc" });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.tool, "grep");
    assert.equal(failures[0]?.errorCode, "invalid_pattern");
    assert.deepEqual(failures[0]?.details, { durationMs: 12, phase: "not_started" });
    const successes = store.query({ event: "tool_call", connectionRef: "conn_abc" });
    assert.deepEqual(successes[0]?.details, {
      clientsPreserved: true,
      success: true,
      tokensPreserved: true,
    });
    const serialized = JSON.stringify(failures);
    assert.doesNotMatch(serialized, /Users|secret|command|errorStack|token/u);

    store.record({
      ts: "2026-01-01T00:00:02.000Z",
      level: "warn",
      event: "third",
    });
    assert.equal(store.cleanup(Date.parse("2026-01-01T00:00:01.500Z")), 1);
    assert.equal(store.query({ limit: 10 }).length, 2);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
