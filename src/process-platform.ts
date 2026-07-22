import { basename, delimiter } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface ShellCommand {
  executable: string;
  args: string[];
}

export interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ProcessTreeRuntime {
  platform: NodeJS.Platform;
  killGroup(pid: number, signal: NodeJS.Signals): void;
  killWindowsTree(pid: number): boolean;
}

const defaultProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  killGroup: (pid, signal) => process.kill(-pid, signal),
  killWindowsTree: (pid) => {
    const result = spawnSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  },
};

const LOGIN_SHELLS = new Set(["bash", "ksh", "zsh"]);
const POSIX_SHELLS = new Set(["ash", "dash", "sh"]);

function isLegacyWslBashPath(path: string): boolean {
  const normalized = path.replace(/\//g, "\\").toLowerCase();
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function findBashOnPath(platform: NodeJS.Platform): string | undefined {
  try {
    if (platform === "win32") {
      const result = spawnSync("where", ["bash.exe"], {
        encoding: "utf-8",
        timeout: 5_000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
        if (firstMatch && existsSync(firstMatch)) return firstMatch;
      }
      return undefined;
    }

    const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 5_000 });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {
    // Ignore lookup failures.
  }
  return undefined;
}

function findWindowsGitBash(environment: NodeJS.ProcessEnv): string | undefined {
  const candidates: string[] = [];
  const programFiles = environment.ProgramFiles;
  if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
  const programFilesX86 = environment["ProgramFiles(x86)"];
  if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
  // Common scoop / user installs
  const localAppData = environment.LOCALAPPDATA;
  if (localAppData) candidates.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

function bashCommand(shell: string, command: string): ShellCommand {
  // Legacy WSL bash.exe needs stdin transport; DevSpace always passes the
  // command as an argument, so prefer -c for standard bash and Git Bash.
  if (isLegacyWslBashPath(shell)) {
    return { executable: shell, args: ["-c", command] };
  }
  return { executable: shell, args: ["-c", command] };
}

/**
 * Resolve a Bash-compatible shell command launcher.
 *
 * Prefers bash everywhere (Claude Code / Codex style). On Windows this looks for
 * Git Bash or bash on PATH before falling back to cmd.exe for environments that
 * only have a system shell.
 */
export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellCommand {
  const configuredShell = environment.SHELL ?? environment.DEVSPACE_SHELL;

  if (configuredShell) {
    const shellName = basename(configuredShell).toLowerCase().replace(/\.exe$/, "");
    if (LOGIN_SHELLS.has(shellName)) {
      // Non-login -c keeps startup fast and matches Claude/pi; profile is still
      // partially inherited via process env.
      return { executable: configuredShell, args: ["-c", command] };
    }
    if (POSIX_SHELLS.has(shellName)) {
      return { executable: configuredShell, args: ["-c", command] };
    }
    if (shellName === "bash" || configuredShell.toLowerCase().endsWith("bash.exe")) {
      return bashCommand(configuredShell, command);
    }
  }

  if (platform === "win32") {
    const gitBash = findWindowsGitBash(environment);
    if (gitBash) return bashCommand(gitBash, command);
    const bashOnPath = findBashOnPath(platform);
    if (bashOnPath) return bashCommand(bashOnPath, command);

    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }

  if (existsSync("/bin/bash")) {
    return bashCommand("/bin/bash", command);
  }

  const bashOnPath = findBashOnPath(platform);
  if (bashOnPath) return bashCommand(bashOnPath, command);

  return { executable: "/bin/sh", args: ["-c", command] };
}

export function terminateProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
  detached: boolean,
  runtime: ProcessTreeRuntime = defaultProcessTreeRuntime,
): void {
  if (runtime.platform === "win32" && child.pid) {
    if (runtime.killWindowsTree(child.pid)) return;
  } else if (detached && child.pid) {
    try {
      runtime.killGroup(child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }

  child.kill(signal);
}

/** Exported for tests — PATH-style join helper not required at runtime. */
export function pathHasEntry(pathValue: string | undefined, entry: string): boolean {
  if (!pathValue) return false;
  return pathValue.split(delimiter).includes(entry);
}
