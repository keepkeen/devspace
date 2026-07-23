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
  readProcessOutput: string;
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
    ? `Prefer ${toolNames.read}/${toolNames.grep}/${toolNames.glob}/${toolNames.ls} for inspection.`
    : `Use ${toolNames.shell} with rg/find/ls for discovery and ${toolNames.read} for reads.`;

  return `Run terminal commands at workspace root or workingDirectory. ${inspection} Long jobs: run_in_background + ${toolNames.writeStdin}.`;
}

/**
 * Compact bash-related fragment for MCP server instructions.
 */
export function buildBashServerInstructions(options: BashPromptOptions): string {
  const { toolNames, hasInspectionTools } = options;
  const inspection = hasInspectionTools
    ? `Inspect with ${toolNames.read}/${toolNames.grep}/${toolNames.glob}/${toolNames.ls}. `
    : `Inspect with ${toolNames.read}, or ${toolNames.shell} plus rg/find/ls. `;

  return (
    `${inspection}` +
    `Use ${toolNames.edit} for targeted edits, ${toolNames.write} for new/full files, and ${toolNames.shell} for terminal work. ` +
    `${toolNames.shell} starts at workspace root unless workingDirectory is set; cwd/shell state do not persist. Timeout ${BASH_DEFAULT_TIMEOUT_SECONDS}s, max ${BASH_MAX_TIMEOUT_SECONDS}s. ` +
    `Send multiline Python, SQL, or SSH payloads with stdin; it closes by default. ` +
    `For long jobs use run_in_background + ${toolNames.writeStdin}; page outputId with ${toolNames.readProcessOutput}. ` +
    `If a process session is unknown, stop polling it and rerun the command; inspect any outputId first. Normal workspace shell writes are allowed; privilege escalation, forced/recursive deletion, and pipe-to-shell are blocked.`
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
  return `For local-project work use DevSpace, not hosted Python. Call ${openWorkspace} with the exact path once and reuse its workspaceId. If the MCP session is rejected, reconnect and retry once. If workspaceId is unknown, discard it, reopen the original exact path, replace the ID, and retry once. Never call ${closeWorkspace} unless the user asks to release the workspace.`;
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
  loadSkill?: string;
  readProcessOutput: string;
  writeStdin: string;
}): string {
  const { read, batchRead, batchInspect, loadSkill, readProcessOutput, writeStdin } = options;
  return [
    `Follow open_workspace agentsFiles; nested instructions arrive on first access. If instructionToken is returned, review and retry with it.${loadSkill ? ` Load matching skills with ${loadSkill}; explicit-only skills require the user's request.` : ""}`,
    `Use ${read} for one file, ${batchRead}/${batchInspect} for 2–8 independent targets, apply_patch for edits, and exec_command for shell work; keep dependent discovery iterative.`,
    "Fields: workingDirectory, stdin, closeStdin, yieldTimeMs, maxOutputTokens, sessionId. Use stdin for multiline Python, SQL, or SSH payloads; it closes by default. PTY input requires closeStdin=false. Omit Codex sandbox, approval, shell, and login fields. Commands start at workspace root; cwd does not persist.",
    `Poll with ${writeStdin}; page outputId with ${readProcessOutput}. Unknown process session: stop polling, inspect outputId, then rerun. Workspace shell writes are allowed; dangerous commands stay blocked.`,
    ...(loadSkill ? [`After backend restart or workspace recovery, reload ${loadSkill} before support files.`] : []),
  ].join(" ");
}
