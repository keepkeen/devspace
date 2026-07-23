/** Compact model-facing instructions for the fixed DevSpace tool surface. */

export function buildWorkspaceLifecycleInstruction(options: {
  openWorkspace: string;
  closeWorkspace: string;
}): string {
  const { openWorkspace, closeWorkspace } = options;
  return `Use DevSpace, not hosted Python. Call ${openWorkspace} once for the exact path; reuse workspaceId across turns/transports. On unknown_workspace, reopen the path, replace ID, retry once. ${closeWorkspace} only when asked.`;
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
  const { loadSkill, readProcessOutput, writeStdin } = options;
  return [
    `Follow returned instructions. Read/open needs no retry. On blocked mutation/command, review instructions and retry with instructionToken. Batch 2–8 independent known targets.${loadSkill ? ` Call ${loadSkill}(workspaceId,skillId); explicit-only needs user request.` : ""}`,
    `Long jobs: sessionId/${writeStdin}; page outputId/${readProcessOutput}. On unknown process, stop polling, read outputId if known, verify effects before rerun.`,
    "Keep writes/temp in workspace; use stdout/outputId. Never inspect DevSpace state. Checks are guardrails, not a sandbox.",
  ].join(" ");
}
