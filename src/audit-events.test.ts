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
      ts: "2026-01-01T00:00:00.500Z",
      level: "warn",
      event: "command_execution_terminal",
      tool: "exec_command",
      connectionRef: "conn_abc",
      workspaceActivityRef: "act_xyz",
      success: false,
      commandMode: "program",
      outcome: "timed_out",
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      durationMs: 250,
      command: "devspace-audit-canary-7f1c2e --secret",
      args: ["--secret"],
      environment: { TOKEN: "devspace-audit-canary-7f1c2e" },
      stdin: "devspace-audit-canary-7f1c2e",
      stdout: "devspace-audit-canary-7f1c2e",
      stderr: "devspace-audit-canary-7f1c2e",
      cwd: "/Users/private/devspace-audit-canary-7f1c2e",
      sessionId: 123,
      outputId: "devspace-audit-canary-7f1c2e",
      operationId: "devspace-audit-canary-7f1c2e",
      token: "devspace-audit-canary-7f1c2e",
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

    assert.deepEqual(store.health(), {
      eventCount: 3,
      firstEventAt: "2026-01-01T00:00:00.000Z",
      lastEventAt: "2026-01-01T00:00:01.000Z",
    });

    const failures = store.query({ event: "mcp_tool_error", connectionRef: "conn_abc" });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.tool, "grep");
    assert.equal(failures[0]?.errorCode, "invalid_pattern");
    assert.deepEqual(failures[0]?.details, { durationMs: 12, phase: "not_started" });
    const terminals = store.query({ event: "command_execution_terminal", connectionRef: "conn_abc" });
    assert.deepEqual(terminals[0]?.details, {
      commandMode: "program",
      durationMs: 250,
      exitCode: 143,
      outcome: "timed_out",
      signal: "SIGTERM",
      success: false,
      timedOut: true,
    });
    const successes = store.query({ event: "tool_call", connectionRef: "conn_abc" });
    assert.deepEqual(successes[0]?.details, {
      clientsPreserved: true,
      success: true,
      tokensPreserved: true,
    });
    const serialized = JSON.stringify([...failures, ...terminals]);
    assert.doesNotMatch(serialized, /Users|secret|errorStack|token|7f1c2e|sessionId|outputId|operationId/u);

    store.record({
      ts: "2026-01-01T00:00:02.000Z",
      level: "warn",
      event: "third",
    });
    assert.equal(store.cleanup(Date.parse("2026-01-01T00:00:01.500Z")), 2);
    assert.equal(store.query({ limit: 10 }).length, 2);
  } finally {
    store.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
