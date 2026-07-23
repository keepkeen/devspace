/** Compact model-facing instructions for the fixed DevSpace tool surface. */

export function buildWorkspaceLifecycleInstruction(options: {
  openWorkspace: string;
  closeWorkspace: string;
}): string {
  const { openWorkspace, closeWorkspace } = options;
  return `Use DevSpace, not hosted Python. Call ${openWorkspace} with the exact path once; reuse workspaceId across turns/transports. If unknown, reopen that exact path, replace ID, retry once. Use ${closeWorkspace} only when asked.`;
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
    `Follow all returned instructions. Read/open instructions need no retry. If a blocked mutation/command returns instructionToken, review returned instructions and retry with it. Batch 2–8 independent known targets.${loadSkill ? ` Call ${loadSkill}(workspaceId,skillId); explicit-only needs user request.` : ""}`,
    `Long jobs use process sessionId/${writeStdin}, not MCP session; page outputId with ${readProcessOutput}. If process sessionId is unknown, stop polling, read prior outputId, verify effects before rerun.`,
    "Keep writes/temp files in workspace; use stdout/outputId for long output. Never inspect DevSpace internal state. Checks are guardrails, not a sandbox.",
  ].join(" ");
}
