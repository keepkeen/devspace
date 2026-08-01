import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export async function git(
  cwd: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    unsetEnv?: readonly string[];
    maxBuffer?: number;
  } = {},
): Promise<GitCommandResult> {
  const env = { ...process.env, ...options.env };
  for (const name of options.unsetEnv ?? []) delete env[name];
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    env,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });

  return { stdout, stderr };
}
