import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  boundedLocalAgentText,
  MAX_LOCAL_AGENT_CAPTURE_BYTES,
  MAX_LOCAL_AGENT_RESPONSE_BYTES,
} from "./local-agent-limits.js";

const AGENT_ID_PATTERN = /^agt_[a-f0-9]{8,64}$/u;

/**
 * Retain the full bounded response outside SQLite when it exceeds the direct
 * display budget. `devspace agents show` streams this file to stdout, so its
 * enclosing exec_command automatically persists it in the normal process
 * output store and returns an outputId for paging.
 */
export function writeLocalAgentOutput(
  stateDir: string,
  agentId: string,
  response: string,
): boolean {
  validateAgentId(agentId);
  if (Buffer.byteLength(response, "utf8") <= MAX_LOCAL_AGENT_RESPONSE_BYTES) {
    removeLocalAgentOutputSync(stateDir, agentId);
    return false;
  }
  const directory = ensureOutputDirectory(stateDir);
  const destination = join(directory, `${agentId}.txt`);
  const temporary = join(directory, `.${agentId}.${randomUUID()}.tmp`);
  const bounded = boundedLocalAgentText(
    response,
    MAX_LOCAL_AGENT_CAPTURE_BYTES,
    "local-agent full response",
  );
  try {
    writeFileSync(temporary, bounded, { encoding: "utf8", mode: 0o600, flag: "wx" });
    rmSync(destination, { force: true });
    renameSync(temporary, destination);
    chmodSync(destination, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

export function readLocalAgentOutput(
  stateDir: string,
  agentId: string,
): string | undefined {
  validateAgentId(agentId);
  const path = outputPath(stateDir, agentId);
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    if (process.platform !== "win32" && (stats.mode & 0o777n) !== 0o600n) return undefined;
    if (stats.size > BigInt(MAX_LOCAL_AGENT_CAPTURE_BYTES)) return undefined;
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function removeLocalAgentOutputSync(stateDir: string, agentId: string): void {
  validateAgentId(agentId);
  try {
    rmSync(outputPath(stateDir, agentId), { force: true });
  } catch {
    // Output cleanup must not make a completed DB cleanup or retry fail.
  }
}

function ensureOutputDirectory(stateDir: string): string {
  const directory = resolve(stateDir, "local-agent-output");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(directory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Local-agent output storage is not a private directory.");
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function outputPath(stateDir: string, agentId: string): string {
  return join(resolve(stateDir, "local-agent-output"), `${agentId}.txt`);
}

function validateAgentId(agentId: string): void {
  if (!AGENT_ID_PATTERN.test(agentId)) throw new TypeError("Invalid local-agent id.");
}
