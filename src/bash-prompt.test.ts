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
};

const fullDescription = buildBashToolDescription({
  toolNames,
  hasInspectionTools: true,
});
assert.match(fullDescription, /^Use this when/);
assert.match(fullDescription, /Prefer read, grep, glob, and ls/);
assert.match(fullDescription, /run_in_background/);
assert.ok(fullDescription.length < 500);
assert.doesNotMatch(fullDescription, /Call open_workspace/);
assert.doesNotMatch(fullDescription, /git commit|HEREDOC/);

const minimalDescription = buildBashToolDescription({
  toolNames,
  hasInspectionTools: false,
});
assert.match(minimalDescription, /rg, find, ls, or tree/);
assert.match(minimalDescription, /read for direct reads/);

const instructions = buildBashServerInstructions({
  toolNames,
  hasInspectionTools: true,
});
assert.match(instructions, /do not persist/);
assert.match(instructions, /write_stdin/);
assert.match(instructions, /rm -f/);
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
assert.match(lifecycle, /project on the user's local machine/);
assert.match(lifecycle, /call open_workspace with the exact project path/);
assert.match(lifecycle, /do not probe the path through a host sandbox or code interpreter/);
assert.match(lifecycle, /reuses an active checkout workspace/);
assert.match(lifecycle, /only after the user explicitly asks/);
assert.match(lifecycle, /never call it automatically at the end of a turn, task, or conversation/);
assert.doesNotMatch(lifecycle, /definitely no longer needed/);
assert.match(lifecycle, /code interpreters, remain appropriate for work unrelated/);

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
  writeStdin: "write_stdin",
});
assert.match(codex, /batch_read for 2–8 known files/);
assert.match(codex, /prefer batch_read or batch_inspect/);
assert.match(codex, /iterative discovery/);
assert.match(codex, /loaded lazily/);
assert.match(codex, /instructionToken/);
assert.match(codex, /workingDirectory \(not workdir\)/);
assert.match(codex, /yieldTimeMs \(not yield_time_ms\)/);
assert.match(codex, /sessionId \(not session_id\)/);
assert.match(codex, /workspaceId/);
assert.match(codex, /does not persist/);
assert.match(codex, /sandbox_permissions/);
assert.match(codex, /rm -f/);
assert.doesNotMatch(codex, /once per project folder|including across turns/);
assert.doesNotMatch(codex, /run_in_background/);
assert.doesNotMatch(codex, /HEREDOC/);

console.log("bash-prompt tests passed");
