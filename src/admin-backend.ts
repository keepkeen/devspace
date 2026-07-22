import { request as httpRequest } from "node:http";
import { internalDiagnosticsToken, internalRevocationToken } from "./internal-auth.js";

const MAX_INTERNAL_RESPONSE_BYTES = 256 * 1_024;

export class AdminBackendProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AdminBackendProxyError";
  }
}

export interface AdminBackendClient {
  diagnostics(): Promise<unknown>;
  revokeAllClientsAndTokens(): Promise<unknown>;
}

export interface HttpAdminBackendClientOptions {
  host: string;
  port: number;
  ownerToken: string;
}

export class HttpAdminBackendClient implements AdminBackendClient {
  private readonly host: string | undefined;
  private readonly port: number;
  private readonly internalToken: string;
  private readonly revocationToken: string;

  constructor(options: HttpAdminBackendClientOptions) {
    this.host = internalLoopbackHost(options.host);
    this.port = options.port;
    this.internalToken = deriveInternalAdminToken(options.ownerToken);
    this.revocationToken = internalRevocationToken(options.ownerToken);
  }

  async diagnostics(): Promise<unknown> {
    return redactDiagnosticValue(await this.request("GET", "/internal/diagnostics"));
  }

  async revokeAllClientsAndTokens(): Promise<unknown> {
    return redactDiagnosticValue(await this.request(
      "POST",
      "/internal/security/revoke",
      { scope: "all_clients_and_tokens" },
      this.revocationToken,
    ));
  }

  private request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    internalToken = this.internalToken,
  ): Promise<unknown> {
    if (!this.host) {
      return Promise.reject(new AdminBackendProxyError(
        503,
        "backend_admin_unavailable",
        "Backend admin telemetry requires a loopback backend endpoint.",
      ));
    }
    return new Promise((resolveRequest, rejectRequest) => {
      const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = httpRequest({
        hostname: this.host,
        port: this.port,
        path,
        method,
        timeout: 3_000,
        headers: {
          "x-devspace-internal-token": internalToken,
          accept: "application/json",
          ...(encodedBody ? {
            "content-type": "application/json",
            "content-length": String(encodedBody.length),
          } : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_INTERNAL_RESPONSE_BYTES) {
            request.destroy(new Error("Internal admin response is too large."));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const status = response.statusCode ?? 502;
          if (status < 200 || status >= 300) {
            rejectRequest(new AdminBackendProxyError(
              status === 404 ? 503 : 502,
              "backend_admin_unavailable",
              "Backend admin telemetry is not available.",
            ));
            return;
          }
          try {
            resolveRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch {
            rejectRequest(new AdminBackendProxyError(
              502,
              "invalid_backend_admin_response",
              "Backend admin telemetry returned an invalid response.",
            ));
          }
        });
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => rejectRequest(new AdminBackendProxyError(
        503,
        "backend_admin_unavailable",
        "Backend admin telemetry is unavailable.",
      )));
      if (encodedBody) request.write(encodedBody);
      request.end();
    });
  }
}

function internalLoopbackHost(host: string): string | undefined {
  if (host === "0.0.0.0" || host === "127.0.0.1" || host === "localhost") return "127.0.0.1";
  if (host === "::" || host === "::1") return "::1";
  return undefined;
}

export function deriveInternalAdminToken(ownerToken: string): string {
  return internalDiagnosticsToken(ownerToken);
}

export function redactDiagnosticValue(value: unknown, key = ""): unknown {
  if (/^(?:pid|ppid)$/i.test(key)) return undefined;
  if (/(?:token|secret|password|authorization|cookie|credential)/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticValue(entry)).filter((entry) => entry !== undefined);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entryValue]) => {
      const redacted = redactDiagnosticValue(entryValue, entryKey);
      return redacted === undefined ? [] : [[entryKey, redacted]];
    }));
  }
  if (typeof value === "string") return redactDiagnosticString(value);
  return value;
}

function redactDiagnosticString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/([?&](?:token|secret|password|key)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[redacted]@");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
