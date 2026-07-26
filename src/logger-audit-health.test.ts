import assert from "node:assert/strict";
import test from "node:test";
import {
  auditWriteHealthSnapshot,
  createAuditWriteHealth,
  logEvent,
  type LoggingConfig,
} from "./logger.js";

test("audit sink failures are counted without changing the logged operation", () => {
  const health = createAuditWriteHealth();
  const config: LoggingConfig = {
    level: "silent",
    format: "json",
    requests: false,
    assets: false,
    toolCalls: false,
    shellCommands: false,
    trustProxy: false,
    auditWriteHealth: health,
    auditSink: () => {
      throw new Error("simulated SQLite busy");
    },
  };
  assert.doesNotThrow(() => logEvent(config, "info", "test_event"));
  const failed = auditWriteHealthSnapshot(health);
  assert.equal(failed.auditWriteFailures, 1);
  assert.match(failed.lastAuditWriteFailureAt ?? "", /^\d{4}-\d{2}-\d{2}T/u);

  config.auditSink = () => undefined;
  logEvent(config, "info", "second_event");
  assert.equal(auditWriteHealthSnapshot(health).auditWriteFailures, 1);
});
