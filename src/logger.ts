import type { Request } from "express";
import { createHash, createHmac } from "node:crypto";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
export type LogFormat = "json" | "pretty";

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  requests: boolean;
  assets: boolean;
  toolCalls: boolean;
  shellCommands: boolean;
  trustProxy: boolean;
  auditEvents?: boolean;
  auditSink?: (entry: Readonly<Record<string, unknown>>) => void;
  auditWriteHealth?: AuditWriteHealth;
}

export interface AuditWriteHealth {
  auditWriteFailures: number;
  lastAuditWriteFailureAt?: string;
}

export function createAuditWriteHealth(): AuditWriteHealth {
  return { auditWriteFailures: 0 };
}

export function auditWriteHealthSnapshot(
  health: AuditWriteHealth,
): Readonly<AuditWriteHealth> {
  return {
    auditWriteFailures: health.auditWriteFailures,
    ...(health.lastAuditWriteFailureAt
      ? { lastAuditWriteFailureAt: health.lastAuditWriteFailureAt }
      : {}),
  };
}

type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const CHINA_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function shouldLog(config: LoggingConfig, level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_WEIGHT[config.level] >= LEVEL_WEIGHT[level];
}

export function logEvent(
  config: LoggingConfig,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields: LogFields = {},
): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  try {
    config.auditSink?.(entry);
  } catch {
    // Persistent observability is best-effort and must never change the tool
    // result or authorization decision being logged.
    if (config.auditWriteHealth) {
      config.auditWriteHealth.auditWriteFailures += 1;
      config.auditWriteHealth.lastAuditWriteFailureAt = entry.ts;
    }
  }
  if (!shouldLog(config, level)) return;

  const line = config.format === "pretty" ? formatPretty(entry) : JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function requestIp(req: Request, trustProxy: boolean): string | undefined {
  const remoteAddress = req.socket?.remoteAddress;
  if (trustProxy && isLoopbackProxyPeer(remoteAddress)) {
    const cfConnectingIp = firstHeaderValue(req.header("cf-connecting-ip"));
    if (cfConnectingIp) return cfConnectingIp;

    const forwardedFor = firstHeaderValue(req.header("x-forwarded-for"));
    if (forwardedFor) return forwardedFor;
  }

  return req.ip ?? remoteAddress;
}

export function isLoopbackProxyPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return /^127(?:\.\d{1,3}){3}$/u.test(ipv4);
}

export function requestPath(req: Request): string {
  return req.path || req.url.split("?")[0] || req.url;
}

export function boundedLogHeader(
  value: string | undefined,
  maximumBytes = 256,
): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\r\n]+/gu, " ").trim();
  if (!normalized) return undefined;
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.byteLength <= maximumBytes) return normalized;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}…`;
}

export function originForLog(value: string | undefined): string | undefined {
  const bounded = boundedLogHeader(value, 1_024);
  if (!bounded || bounded === "null") return bounded;
  try {
    return boundedLogHeader(new URL(bounded).origin, 512);
  } catch {
    return boundedLogHeader(bounded.split(/[?#]/u, 1)[0], 512);
  }
}

export function refererForLog(value: string | undefined): string | undefined {
  const bounded = boundedLogHeader(value, 2_048);
  if (!bounded) return undefined;
  try {
    const parsed = new URL(bounded);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return boundedLogHeader(`${parsed.origin}${parsed.pathname}`, 512);
  } catch {
    return boundedLogHeader(bounded.split(/[?#]/u, 1)[0], 512);
  }
}

export function contentLengthForLog(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,16}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function sessionIdPrefix(sessionId: string | undefined): string | undefined {
  return sessionId ? sessionId.slice(0, 8) : undefined;
}

export function identifierHash(
  identifier: string | undefined,
  key?: string | Uint8Array,
  domain = "identifier",
): string | undefined {
  if (!identifier) return undefined;
  return key
    ? createHmac("sha256", key)
        .update(`devspace:audit-ref:${domain}:v1\0`, "utf8")
        .update(identifier, "utf8")
        .digest("hex")
        .slice(0, 12)
    : createHash("sha256").update(identifier).digest("hex").slice(0, 12);
}

/** Stable, privacy-safe reference for one local connection principal. */
export function connectionRef(
  connectionPrincipalId: string | undefined,
  key?: string | Uint8Array,
): string | undefined {
  const hash = identifierHash(connectionPrincipalId, key, "connection");
  return hash ? `conn_${hash}` : undefined;
}

/** Stable, privacy-safe reference for one OAuth dynamic client registration. */
export function oauthClientRef(
  clientId: string | undefined,
  key?: string | Uint8Array,
): string | undefined {
  const hash = identifierHash(clientId, key, "oauth-client");
  return hash ? `oauth_${hash}` : undefined;
}

/**
 * Stable reference for work performed through one local connection principal
 * and Workspace handle. This is an operational activity key, not a ChatGPT
 * thread or verified account claim.
 */
export function workspaceActivityRef(
  connectionPrincipalId: string | undefined,
  workspaceId: string | undefined,
  key?: string | Uint8Array,
): string | undefined {
  if (!connectionPrincipalId || !workspaceId) return undefined;
  const hash = (key ? createHmac("sha256", key) : createHash("sha256"))
    .update("devspace:audit-ref:workspace-activity:v1\0")
    .update(connectionPrincipalId)
    .update("\0")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 12);
  return `act_${hash}`;
}

export function errorFields(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    const message = sanitizeErrorMessage(String(error));
    return {
      error: message,
      errorName: "NonError",
      errorFingerprint: errorFingerprint("NonError", undefined, message),
    };
  }
  const code = typeof (error as Error & { code?: unknown }).code === "string"
    ? (error as Error & { code: string }).code
    : undefined;
  const message = sanitizeErrorMessage(error.message);
  return {
    error: message,
    errorName: error.name,
    ...(code ? { errorCode: code } : {}),
    errorFingerprint: errorFingerprint(error.name, code, message),
  };
}

export function commandPreview(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

export function formatChinaTimestamp(timestamp: string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const parts = Object.fromEntries(
    CHINA_TIME_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${milliseconds} UTC+08:00`;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function sanitizeErrorMessage(value: string): string {
  return value
    .split(/[\r\n]/, 1)[0]!
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [redacted]")
    .replace(/([?&](?:token|secret|password|key)=)[^&#\s]*/giu, "$1[redacted]")
    .replace(/(?:\/[A-Za-z0-9._~ -]+){2,}/gu, "[path]")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*/gu, "[path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 512);
}

function errorFingerprint(name: string, code: string | undefined, message: string): string {
  return createHash("sha256")
    .update("devspace-error-fingerprint-v1\0")
    .update(name)
    .update("\0")
    .update(code ?? "")
    .update("\0")
    .update(message)
    .digest("hex")
    .slice(0, 16);
}

function formatPretty(entry: LogFields): string {
  const ts = formatChinaTimestamp(String(entry.ts));
  const level = String(entry.level).toUpperCase();
  const event = String(entry.event);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !["ts", "level", "event"].includes(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatPrettyValue(value)}`)
    .join(" ");

  return rest ? `${ts} ${level} ${event} ${rest}` : `${ts} ${level} ${event}`;
}

function formatPrettyValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}
