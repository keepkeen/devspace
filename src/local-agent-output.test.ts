import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLocalAgentOutput,
  removeLocalAgentOutputSync,
  writeLocalAgentOutput,
} from "./local-agent-output.js";
import { MAX_LOCAL_AGENT_RESPONSE_BYTES } from "./local-agent-limits.js";

const root = mkdtempSync(join(tmpdir(), "devspace-agent-output-test-"));
try {
  const id = "agt_12345678";
  assert.equal(writeLocalAgentOutput(root, id, "short"), false);
  assert.equal(readLocalAgentOutput(root, id), undefined);

  const full = `begin\n${"中".repeat(MAX_LOCAL_AGENT_RESPONSE_BYTES)}\nend`;
  assert.equal(writeLocalAgentOutput(root, id, full), true);
  assert.equal(readLocalAgentOutput(root, id), full);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(join(root, "local-agent-output")).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(root, "local-agent-output", `${id}.txt`)).mode & 0o777, 0o600);
  }

  removeLocalAgentOutputSync(root, id);
  assert.equal(readLocalAgentOutput(root, id), undefined);
  assert.throws(() => writeLocalAgentOutput(root, "../bad", full), /Invalid local-agent id/u);
} finally {
  rmSync(root, { recursive: true, force: true });
}
