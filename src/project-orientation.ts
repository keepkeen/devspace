import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TOP_LEVEL_ENTRIES = 20;

export interface ProjectOrientation {
  empty: boolean;
  topLevel: string[];
  topLevelTruncated?: true;
  git?: {
    branch: string;
    dirty: boolean;
  };
}

export async function inspectProjectOrientation(root: string): Promise<ProjectOrientation> {
  const entries: string[] = [];
  const directory = await opendir(root);
  for await (const entry of directory) {
    if (entry.name === ".git") continue;
    entries.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
    if (entries.length > MAX_TOP_LEVEL_ENTRIES) break;
  }
  entries.sort((left, right) => left.localeCompare(right));
  const [branch, status] = await Promise.all([
    runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1"]),
  ]);
  const topLevel = entries.slice(0, MAX_TOP_LEVEL_ENTRIES);
  return {
    empty: entries.length === 0,
    topLevel,
    ...(entries.length > topLevel.length ? { topLevelTruncated: true as const } : {}),
    ...(branch !== undefined && status !== undefined
      ? { git: { branch: branch.trim() || "HEAD", dirty: status.length > 0 } }
      : {}),
  };
}

async function runGit(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 512 * 1024,
      timeout: 1_000,
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}
