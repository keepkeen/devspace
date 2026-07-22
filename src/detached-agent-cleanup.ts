import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const PROMPT_DIRECTORY_PREFIX = "devspace-agent-prompt-";
const DEFAULT_PROMPT_RETENTION_MS = 24 * 60 * 60_000;
const DEFAULT_PROMPT_CLEANUP_LIMIT = 64;

export async function removeDetachedAgentPrompt(promptFile: string): Promise<boolean> {
  const directory = safePromptDirectory(promptFile, tmpdir());
  if (!directory) return false;
  await rm(directory, { recursive: true, force: true });
  return true;
}

export async function cleanupDetachedAgentPromptArtifacts(options: {
  tempRoot?: string;
  now?: number;
  olderThanMs?: number;
  limit?: number;
} = {}): Promise<number> {
  const tempRoot = resolve(options.tempRoot ?? tmpdir());
  const now = options.now ?? Date.now();
  const olderThanMs = options.olderThanMs ?? DEFAULT_PROMPT_RETENTION_MS;
  const limit = Math.max(0, options.limit ?? DEFAULT_PROMPT_CLEANUP_LIMIT);
  const candidates: Array<{ path: string; modifiedAt: number }> = [];

  let entries;
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROMPT_DIRECTORY_PREFIX)) continue;
    const path = join(tempRoot, entry.name);
    try {
      const metadata = await stat(path);
      if (now - metadata.mtimeMs > olderThanMs) candidates.push({ path, modifiedAt: metadata.mtimeMs });
    } catch {
      // A concurrent worker or cleanup may already have removed it.
    }
  }

  candidates.sort((left, right) => left.modifiedAt - right.modifiedAt);
  const deleting = candidates.slice(0, limit);
  await Promise.all(deleting.map(({ path }) => rm(path, { recursive: true, force: true })));
  return deleting.length;
}

function safePromptDirectory(promptFile: string, tempRoot: string): string | undefined {
  if (basename(promptFile) !== "prompt.txt") return undefined;
  const directory = resolve(dirname(promptFile));
  if (dirname(directory) !== resolve(tempRoot)) return undefined;
  if (!basename(directory).startsWith(PROMPT_DIRECTORY_PREFIX)) return undefined;
  return directory;
}
