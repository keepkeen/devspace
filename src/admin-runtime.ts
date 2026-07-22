import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";

const LAUNCHCTL_PATH = "/bin/launchctl";
const RUNTIME_COMMAND_TIMEOUT_MS = 10_000;
const RUNTIME_RECOVERY_TIMEOUT_MS = 30_000;
const SERVICE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type BackendRuntimeState =
  | "unmanaged"
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "failed"
  | "unknown";

export interface BackendRuntimeOperation {
  id: string;
  target: "backend";
  action: "restart";
  state: "accepted" | "completed" | "failed";
  requestedAt: string;
  completedAt?: string;
  error?: string;
  verification?: {
    previousPid: number;
    currentPid: number;
    previousGeneration: string;
    currentGeneration: string;
  };
}

export interface BackendRuntimeStatus {
  managed: boolean;
  state: BackendRuntimeState;
  supervisor?: "launchd";
  label?: string;
  actions: Array<"restart">;
  lastError?: string;
  operation?: BackendRuntimeOperation;
}

export interface BackendReadiness {
  ready: boolean;
  generation?: string;
}

export class AdminRuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminRuntimeError";
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export interface AdminRuntimeManagerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
  runCommand?: CommandRunner;
  probeReady?: () => Promise<BackendReadiness>;
  recoveryTimeoutMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Controls only an explicitly enrolled user launchd service. It never searches
 * for PIDs, invokes a shell, accepts executable paths, or manages system jobs.
 */
export class AdminRuntimeManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly uid: number | undefined;
  private readonly runCommand: CommandRunner;
  private readonly onEvent: (event: string, fields: Record<string, unknown>) => void;
  private readonly probeReady: () => Promise<BackendReadiness>;
  private readonly recoveryTimeoutMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private restartPending = false;
  private inFlight: BackendRuntimeOperation | undefined;
  private lastOperation: BackendRuntimeOperation | undefined;

  constructor(options: AdminRuntimeManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.uid = options.uid ?? process.getuid?.();
    this.runCommand = options.runCommand ?? runCommand;
    this.probeReady = options.probeReady ?? (async () => ({ ready: false }));
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? RUNTIME_RECOVERY_TIMEOUT_MS;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolveWait) => {
      setTimeout(resolveWait, milliseconds);
    }));
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  async backendStatus(): Promise<BackendRuntimeStatus> {
    const enrollment = this.enrollment();
    if (!("target" in enrollment)) {
      return {
        managed: false,
        state: enrollment.state,
        actions: [],
        ...(enrollment.label ? { label: enrollment.label } : {}),
        ...(enrollment.error ? { lastError: enrollment.error } : {}),
        ...(this.lastOperation ? { operation: this.lastOperation } : {}),
      };
    }

    if (this.inFlight) {
      return {
        managed: true,
        state: "restarting",
        supervisor: "launchd",
        label: enrollment.label,
        actions: [],
        operation: this.inFlight,
      };
    }

    try {
      const result = await this.runCommand(
        LAUNCHCTL_PATH,
        ["print", enrollment.target],
        RUNTIME_COMMAND_TIMEOUT_MS,
      );
      return {
        managed: true,
        state: launchdState(result.stdout),
        supervisor: "launchd",
        label: enrollment.label,
        actions: ["restart"],
        ...(this.lastOperation?.state === "failed" && this.lastOperation.error
          ? { lastError: this.lastOperation.error }
          : {}),
        ...(this.lastOperation ? { operation: this.lastOperation } : {}),
      };
    } catch {
      return {
        managed: false,
        state: "unmanaged",
        label: enrollment.label,
        actions: [],
        lastError: "The configured user launchd service is not loaded.",
        ...(this.lastOperation ? { operation: this.lastOperation } : {}),
      };
    }
  }

  async restartBackend(): Promise<BackendRuntimeOperation> {
    if (this.restartPending || this.inFlight) {
      throw new AdminRuntimeError(409, "runtime_busy", "A backend runtime operation is already in progress.");
    }
    this.restartPending = true;
    let enrollment: { target: string; label: string };
    let previousPid: number;
    let previousGeneration: string;
    try {
      const resolvedEnrollment = this.enrollment();
      if (!("target" in resolvedEnrollment)) {
        throw new AdminRuntimeError(
          409,
          "runtime_unmanaged",
          "Backend restart is available only for the enrolled user launchd service.",
        );
      }
      enrollment = resolvedEnrollment;
      let launchdBefore: CommandResult;
      try {
        launchdBefore = await this.runCommand(
          LAUNCHCTL_PATH,
          ["print", enrollment.target],
          RUNTIME_COMMAND_TIMEOUT_MS,
        );
      } catch {
        throw new AdminRuntimeError(409, "runtime_unmanaged", "The backend service is not loaded.");
      }
      previousPid = launchdPid(launchdBefore.stdout) ?? 0;
      if (previousPid <= 0) {
        throw new AdminRuntimeError(
          409,
          "runtime_pid_unavailable",
          "The current launchd process identifier is unavailable; restart verification cannot proceed.",
        );
      }
      const readinessBefore = await this.probeReady();
      previousGeneration = readinessBefore.generation ?? "";
      if (!readinessBefore.ready || !previousGeneration) {
        throw new AdminRuntimeError(
          409,
          "runtime_generation_unavailable",
          "The backend readiness generation is unavailable; restart verification cannot proceed.",
        );
      }
    } finally {
      this.restartPending = false;
    }

    const operation: BackendRuntimeOperation = {
      id: randomUUID(),
      target: "backend",
      action: "restart",
      state: "accepted",
      requestedAt: new Date().toISOString(),
    };
    this.inFlight = operation;
    this.lastOperation = operation;
    this.onEvent("admin_runtime_operation_requested", { ...operation });

    void this.verifyRestart(enrollment, previousPid, previousGeneration).then((verification) => {
      operation.state = "completed";
      operation.completedAt = new Date().toISOString();
      operation.verification = verification;
      this.onEvent("admin_runtime_operation_completed", { ...operation });
    }).catch((error) => {
      operation.state = "failed";
      operation.completedAt = new Date().toISOString();
      operation.error = error instanceof AdminRuntimeError
        ? error.message
        : "The backend did not prove a new process generation and readiness after restart.";
      this.onEvent("admin_runtime_operation_failed", { ...operation });
    }).finally(() => {
      this.inFlight = undefined;
    });

    return { ...operation };
  }

  private async verifyRestart(
    enrollment: { target: string; label: string },
    previousPid: number,
    previousGeneration: string,
  ): Promise<NonNullable<BackendRuntimeOperation["verification"]>> {
    try {
      await this.runCommand(
        LAUNCHCTL_PATH,
        ["kickstart", "-k", enrollment.target],
        RUNTIME_COMMAND_TIMEOUT_MS,
      );
    } catch {
      throw new AdminRuntimeError(502, "runtime_restart_failed", "launchd could not restart the enrolled backend service.");
    }

    const deadline = Date.now() + this.recoveryTimeoutMs;
    do {
      let currentPid: number | undefined;
      try {
        const launchd = await this.runCommand(
          LAUNCHCTL_PATH,
          ["print", enrollment.target],
          RUNTIME_COMMAND_TIMEOUT_MS,
        );
        if (launchdState(launchd.stdout) === "running") currentPid = launchdPid(launchd.stdout);
      } catch {
        // launchd may briefly report the job as unavailable while replacing it.
      }
      if (currentPid && currentPid !== previousPid) {
        const readiness: BackendReadiness = await this.probeReady().catch(() => ({ ready: false }));
        if (
          readiness.ready &&
          readiness.generation &&
          readiness.generation !== previousGeneration
        ) {
          return {
            previousPid,
            currentPid,
            previousGeneration,
            currentGeneration: readiness.generation,
          };
        }
      }
      if (Date.now() < deadline) await this.wait(250);
    } while (Date.now() < deadline);

    throw new AdminRuntimeError(
      504,
      "runtime_recovery_timeout",
      "The backend did not prove a new launchd PID and readiness generation before the recovery deadline.",
    );
  }

  private enrollment():
    | { target: string; label: string }
    | { state: "unmanaged" | "failed"; label?: string; error?: string } {
    const label = this.env.DEVSPACE_LAUNCHD_SERVICE_LABEL?.trim();
    if (!label) return { state: "unmanaged" };
    if (!SERVICE_LABEL_PATTERN.test(label)) {
      return { state: "failed", label, error: "DEVSPACE_LAUNCHD_SERVICE_LABEL is invalid." };
    }
    if (this.platform !== "darwin" || this.uid === undefined || this.uid <= 0) {
      return {
        state: "unmanaged",
        label,
        error: "User-level launchd management is unavailable on this platform or account.",
      };
    }
    return { label, target: `gui/${this.uid}/${label}` };
  }
}

function launchdState(stdout: string): BackendRuntimeState {
  const state = /^\s*state\s*=\s*([^\s]+)\s*$/im.exec(stdout)?.[1]?.toLowerCase();
  if (state === "running") return "running";
  if (state === "spawn scheduled" || state === "starting") return "starting";
  if (state === "exited" || state === "stopped" || state === "waiting") return "stopped";
  return "unknown";
}

function launchdPid(stdout: string): number | undefined {
  const value = /^\s*pid\s*=\s*(\d+)\s*$/im.exec(stdout)?.[1];
  if (!value) return undefined;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function probeBackendReadiness(host: string, port: number): Promise<BackendReadiness> {
  return new Promise((resolveProbe) => {
    const request = httpGet(
      { hostname: host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host, port, path: "/readyz", timeout: 1_500 },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size <= 16 * 1_024) chunks.push(Buffer.from(chunk));
          else request.destroy();
        });
        response.on("end", () => {
          let generation: string | undefined;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { generation?: unknown };
            if (typeof body.generation === "string" || typeof body.generation === "number") {
              generation = String(body.generation);
            }
          } catch {
            // A valid readiness response without JSON still reports readiness, but cannot verify restart.
          }
          resolveProbe({ ready: response.statusCode === 200, ...(generation ? { generation } : {}) });
        });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolveProbe({ ready: false }));
  });
}

function runCommand(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 256 * 1_024,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
}
