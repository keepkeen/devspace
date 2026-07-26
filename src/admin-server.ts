import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import { get as httpsGet } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AdminConfigConflictError,
  AdminConfigLockError,
  adminConfigOverridePaths,
  adminConfigWarnings,
  AdminConfigValidationError,
  loadAdminConfigSnapshot,
  saveAdminConfigIfMatch,
} from "./admin-config.js";
import {
  AdminBackendProxyError,
  HttpAdminBackendClient,
  redactDiagnosticValue,
  type AdminBackendClient,
} from "./admin-backend.js";
import { loadConfigForAdmin } from "./config.js";
import { devspaceConfigPath } from "./user-config.js";
import {
  AdminRuntimeError,
  AdminRuntimeManager,
  probeBackendReadiness,
  type BackendRuntimeOperation,
  type BackendRuntimeStatus,
} from "./admin-runtime.js";
import { logEvent } from "./logger.js";
import { DEVSPACE_VERSION } from "./version.js";
import { allowedRootsRevision } from "./roots.js";

const CAPABILITY_HEADER = "x-devspace-admin-capability";
const CSRF_HEADER = "x-devspace-admin-csrf";
const SESSION_COOKIE = "devspace_admin_session";
const MAX_BODY_BYTES = 64 * 1_024;
const SESSION_TTL_MS = 60 * 60 * 1_000;
const RUNTIME_CONFIRMATION_TTL_MS = 60 * 1_000;
const SECURITY_CONFIRMATION_TTL_MS = 60 * 1_000;
const unsafeProbeAddresses = createUnsafeProbeBlockList();

export interface StartAdminServerOptions {
  host?: "127.0.0.1";
  port?: number;
  env?: NodeJS.ProcessEnv;
  staticDir?: string;
  runtimeManager?: AdminRuntimeController;
  backendClient?: AdminBackendClient;
}

export interface RunningAdminServer {
  url: string;
  close(): Promise<void>;
}

interface AdminSession {
  csrfToken: string;
  expiresAt: number;
  runtimeConfirmation?: {
    token: string;
    expiresAt: number;
  };
  securityConfirmation?: {
    token: string;
    expiresAt: number;
  };
}

export interface AdminRuntimeController {
  backendStatus(): Promise<BackendRuntimeStatus>;
  restartBackend(): Promise<BackendRuntimeOperation>;
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
  const startedAt = new Date().toISOString();
  const version = DEVSPACE_VERSION;
  const initialConfig = loadConfigForAdmin(env);
  const logging = initialConfig.logging;
  const runtimeManager = options.runtimeManager ?? new AdminRuntimeManager({
    env,
    probeReady: () => probeBackendReadiness(initialConfig.host, initialConfig.port),
    onEvent: (event, fields) => logEvent(logging, "info", event, fields),
  });
  const backendClient = options.backendClient ?? new HttpAdminBackendClient({
    port: initialConfig.controlPort,
    keys: initialConfig.oauth.keys,
    processShutdownGraceMs: initialConfig.resources.processShutdownGraceMs,
  });
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
          runtimeManager,
          backendClient,
          startedAt,
          version,
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

  // Root-policy reload waits for bounded SIGTERM/SIGKILL cleanup (up to roughly
  // two process grace periods), so the local admin request must outlive it.
  server.requestTimeout = Math.min(
    2_147_000_000,
    Math.max(20_000, initialConfig.resources.processShutdownGraceMs * 2 + 10_000),
  );
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
    runtimeManager: AdminRuntimeController;
    backendClient: AdminBackendClient;
    startedAt: string;
    version: string;
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
    const [mcp, tunnel, backend] = await Promise.all([
      probeMcpReady(config.host, config.port),
      probePublicTunnel(config.publicBaseUrl, config.host, config.port),
      context.runtimeManager.backendStatus(),
    ]);
    const backendWithConfirmation = backend.managed && backend.actions.includes("restart")
      ? { ...backend, ...runtimeConfirmation(session) }
      : backend;
    sendJson(response, 200, {
      configPath: devspaceConfigPath(context.env),
      publicBaseUrl: redactUrlCredentials(config.publicBaseUrl),
      admin: { ready: true, version: context.version, startedAt: context.startedAt },
      mcp,
      tunnel,
      runtime: { backend: backendWithConfirmation },
    });
    return;
  }
  if (pathname === "/api/config" && request.method === "GET") {
    const snapshot = await loadAdminConfigSnapshot(context.env);
    response.setHeader("ETag", quoteEtag(snapshot.revision));
    sendJson(response, 200, {
      config: snapshot.config,
      revision: snapshot.revision,
      rootsRevision: allowedRootsRevision(snapshot.config.allowedRoots),
      overrides: adminConfigOverridePaths(context.env),
      warnings: adminConfigWarnings(snapshot.config),
    });
    return;
  }
  if (pathname === "/api/diagnostics" && request.method === "GET") {
    try {
      sendJson(response, 200, {
        diagnostics: redactDiagnosticValue(await context.backendClient.diagnostics()),
        security: securityConfirmation(session),
      });
    } catch (error) {
      throwBackendProxyError(error);
    }
    return;
  }
  if (pathname === "/api/diagnostics/bundle" && request.method === "GET") {
    try {
      const config = (await loadAdminConfigSnapshot(context.env)).config;
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="devspace-diagnostics-${new Date().toISOString().slice(0, 10)}.json"`,
      );
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        admin: { version: context.version, startedAt: context.startedAt },
        config: {
          widgets: config.widgets,
          allowedRootCount: config.allowedRoots.length,
          projectDocFallbackFilenameCount: config.projectDocFallbackFilenames.length,
          resources: config.resources,
        },
        backend: redactDiagnosticValue(await context.backendClient.diagnostics()),
      });
    } catch (error) {
      throwBackendProxyError(error);
    }
    return;
  }
  if (pathname === "/api/runtime/backend/restart" && request.method === "POST") {
    const csrfToken = singleHeader(request, CSRF_HEADER);
    if (!csrfToken || !secretsEqual(csrfToken, session.csrfToken)) {
      throw new HttpError(403, "invalid_csrf", "The CSRF token is invalid.");
    }
    const body = await readJsonBody(request);
    const confirmation = session.runtimeConfirmation;
    session.runtimeConfirmation = undefined;
    if (
      !isRecord(body) ||
      body.confirmation !== "restart" ||
      typeof body.confirmationToken !== "string" ||
      !confirmation ||
      confirmation.expiresAt <= Date.now() ||
      !secretsEqual(body.confirmationToken, confirmation.token)
    ) {
      throw new HttpError(
        409,
        "invalid_runtime_confirmation",
        "The backend restart confirmation is invalid or expired. Refresh status and try again.",
      );
    }
    try {
      const operation = await context.runtimeManager.restartBackend();
      sendJson(response, 202, { operation });
    } catch (error) {
      if (!(error instanceof AdminRuntimeError)) throw error;
      throw new HttpError(error.status, error.code, error.message);
    }
    return;
  }
  if (pathname === "/api/config" && request.method === "PUT") {
    const csrfToken = singleHeader(request, CSRF_HEADER);
    if (!csrfToken || !secretsEqual(csrfToken, session.csrfToken)) {
      throw new HttpError(403, "invalid_csrf", "The CSRF token is invalid.");
    }
    const ifMatch = parseIfMatch(singleHeader(request, "if-match"));
    if (!ifMatch) {
      throw new HttpError(428, "revision_required", "If-Match is required to update configuration.");
    }
    const body = await readJsonBody(request);
    if (!isRecord(body) || !("config" in body)) {
      throw new HttpError(400, "invalid_config", "The request must contain a config object.");
    }
    try {
      const saved = await saveAdminConfigIfMatch(body.config, ifMatch, context.env);
      let rootsReloaded = !saved.rootsChanged;
      if (saved.rootsChanged) {
        try {
          await context.backendClient.reloadAllowedRoots();
          rootsReloaded = true;
        } catch (error) {
          if (!(error instanceof AdminBackendProxyError)) throw error;
        }
      }
      response.setHeader("ETag", quoteEtag(saved.revision));
      sendJson(response, 200, {
        ...saved,
        rootsRevision: allowedRootsRevision(saved.config.allowedRoots),
        rootsReloaded,
        restartRequired: saved.restartRequired || !rootsReloaded,
        overrides: adminConfigOverridePaths(context.env),
        warnings: adminConfigWarnings(saved.config),
      });
    } catch (error) {
      if (error instanceof AdminConfigConflictError) {
        response.setHeader("ETag", quoteEtag(error.currentRevision));
        throw new HttpError(412, "revision_conflict", "The configuration changed. Reload it before saving again.");
      }
      if (error instanceof AdminConfigLockError) {
        throw new HttpError(503, "config_locked", error.message);
      }
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
  if (pathname === "/api/security/revoke" && request.method === "POST") {
    const csrfToken = singleHeader(request, CSRF_HEADER);
    if (!csrfToken || !secretsEqual(csrfToken, session.csrfToken)) {
      throw new HttpError(403, "invalid_csrf", "The CSRF token is invalid.");
    }
    const body = await readJsonBody(request);
    const confirmation = session.securityConfirmation;
    session.securityConfirmation = undefined;
    if (
      !isRecord(body) ||
      body.confirmation !== "revoke_all_clients_and_tokens" ||
      typeof body.confirmationToken !== "string" ||
      !confirmation ||
      confirmation.expiresAt <= Date.now() ||
      !secretsEqual(body.confirmationToken, confirmation.token)
    ) {
      throw new HttpError(409, "invalid_security_confirmation", "The revoke confirmation is invalid or expired.");
    }
    try {
      sendJson(response, 200, { result: await context.backendClient.revokeAllClientsAndTokens() });
    } catch (error) {
      throwBackendProxyError(error);
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
  latencyMs: number;
  checkedAt: string;
}> {
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();
  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (result: { ready: boolean; status: number | null; error?: "unreachable" }): void => {
      if (settled) return;
      settled = true;
      resolveProbe({
        ...result,
        latencyMs: Math.round(performance.now() - startedAt),
        checkedAt,
      });
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

async function probePublicTunnel(
  publicBaseUrl: string,
  localHost: string,
  localPort: number,
): Promise<{
  configured: boolean;
  reachable: boolean;
  ready: boolean;
  status: number | null;
  hostname?: string;
  error?: "unreachable" | "unsafe_destination";
  latencyMs?: number;
}> {
  const url = new URL(publicBaseUrl);
  const configured = !isLocalPublicUrl(url, localHost, localPort);
  if (!configured) {
    return {
      configured: false,
      reachable: false,
      ready: false,
      status: null,
      hostname: url.hostname,
    };
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/readyz`;
  const startedAt = performance.now();
  let endpoint: { address: string; family: 4 | 6 };
  try {
    const addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
    if (
      addresses.length === 0 ||
      addresses.some((address) => !isPublicProbeAddress(address.address))
    ) {
      return {
        configured: true,
        reachable: false,
        ready: false,
        status: null,
        hostname: url.hostname,
        latencyMs: Math.round(performance.now() - startedAt),
        error: "unsafe_destination",
      };
    }
    endpoint = {
      address: addresses[0].address,
      family: addresses[0].family === 6 ? 6 : 4,
    };
  } catch {
    return {
      configured: true,
      reachable: false,
      ready: false,
      status: null,
      hostname: url.hostname,
      latencyMs: Math.round(performance.now() - startedAt),
      error: "unreachable",
    };
  }
  const pinnedLookup = createPinnedLookup(endpoint);

  return new Promise((resolveProbe) => {
    let settled = false;
    const finish = (result: {
      reachable: boolean;
      ready: boolean;
      status: number | null;
      error?: "unreachable" | "unsafe_destination";
    }): void => {
      if (settled) return;
      settled = true;
      resolveProbe({
        configured: true,
        hostname: url.hostname,
        latencyMs: Math.round(performance.now() - startedAt),
        ...result,
      });
    };
    const get = url.protocol === "https:" ? httpsGet : httpGet;
    const probe = get(url, {
      timeout: 3_000,
      lookup: pinnedLookup,
    }, (probeResponse) => {
      probeResponse.resume();
      const status = probeResponse.statusCode ?? null;
      finish({ reachable: true, ready: status === 200, status });
    });
    probe.on("timeout", () => probe.destroy());
    probe.on("error", () => finish({
      reachable: false,
      ready: false,
      status: null,
      error: "unreachable",
    }));
  });
}

export function isPublicProbeAddress(address: string): boolean {
  const mappedIpv4 = ipv4MappedAddress(address);
  if (mappedIpv4) return isPublicProbeAddress(mappedIpv4);
  const family = isIP(address);
  if (family === 0) return false;
  return !unsafeProbeAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function ipv4MappedAddress(address: string): string | undefined {
  if (isIP(address) !== 6 || address.includes("%")) return undefined;
  const hextets = expandIpv6Hextets(address);
  if (
    !hextets ||
    hextets.slice(0, 5).some((part) => part !== 0) ||
    hextets[5] !== 0xffff
  ) return undefined;
  const high = hextets[6];
  const low = hextets[7];
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function expandIpv6Hextets(address: string): number[] | undefined {
  let source = address.toLowerCase();
  if (source.includes(".")) {
    const separator = source.lastIndexOf(":");
    const octets = source.slice(separator + 1).split(".").map(Number);
    if (
      separator < 0 ||
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) return undefined;
    source = `${source.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => Number.parseInt(group, 16));
}

export function createPinnedLookup(endpoint: {
  address: string;
  family: 4 | 6;
}): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ ...endpoint }]);
    else callback(null, endpoint.address, endpoint.family);
  };
}

function createUnsafeProbeBlockList(): BlockList {
  const blockList = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
    ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
    ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4], ["240.0.0.0", 4],
  ] as const) {
    blockList.addSubnet(network, prefix, "ipv4");
  }
  for (const [network, prefix] of [
    ["::", 128], ["::1", 128], ["64:ff9b:1::", 48],
    ["100::", 64], ["2001:2::", 48], ["2001:db8::", 32],
    ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ] as const) {
    blockList.addSubnet(network, prefix, "ipv6");
  }
  return blockList;
}

function probeHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function isLocalPublicUrl(url: URL, host: string, port: number): boolean {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", probeHost(host)]);
  const effectivePort = url.port || (url.protocol === "https:" ? "443" : "80");
  return localHosts.has(url.hostname) && effectivePort === String(port);
}

function runtimeConfirmation(session: AdminSession): {
  confirmationToken: string;
  confirmationExpiresAt: string;
} {
  if (!session.runtimeConfirmation || session.runtimeConfirmation.expiresAt <= Date.now()) {
    session.runtimeConfirmation = {
      token: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + RUNTIME_CONFIRMATION_TTL_MS,
    };
  }
  return {
    confirmationToken: session.runtimeConfirmation.token,
    confirmationExpiresAt: new Date(session.runtimeConfirmation.expiresAt).toISOString(),
  };
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

function quoteEtag(revision: string): string {
  return `"${revision}"`;
}

function parseIfMatch(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^"([A-Za-z0-9_-]{43})"$/.exec(value.trim())?.[1];
}

function securityConfirmation(session: AdminSession): {
  confirmationToken: string;
  confirmationExpiresAt: string;
} {
  if (!session.securityConfirmation || session.securityConfirmation.expiresAt <= Date.now()) {
    session.securityConfirmation = {
      token: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + SECURITY_CONFIRMATION_TTL_MS,
    };
  }
  return {
    confirmationToken: session.securityConfirmation.token,
    confirmationExpiresAt: new Date(session.securityConfirmation.expiresAt).toISOString(),
  };
}

function throwBackendProxyError(error: unknown): never {
  if (error instanceof AdminBackendProxyError) {
    throw new HttpError(error.status, error.code, error.message);
  }
  throw error;
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
