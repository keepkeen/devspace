/** Model-facing shell metadata shared by the MCP tool and server instructions. */

export const BASH_DEFAULT_TIMEOUT_SECONDS = 120;
export const BASH_MAX_TIMEOUT_SECONDS = 600;

export interface BashPromptToolNames {
  openWorkspace: string;
  read: string;
  write: string;
  edit: string;
  grep: string;
  glob: string;
  ls: string;
  shell: string;
  writeStdin: string;
}

export interface BashPromptOptions {
  toolNames: BashPromptToolNames;
  /** When true, dedicated grep/glob/ls tools are registered. */
  hasInspectionTools: boolean;
}

/** Concise description used for tool discovery. */
export function buildBashToolDescription(options: BashPromptOptions): string {
  const { toolNames, hasInspectionTools } = options;
  const inspection = hasInspectionTools
    ? `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection.`
    : `Dedicated search tools are unavailable, so use ${toolNames.shell} with rg, find, ls, or tree for discovery and ${toolNames.read} for direct reads.`;

  return `Use this when a task requires a terminal command, such as a test, build, git operation, package script, or environment check. Each call starts at the workspace root or workingDirectory; ${inspection} Use run_in_background with ${toolNames.writeStdin} for long-running commands.`;
}

/**
 * Compact bash-related fragment for MCP server instructions.
 */
export function buildBashServerInstructions(options: BashPromptOptions): string {
  const { toolNames, hasInspectionTools } = options;
  const inspection = hasInspectionTools
    ? `Prefer ${toolNames.read}, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} for file inspection. `
    : `In minimal tool mode, ${toolNames.grep}, ${toolNames.glob}, and ${toolNames.ls} are disabled; use ${toolNames.shell} with rg, find, ls, and tree for search and directory inspection. Prefer ${toolNames.read} for direct file reads. `;

  return (
    `${inspection}` +
    `Prefer ${toolNames.edit} for targeted modifications and ${toolNames.write} only for new files or complete rewrites. ` +
    `Use ${toolNames.shell} for tests, builds, git, package scripts, and other commands that belong in a terminal. ` +
    `Each ${toolNames.shell} call starts at the workspace root unless workingDirectory is set; cwd and shell state do not persist. ` +
    `Default ${toolNames.shell} timeout is ${BASH_DEFAULT_TIMEOUT_SECONDS}s (max ${BASH_MAX_TIMEOUT_SECONDS}s). ` +
    `For long-running processes set run_in_background and poll with ${toolNames.writeStdin}. ` +
    `Do not create or modify project source files via shell redirection, sed -i, or generated scripts; HEREDOC is allowed for git/gh message bodies only. ` +
    `A small set of dangerous commands (rm -f, sudo, pipe-to-shell) is blocked.`
  );
}

export const BASH_DESCRIPTION_PARAM =
  "Optional 5–10 word active-voice summary of the command.";

export const BASH_WORKING_DIRECTORY_PARAM =
  "Working directory relative to the workspace root. Defaults to the workspace root and does not persist across calls.";

export function buildWorkspaceLifecycleInstruction(options: {
  openWorkspace: string;
  closeWorkspace: string;
}): string {
  const { openWorkspace, closeWorkspace } = options;
  return `Use DevSpace tools whenever a request requires reading or changing files, searching code, or running commands in a project on the user's local machine. If the current conversation does not already have a workspaceId for the requested local project, call ${openWorkspace} with the exact project path; do not probe the path through a host sandbox or code interpreter because it is a different filesystem. The server reuses an active checkout workspace for the same authorized client and canonical path when available. Reuse the returned workspaceId on every later DevSpace call in the conversation. Call ${openWorkspace} again only when switching folders/worktrees or checkout/worktree mode, or when the current ID is unknown. Call ${closeWorkspace} only after the user explicitly asks to close or release that workspace; never call it automatically at the end of a turn, task, or conversation. Host tools, including code interpreters, remain appropriate for work unrelated to the local workspace.`;
}

/**
 * Codex-mode MCP server instructions.
 *
 * ChatGPT already knows Codex-style exec_command / write_stdin / apply_patch.
 * Only state DevSpace differences that cause wrong tool calls (naming, workspace
 * lifecycle, missing Codex params, local command policy).
 */
export function buildCodexServerInstructions(options: {
  read: string;
  batchRead: string;
  batchInspect: string;
  writeStdin: string;
}): string {
  const { read, batchRead, batchInspect, writeStdin } = options;
  return [
    `Tools: ${read} for one known file, ${batchRead} for 2–8 known files, ${batchInspect} for 2–8 known searches/listings, apply_patch for file changes, exec_command for shell, ${writeStdin} to poll/interact with running processes.`,
    `When multiple targets are already known, prefer ${batchRead} or ${batchInspect} over repeated single calls. Keep iterative discovery when the next target depends on the previous result; do not pad a batch with speculative work.`,
    "Field names differ from stock Codex: workingDirectory (not workdir), yieldTimeMs (not yield_time_ms), maxOutputTokens (not max_output_tokens), sessionId (not session_id). Always pass workspaceId.",
    "cwd does not persist across exec_command calls; each call starts at the workspace root unless workingDirectory is set. Do not rely on cd across calls.",
    "Do not pass sandbox_permissions, additional_permissions, prefix_rule, justification, shell, or login — they are not supported.",
    "Command policy blocks rm -f, sudo, and pipe-to-shell. Prefer apply_patch for file edits; ask the user before destructive actions.",
    "Follow instructions returned by open_workspace and later tools; nested project instructions are loaded lazily when a tool enters their scope. Read applicable skill files before working in their scope.",
    "If a mutation or command is blocked with an instructionToken, review the returned scoped instructions and pass that exact token when retrying the same tool call.",
  ].join(" ");
}
