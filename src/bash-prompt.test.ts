import assert from "node:assert/strict";
import {
  BASH_DEFAULT_TIMEOUT_SECONDS,
  BASH_MAX_TIMEOUT_SECONDS,
  BASH_DESCRIPTION_PARAM,
  BASH_WORKING_DIRECTORY_PARAM,
  buildBashServerInstructions,
  buildBashToolDescription,
  buildCodexServerInstructions,
  buildWorkspaceLifecycleInstruction,
} from "./bash-prompt.js";
import { resolveBashTimeoutSeconds } from "./bash-tool.js";

const toolNames = {
  openWorkspace: "open_workspace",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  shell: "bash",
  writeStdin: "write_stdin",
  readProcessOutput: "read_process_output",
};

const fullDescription = buildBashToolDescription({
  toolNames,
  hasInspectionTools: true,
});
assert.match(fullDescription, /^Run terminal commands/);
assert.match(fullDescription, /Prefer read\/grep\/glob\/ls/);
assert.match(fullDescription, /run_in_background/);
assert.ok(fullDescription.length < 500);
assert.doesNotMatch(fullDescription, /Call open_workspace/);
assert.doesNotMatch(fullDescription, /git commit|HEREDOC/);

const minimalDescription = buildBashToolDescription({
  toolNames,
  hasInspectionTools: false,
});
assert.match(minimalDescription, /rg\/find\/ls/);
assert.match(minimalDescription, /read for reads/);

const instructions = buildBashServerInstructions({
  toolNames,
  hasInspectionTools: true,
});
assert.match(instructions, /do not persist/);
assert.match(instructions, /write_stdin/);
assert.match(instructions, /Normal workspace shell writes are allowed/);
assert.match(instructions, /unknown, stop polling/);
assert.match(instructions, new RegExp(String(BASH_DEFAULT_TIMEOUT_SECONDS)));

assert.equal(
  BASH_DESCRIPTION_PARAM,
  "Optional 5–10 word active-voice summary of the command.",
);
assert.match(BASH_WORKING_DIRECTORY_PARAM, /Defaults to the workspace root/);
assert.match(BASH_WORKING_DIRECTORY_PARAM, /does not persist/);

const lifecycle = buildWorkspaceLifecycleInstruction({
  openWorkspace: "open_workspace",
  closeWorkspace: "close_workspace",
});
assert.match(lifecycle, /For local-project work use DevSpace/);
assert.match(lifecycle, /not hosted Python/);
assert.match(lifecycle, /Call open_workspace with the exact path once/);
assert.match(lifecycle, /MCP session is rejected, reconnect and retry once/);
assert.match(lifecycle, /workspaceId is unknown/);
assert.match(lifecycle, /replace the ID/);
assert.match(lifecycle, /Never call close_workspace unless the user asks/);
assert.ok(lifecycle.length < 500);

assert.equal(resolveBashTimeoutSeconds(undefined), BASH_DEFAULT_TIMEOUT_SECONDS);
assert.equal(resolveBashTimeoutSeconds(30), 30);
assert.equal(resolveBashTimeoutSeconds(9_999), BASH_MAX_TIMEOUT_SECONDS);
assert.throws(() => resolveBashTimeoutSeconds(0), /positive/);
assert.throws(() => resolveBashTimeoutSeconds(-1), /positive/);

// Codex mode: only DevSpace-unknown deltas, not a full bash tutorial.
const codex = buildCodexServerInstructions({
  read: "read",
  batchRead: "batch_read",
  batchInspect: "batch_inspect",
  loadSkill: "load_skill",
  readProcessOutput: "read_process_output",
  writeStdin: "write_stdin",
});
assert.match(codex, /batch_read\/batch_inspect for 2–8 independent targets/);
assert.match(codex, /dependent discovery iterative/);
assert.match(codex, /nested instructions arrive on first access/);
assert.match(codex, /load_skill/);
assert.match(codex, /read_process_output/);
assert.match(codex, /page outputId/);
assert.match(codex, /instructionToken/);
assert.match(codex, /workingDirectory, stdin, closeStdin, yieldTimeMs, maxOutputTokens, sessionId/);
assert.match(codex, /multiline Python, SQL, or SSH payloads/);
assert.match(codex, /PTY input requires closeStdin=false/);
assert.match(codex, /does not persist/);
assert.match(codex, /sandbox, approval, shell, and login fields/);
assert.match(codex, /dangerous commands stay blocked/);
assert.match(codex, /Unknown process session: stop polling/);
assert.match(codex, /After backend restart or workspace recovery/);
assert.ok(codex.length < 1_000);
assert.doesNotMatch(codex, /once per project folder|including across turns/);
assert.doesNotMatch(codex, /run_in_background/);
assert.doesNotMatch(codex, /HEREDOC/);

const codexWithoutSkills = buildCodexServerInstructions({
  read: "read",
  batchRead: "batch_read",
  batchInspect: "batch_inspect",
  readProcessOutput: "read_process_output",
  writeStdin: "write_stdin",
});
assert.doesNotMatch(codexWithoutSkills, /load_skill|matching skill|explicit-only/);

console.log("bash-prompt tests passed");
