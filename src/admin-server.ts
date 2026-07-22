import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminConfigOverridePaths,
  adminConfigWarnings,
  AdminConfigValidationError,
  loadAdminConfig,
  saveAdminConfig,
} from "./admin-config.js";
import { loadConfigForAdmin } from "./config.js";
import { devspaceConfigPath } from "./user-config.js";

const CAPABILITY_HEADER = "x-devspace-admin-capability";
const CSRF_HEADER = "x-devspace-admin-csrf";
const SESSION_COOKIE = "devspace_admin_session";
const MAX_BODY_BYTES = 64 * 1_024;
const SESSION_TTL_MS = 60 * 60 * 1_000;

export interface StartAdminServerOptions {
  host?: "127.0.0.1";
  port?: number;
  env?: NodeJS.ProcessEnv;
  staticDir?: string;
}

export interface RunningAdminServer {
  url: string;
  close(): Promise<void>;
}

interface AdminSession {
  csrfToken: string;
  expiresAt: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function startAdminServer(
  options: StartAdminServerOptions = {},
): Promise<RunningAdminServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("The admin server may only bind to 127.0.0.1.");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid admin port: ${port}`);
  }

  const env = options.env ?? process.env;
  const staticDir = resolve(
    options.staticDir ?? fileURLToPath(new URL("../dist/admin-ui", import.meta.url)),
  );
  const capability = randomBytes(32).toString("base64url");
  const capabilityState = { available: true };
  const sessions = new Map<string, AdminSession>();
  let expectedHost = "";
  let expectedOrigin = "";

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      assertLoopbackRequest(request);
      if (request.headers.host !== expectedHost) {
        throw new HttpError(403, "invalid_host", "The request Host is not allowed.");
      }

      const requestUrl = new URL(request.url ?? "/", expectedOrigin);
      if (requestUrl.pathname.startsWith("/api/")) {
        assertOrigin(request, expectedOrigin);
        await handleApiRequest(request, response, requestUrl.pathname, {
          capability,
          capabilityState,
          env,
          sessions,
        });
        return;
      }

      await serveStaticFile(request, response, requestUrl.pathname, staticDir);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const httpError = error instanceof HttpError
        ? error
        : new HttpError(500, "internal_error", "The admin request failed.");
      sendJson(response, httpError.status, {
        error: { code: httpError.code, message: httpError.message },
      });
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine the admin server address.");
  }
  expectedHost = `${host}:${address.port}`;
  expectedOrigin = `http://${expectedHost}`;

  return {
    url: `${expectedOrigin}/#capability=${encodeURIComponent(capability)}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections();
    }),
  };
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  context: {
    capability: string;
    capabilityState: { available: boolean };
    env: NodeJS.ProcessEnv;
    sessions: Map<string, AdminSession>;
  },
): Promise<void> {
  if (pathname === "/api/session" && request.method === "POST") {
    const suppliedCapability = singleHeader(request, CAPABILITY_HEADER);
    if (!suppliedCapability) {
      const session = authenticate(request, context.sessions);
      sendJson(response, 200, { csrfToken: session.csrfToken });
      return;
    }
    if (
      !context.capabilityState.available ||
      !secretsEqual(suppliedCapability, context.capability)
    ) {
      throw new HttpError(401, "invalid_capability", "The admin capability is invalid.");
    }
    context.capabilityState.available = false;
    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    context.sessions.set(sessionId, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1_000}`,
    );
    sendJson(response, 200, { csrfToken });
    return;
  }

  const session = authenticate(request, context.sessions);
  if (pathname === "/api/status" && request.method === "GET") {
    const config = loadConfigForAdmin(context.env);
    const mcp = await probeMcpReady(config.host, config.port);
    sendJson(response, 200, {
      configPath: devspaceConfigPath(context.env),
      publicBaseUrl: redactUrlCredentials(config.publicBaseUrl),
      admin: { ready: true },
      mcp,
    });
    return;
  }
  if (pathname === "/api/config" && request.method === "GET") {
    const config = loadAdminConfig(context.env);
    sendJson(response, 200, {
      config,
      overrides: adminConfigOverridePaths(context.env),
      warnings: adminConfigWarnings(config),
    });
    return;
  }
  if (pathname === "/api/config" && request.method === "PUT") {
    const csrfToken = singleHeader(request, CSRF_HEADER);
    if (!csrfToken || !secretsEqual(csrfToken, session.csrfToken)) {
      throw new HttpError(403, "invalid_csrf", "The CSRF token is invalid.");
    }
    const body = await readJsonBody(request);
    if (!isRecord(body) || !("config" in body)) {
      throw new HttpError(400, "invalid_config", "The request must contain a config object.");
    }
    try {
      const saved = saveAdminConfig(body.config, context.env);
      sendJson(response, 200, {
        ...saved,
        overrides: adminConfigOverridePaths(context.env),
        warnings: adminConfigWarnings(saved.config),
      });
    } catch (error) {
      if (!(error instanceof AdminConfigValidationError)) throw error;
      sendJson(response, 400, {
        error: {
          code: "invalid_config",
          message: error.message,
          fields: error.fields,
        },
      });
    }
    return;
  }

  if (request.method === "OPTIONS") {
    throw new HttpError(405, "method_not_allowed", "CORS requests are not supported.");
  }
  throw new HttpError(404, "not_found", "The admin endpoint was not found.");
}

function authenticate(
  request: IncomingMessage,
  sessions: Map<string, AdminSession>,
): AdminSession {
  const sessionId = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    if (sessionId) sessions.delete(sessionId);
    throw new HttpError(401, "authentication_required", "Admin authentication is required.");
  }
  return session;
}

function assertLoopbackRequest(request: IncomingMessage): void {
  const remoteAddress = request.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress ?? "")) {
    throw new HttpError(403, "loopback_required", "Admin requests must originate on loopback.");
  }
}

function assertOrigin(request: IncomingMessage, expectedOrigin: string): void {
  const origin = singleHeader(request, "origin");
  if (origin !== undefined && origin !== expectedOrigin) {
    throw new HttpError(403, "invalid_origin", "The request Origin is not allowed.");
  }
  if (!["GET", "HEAD"].includes(request.method ?? "") && origin !== expectedOrigin) {
    throw new HttpError(403, "invalid_origin", "The request Origin is required.");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = singleHeader(request, "content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "body_too_large", "The request body is too large.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

async function probeMcpReady(host: string, port: number): Promise<{
  ready: boolean;
  status: number | null;
  error?: "unreachable";
}> {
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (result: { ready: boolean; status: number | null; error?: "unreachable" }): void => {
      if (settled) return;
      settled = true;
      resolveProbe(result);
    };
    const request = httpGet(
      { hostname: probeHost(host), port, path: "/readyz", timeout: 1_500 },
      (response) => {
        response.resume();
        finish({ ready: response.statusCode === 200, status: response.statusCode ?? null });
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => finish({ ready: false, status: null, error: "unreachable" }));
  });
}

function probeHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

async function serveStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  staticDir: string,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed", "The request method is not allowed.");
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid_path", "The request path is invalid.");
  }
  const relativePath = decodedPath === "/" ? "admin.html" : decodedPath.replace(/^\/+/, "");
  let filePath: string;
  let canonicalStaticDir: string;
  try {
    canonicalStaticDir = realpathSync(staticDir);
    filePath = realpathSync(resolve(canonicalStaticDir, relativePath));
  } catch {
    throw new HttpError(404, "not_found", "The admin asset was not found.");
  }
  const relationship = relative(canonicalStaticDir, filePath);
  if (
    relationship === "" ||
    relationship === ".." ||
    relationship.startsWith(`..${sep}`) ||
    !statSync(filePath).isFile()
  ) {
    throw new HttpError(404, "not_found", "The admin asset was not found.");
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType(filePath));
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(filePath);
    stream.on("error", rejectStream);
    stream.on("end", resolveStream);
    stream.pipe(response);
  });
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function parseCookies(value: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of value?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (name && !(name in cookies)) cookies[name] = cookieValue;
  }
  return cookies;
}

function secretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".ico": return "image/x-icon";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function redactUrlCredentials(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  return url.toString().replace(/\/$/, "");
}
