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
  "Use DevSpace, not hosted Python. Call open_workspace with the exact path once; reuse workspaceId " +
    "across turns/transports. If unknown, reopen that exact path, replace ID, retry once. " +
    "Use close_workspace only when asked.",
);
assert.match(lifecycle, /not hosted Python/);
assert.match(lifecycle, /Call open_workspace with the exact path once/);
assert.match(lifecycle, /reuse workspaceId across turns\/transports/);
assert.match(lifecycle, /If unknown/);
assert.match(lifecycle, /replace ID/);
assert.match(lifecycle, /Use close_workspace only when asked/);
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
assert.match(fixedSurface, /Follow all returned instructions/);
assert.match(
  fixedSurface,
  /Read\/open instructions need no retry/,
);
assert.match(
  fixedSurface,
  /If a blocked mutation\/command returns instructionToken, review returned instructions and retry with it/,
);
assert.doesNotMatch(fixedSurface, /instructions[^.]*retry with (?:the )?(?:returned )?instructionToken/i);
assert.match(fixedSurface, /Batch 2–8 independent known targets/);
assert.match(fixedSurface, /Call load_skill\(workspaceId,skillId\)/);
assert.match(fixedSurface, /process sessionId\/write_stdin, not MCP session/);
assert.match(fixedSurface, /page outputId with read_process_output/);
assert.match(
  fixedSurface,
  /If process sessionId is unknown, stop polling, read prior outputId, verify effects before rerun/,
);
assert.match(fixedSurface, /Keep writes[/]temp files in workspace/);
assert.match(fixedSurface, /use stdout[/]outputId for long output/);
assert.match(fixedSurface, /Never inspect DevSpace internal state/);
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
  Buffer.byteLength(worstCaseInitialize, "utf8") < 950,
  `worst-case initialize instructions must be under 950 bytes; got ${Buffer.byteLength(worstCaseInitialize, "utf8")}`,
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
