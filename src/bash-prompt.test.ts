import assert from "node:assert/strict";
import {
  buildCodexServerInstructions,
  buildWorkspaceLifecycleInstruction,
} from "./bash-prompt.js";

const lifecycle = buildWorkspaceLifecycleInstruction({
  openWorkspace: "open_workspace",
  closeWorkspace: "close_workspace",
});
assert.equal(
  lifecycle,
  "Use DevSpace, not hosted Python. Call open_workspace once for the exact path; reuse workspaceId " +
    "across turns/transports. On unknown_workspace, reopen the path, replace ID, retry once. " +
    "close_workspace only when asked.",
);
assert.match(lifecycle, /not hosted Python/);
assert.match(lifecycle, /Call open_workspace once for the exact path/);
assert.match(lifecycle, /reuse workspaceId across turns\/transports/);
assert.match(lifecycle, /On unknown_workspace/);
assert.match(lifecycle, /replace ID/);
assert.match(lifecycle, /close_workspace only when asked/);
assert.doesNotMatch(lifecycle, /reconnect|MCP session is rejected/);
assert.ok(lifecycle.length < 300);

// Fixed surface: only DevSpace-specific deltas, not a shell tutorial.
const fixedSurface = buildCodexServerInstructions({
  read: "read",
  batchRead: "batch_read",
  batchInspect: "batch_inspect",
  loadSkill: "load_skill",
  readProcessOutput: "read_process_output",
  writeStdin: "write_stdin",
});
assert.match(fixedSurface, /Follow returned instructions/);
assert.match(
  fixedSurface,
  /Read\/open needs no retry/,
);
assert.match(
  fixedSurface,
  /On blocked mutation\/command, review instructions and retry with instructionToken/,
);
assert.match(fixedSurface, /Batch 2–8 independent known targets/);
assert.match(fixedSurface, /Call load_skill\(workspaceId,skillId\)/);
assert.match(fixedSurface, /sessionId\/write_stdin/);
assert.match(fixedSurface, /page outputId\/read_process_output/);
assert.match(
  fixedSurface,
  /On unknown process, stop polling, read outputId if known, verify effects before rerun/,
);
assert.match(fixedSurface, /Keep writes[/]temp in workspace/);
assert.match(fixedSurface, /use stdout[/]outputId/);
assert.match(fixedSurface, /Never inspect DevSpace state/);
assert.match(fixedSurface, /Checks are guardrails, not a sandbox/);
assert.ok(fixedSurface.length < 800);
assert.doesNotMatch(fixedSurface, /dangerous commands (?:remain|stay) blocked|all dangerous commands/i);
assert.doesNotMatch(fixedSurface, /once per project folder|including across turns/);
assert.doesNotMatch(fixedSurface, /run_in_background|\bbash\b/i);
assert.doesNotMatch(fixedSurface, /HEREDOC/);

const worstCaseInitialize =
  `${lifecycle} ${fixedSurface}` +
  " After the final file change, call show_changes once before replying; not after each edit.";
assert.ok(
  Buffer.byteLength(worstCaseInitialize, "utf8") < 850,
  `worst-case initialize instructions must be under 850 bytes; got ${Buffer.byteLength(worstCaseInitialize, "utf8")}`,
);

const codexWithoutSkills = buildCodexServerInstructions({
  read: "read",
  batchRead: "batch_read",
  batchInspect: "batch_inspect",
  readProcessOutput: "read_process_output",
  writeStdin: "write_stdin",
});
assert.doesNotMatch(codexWithoutSkills, /load_skill|reload skill|explicit-only/);

console.log("MCP prompt tests passed");
