import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";

export interface ProcessIdentity {
  pid: number;
  startIdentity?: string;
  bootIdentity?: string;
  processGroupId?: number;
}

export interface ProcessIdentityRuntime {
  platform: NodeJS.Platform;
  currentPid: number;
  processAlive(pid: number): boolean;
  processGroupAlive(processGroupId: number): boolean;
  processStartIdentity(pid: number): string | undefined;
  processGroupId(pid: number): number | undefined;
  bootIdentity(): string | undefined;
}

export const defaultProcessIdentityRuntime: ProcessIdentityRuntime = {
  platform: process.platform,
  currentPid: process.pid,
  processAlive,
  processGroupAlive,
  processStartIdentity,
  processGroupId,
  bootIdentity,
};

export function readProcessIdentity(
  pid: number,
  runtime: ProcessIdentityRuntime = defaultProcessIdentityRuntime,
): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError("Process PID must be positive.");
  const startIdentity = runtime.processStartIdentity(pid);
  const boot = runtime.bootIdentity();
  const group = runtime.processGroupId(pid);
  return {
    pid,
    ...(startIdentity ? { startIdentity } : {}),
    ...(boot ? { bootIdentity: boot } : {}),
    ...(group ? { processGroupId: group } : {}),
  };
}

export function processIdentityAlive(
  identity: ProcessIdentity,
  runtime: ProcessIdentityRuntime = defaultProcessIdentityRuntime,
): boolean {
  if (!runtime.processAlive(identity.pid)) return false;
  const currentBoot = runtime.bootIdentity();
  if (identity.bootIdentity && currentBoot && identity.bootIdentity !== currentBoot) return false;
  const currentStart = runtime.processStartIdentity(identity.pid);
  if (identity.startIdentity && currentStart && identity.startIdentity !== currentStart) return false;
  return true;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processGroupAlive(processGroupId: number): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(processGroupId) || processGroupId < 1) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform === "linux") return linuxProcessStat(pid)?.startIdentity;
  if (process.platform === "win32") return undefined;
  try {
    const value = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function processGroupId(pid: number): number | undefined {
  if (process.platform === "linux") return linuxProcessStat(pid)?.processGroupId;
  if (process.platform === "win32") return undefined;
  try {
    const value = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

let cachedBootIdentity: string | undefined;

function bootIdentity(): string | undefined {
  if (cachedBootIdentity) return cachedBootIdentity;
  if (process.platform === "linux") {
    try {
      const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (value) return (cachedBootIdentity = `linux:${value}`);
    } catch {
      // Fall through to the bounded boot-time approximation.
    }
  } else if (process.platform === "darwin") {
    try {
      const value = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1_000,
      }).trim();
      if (value) return (cachedBootIdentity = `darwin:${value}`);
    } catch {
      // Fall through to the bounded boot-time approximation.
    }
  }
  const approximateBootSeconds = Math.floor(Date.now() / 1_000 - uptime());
  return (cachedBootIdentity = `${process.platform}:boot-${approximateBootSeconds}`);
}

function linuxProcessStat(pid: number): {
  startIdentity: string;
  processGroupId?: number;
} | undefined {
  try {
    const source = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = source.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = source.slice(close + 2).trim().split(/\s+/u);
    const startTicks = fields[19]; // /proc stat field 22; fields starts at field 3.
    const group = Number(fields[2]); // /proc stat field 5.
    if (!startTicks) return undefined;
    return {
      startIdentity: `linux-start-ticks:${startTicks}`,
      ...(Number.isSafeInteger(group) && group > 0 ? { processGroupId: group } : {}),
    };
  } catch {
    return undefined;
  }
}
