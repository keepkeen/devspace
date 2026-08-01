#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { get as httpGet } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import { satisfies } from "semver";
import { DEVSPACE_VERSION, SUPPORTED_NODE_RANGE } from "./version.js";
import { loadConfig } from "./config.js";
import {
  createDevspaceAuth,
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  updateDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { shutdownHttpServers } from "./server-shutdown.js";
import { AuditEventStore, type AuditEventQuery } from "./audit-events.js";
import { formatChinaTimestamp, identifierHash } from "./logger.js";
import { inspectInstructionHealth } from "./instruction-health.js";
import { inspectDoctorOAuthState } from "./doctor-oauth.js";
import { internalDiagnosticsToken } from "./internal-auth.js";

type Command = "serve" | "admin" | "init" | "doctor" | "config" | "auth" | "audit" | "help" | "version";
const require = createRequire(import.meta.url);

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "admin":
      await ensureConfigured();
      await runAdmin(args);
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "audit":
      await ensureConfigured();
      await runAuditCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (
    command === "admin" ||
    command === "init" ||
    command === "doctor" ||
    command === "config" ||
    command === "auth" ||
    command === "audit"
  ) return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      ...files.config,
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
    };
    const displayedOwnerPassword = files.auth.ownerPasswordHash
      ? files.migratedOwnerPassword
      : generateOwnerToken();
    const auth = files.auth.ownerPasswordHash
      ? files.auth
      : createDevspaceAuth(displayedOwnerPassword!);

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    if (displayedOwnerPassword) {
      prompts.note(
        [
          `Owner password: ${displayedOwnerPassword}`,
          "Use this when ChatGPT asks you to approve DevSpace access.",
          "The password is shown only during creation or legacy migration; only its Argon2id hash is stored.",
          `Stored verifier and master key: ${authPath}`,
        ].join("\n"),
        "Owner password",
      );
    } else {
      prompts.note(
        [
          "Existing Owner password verifier and master key were preserved.",
          "DevSpace cannot recover or display the existing Owner password.",
          `Stored at: ${authPath}`,
        ].join("\n"),
        "Owner password",
      );
    }
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const {
    app,
    controlApp,
    config,
    setListenerBound,
    beginClose,
    close,
  } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    setListenerBound("public", true);
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
  });
  const controlServer = controlApp.listen(config.controlPort, "127.0.0.1", () => {
    setListenerBound("control", true);
    console.log(`local control plane: http://127.0.0.1:${config.controlPort}`);
  });

  // A bind failure would otherwise be an unhandled 'error' event that exits the
  // process with the databases open and the singleton locks held. A second
  // instance collides on both ports, so this runs once and closes the listener
  // that did bind rather than leaving it accepting connections while draining.
  let listenFailureHandled = false;
  const listenerFailed = (listener: "public" | "control", error: unknown) => {
    setListenerBound(listener, false);
    const code = error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    const bindFailure = code === "EADDRINUSE" || code === "EACCES" || code === "EADDRNOTAVAIL";
    if (listenFailureHandled) return;
    listenFailureHandled = true;
    const port = listener === "control" ? config.controlPort : config.port;
    console.error(
      bindFailure
        ? `devspace could not bind the ${listener} listener on port ${port}:`
        : `devspace ${listener} listener failed after startup on port ${port}:`,
      error,
    );
    httpServer.close();
    controlServer.close();
    void beginClose()
      .then(close)
      .catch((closeError) => console.error("devspace shutdown failed", closeError))
      .finally(() => process.exit(1));
  };
  httpServer.on("close", () => setListenerBound("public", false));
  controlServer.on("close", () => setListenerBound("control", false));
  httpServer.on("error", (error) => listenerFailed("public", error));
  controlServer.on("error", (error) => listenerFailed("control", error));

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await beginClose();
    await shutdownHttpServers(
      [httpServer, controlServer],
      close,
      config.resources.httpDrainTimeoutMs,
    );
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runAdmin(args: string[]): Promise<void> {
  let port = 0;
  let openBrowser = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (argument === "--port") {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value)) {
        throw new Error("`devspace admin --port` requires a port number.");
      }
      port = Number(value);
      if (port < 1 || port > 65_535) throw new Error(`Invalid admin port: ${value}`);
      index += 1;
      continue;
    }
    throw new Error(`Unknown admin option: ${argument}`);
  }

  const { startAdminServer } = await import("./admin-server.js");
  const admin = await startAdminServer({ port });
  console.log(`DevSpace local admin: ${admin.url}`);
  console.log("Keep this terminal open while using the panel. Press Ctrl-C to stop it.");
  if (openBrowser) openLocalUrl(admin.url);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void admin.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function openLocalUrl(url: string): void {
  const command = process.platform === "darwin"
    ? { executable: "open", args: [url] }
    : process.platform === "win32"
      ? { executable: "cmd", args: ["/c", "start", "", url] }
      : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", (error) => {
    console.warn(`Could not open the browser automatically: ${error.message}`);
  });
  child.unref();
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
    console.log(
      `Master key: ${config.oauth.keys.derivation} ` +
      `(${config.oauth.keys.source}, ${config.oauth.keys.masterKeyFingerprint})`,
    );
    if (config.oauth.keys.legacyCompatibility) {
      console.log(
        "Security warning: master key uses legacy-direct compatibility. " +
        "Rotate it only during a planned global reauthorization.",
      );
    }
    const oauthInspection = inspectDoctorOAuthState(config.stateDir);
    if (oauthInspection.schemaVersion !== undefined) {
      console.log(`Canonical database schema: v${oauthInspection.schemaVersion}`);
    }
    if (oauthInspection.error) {
      console.log("OAuth grant diagnostics: unavailable (read-only inspection failed).");
    } else if ((oauthInspection.legacyWildcardGrants ?? 0) > 0) {
      console.log(
        `Security warning: ${oauthInspection.legacyWildcardGrants} active legacy wildcard root grant(s) found. ` +
        "Adding an allowed root expands those grants; reauthorize through OAuth and select explicit project roots.",
      );
    }
    if (oauthInspection.projectExecutions) {
      console.log(
        `Project execution inventory: ${oauthInspection.projectExecutions.total} total, `
        + `${oauthInspection.projectExecutions.open} open, `
        + `${oauthInspection.projectExecutions.terminal} terminal`,
      );
    }
    if (oauthInspection.migrationBackups) {
      console.log(
        `Database migration backups: ${oauthInspection.migrationBackups.count}; `
        + `latest=${join(config.stateDir, oauthInspection.migrationBackups.latest)}`,
      );
    }
    const instructionHealth = await inspectInstructionHealth(
      config.allowedRoots,
      config.projectDocFallbackFilenames,
    );
    console.log(
      `Instruction health: ${instructionHealth.instructionFiles} file(s), ` +
      `${instructionHealth.issues.length} issue(s), ` +
      `${instructionHealth.scannedDirectories} directories scanned` +
      `${instructionHealth.truncated ? " (bounded scan truncated)" : ""}`,
    );
    for (const issue of instructionHealth.issues) {
      console.log(
        `Instruction ${issue.severity} [${issue.code}]: ` +
        `${join(issue.root, issue.path)} — ${issue.message}`,
      );
    }
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  const value = rest.join(" ").trim();
  if (key === "publicBaseUrl") {
    if (!value) throw new Error("Missing publicBaseUrl value.");
    updateDevspaceConfig((config) => ({
      ...config,
      publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
    }));
    console.log(`Updated ${files.configPath}`);
    return;
  }

  if (key === "widgets") {
    if (value !== "off" && value !== "changes" && value !== "full") {
      throw new Error("widgets must be one of: off, changes, full.");
    }
    updateDevspaceConfig((config) => ({ ...config, widgets: value }));
    console.log(`Updated ${files.configPath}`);
    return;
  }

  throw new Error("Supported config keys: publicBaseUrl, widgets.");
}

interface BackendDiagnosticsSnapshot {
  version?: string;
  pid?: number;
  generation?: string;
  buildRevision?: string | null;
  observability?: {
    audit?: {
      enabled?: boolean;
      stateDirRef?: string;
      eventCount?: number;
      firstEventAt?: string;
      lastEventAt?: string;
      auditWriteFailures?: number;
      lastAuditWriteFailureAt?: string;
    };
  };
}

async function runAuditCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  if (args[0] === "health") {
    const unexpected = args.slice(1).filter((argument) => argument !== "--json");
    if (unexpected.length > 0) throw new Error(`Unknown audit health option: ${unexpected[0]}`);
    await printAuditHealth(config, args.includes("--json"));
    return;
  }
  const query: AuditEventQuery = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value after ${argument}`);
    switch (argument) {
      case "--event": query.event = value; break;
      case "--tool": query.tool = value; break;
      case "--request": query.requestId = value; break;
      case "--connection": query.connectionRef = value; break;
      case "--project-activity": query.workspaceActivityRef = value; break;
      case "--since": {
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) throw new Error("--since must be an ISO timestamp.");
        query.since = parsed.toISOString();
        break;
      }
      case "--limit": {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
          throw new Error("--limit must be an integer from 1 to 1000.");
        }
        query.limit = limit;
        break;
      }
      default: throw new Error(`Unknown audit option: ${argument}`);
    }
    index += 1;
  }
  const store = new AuditEventStore(config.stateDir);
  try {
    const events = store.query(query).map((event) => ({
      ...event,
      timeChina: formatChinaTimestamp(event.ts),
    }));
    if (json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log("No matching persistent audit events.");
      return;
    }
    for (const event of events) {
      console.log([
        event.timeChina,
        event.level.toUpperCase(),
        event.event,
        event.tool ? `tool=${event.tool}` : "",
        event.requestId ? `request=${event.requestId}` : "",
        event.connectionRef ? `connection=${event.connectionRef}` : "",
        event.workspaceActivityRef ? `project=${event.workspaceActivityRef}` : "",
        event.errorCode ? `error=${event.errorCode}` : "",
        Object.keys(event.details).length > 0 ? `details=${JSON.stringify(event.details)}` : "",
      ].filter(Boolean).join(" "));
    }
  } finally {
    store.close();
  }
}

async function printAuditHealth(
  config: ReturnType<typeof loadConfig>,
  json: boolean,
): Promise<void> {
  const store = new AuditEventStore(config.stateDir);
  let localAudit;
  try {
    localAudit = store.health();
  } finally {
    store.close();
  }
  const stateDirRef = auditStateDirRef(config);
  const backend = await fetchBackendDiagnostics(config);
  const backendAudit = backend?.observability?.audit;
  const source = sourceRevisionSnapshot();
  const generatedAt = new Date().toISOString();
  const snapshot = {
    generatedAt,
    timeChina: formatChinaTimestamp(generatedAt),
    cli: {
      version: DEVSPACE_VERSION,
      pid: process.pid,
      stateDirRef,
      auditEnabled: config.logging.auditEvents !== false,
      ...localAudit,
      sourceRevision: source.revision,
      sourceDirty: source.dirty,
    },
    backend: backend
      ? {
          reachable: true,
          version: backend.version,
          pid: backend.pid,
          generation: backend.generation,
          buildRevision: backend.buildRevision ?? null,
          audit: backendAudit,
          stateDirMatches: backendAudit?.stateDirRef
            ? backendAudit.stateDirRef === stateDirRef
            : null,
          sourceMatchesBuild: backend.buildRevision
            ? backend.buildRevision === source.revision
            : null,
        }
      : {
          reachable: false,
          stateDirMatches: null,
          sourceMatchesBuild: null,
        },
  };
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  console.log(`Generated: ${snapshot.timeChina}`);
  console.log(
    `CLI: version=${DEVSPACE_VERSION} pid=${process.pid} stateDir=${stateDirRef} ` +
      `auditEnabled=${snapshot.cli.auditEnabled} events=${localAudit.eventCount}`,
  );
  if (localAudit.firstEventAt) {
    console.log(`First event: ${formatChinaTimestamp(localAudit.firstEventAt)}`);
  }
  if (localAudit.lastEventAt) {
    console.log(`Last event: ${formatChinaTimestamp(localAudit.lastEventAt)}`);
  }
  console.log(
    `Source: revision=${source.revision ?? "unknown"} dirty=${source.dirty ?? "unknown"}`,
  );
  if (!backend) {
    console.log("Backend diagnostics: unreachable on the loopback control port.");
    return;
  }
  console.log(
    `Backend: version=${backend.version ?? "unknown"} pid=${backend.pid ?? "unknown"} ` +
      `generation=${backend.generation ?? "unknown"} stateDirMatches=${snapshot.backend.stateDirMatches}`,
  );
  console.log(
    `Backend audit: enabled=${backendAudit?.enabled ?? "unknown"} ` +
      `events=${backendAudit?.eventCount ?? "unknown"} ` +
      `writeFailures=${backendAudit?.auditWriteFailures ?? "unknown"}`,
  );
  if (backendAudit?.lastEventAt) {
    console.log(`Backend last event: ${formatChinaTimestamp(backendAudit.lastEventAt)}`);
  }
  if (backendAudit?.lastAuditWriteFailureAt) {
    console.log(
      `Last audit write failure: ${formatChinaTimestamp(backendAudit.lastAuditWriteFailureAt)}`,
    );
  }
}

function auditStateDirRef(config: ReturnType<typeof loadConfig>): string {
  const digest = identifierHash(
    config.stateDir,
    config.oauth.keys.auditReference,
    "state-dir",
  );
  return `state_${digest ?? "unknown"}`;
}

function sourceRevisionSnapshot(): { revision?: string; dirty?: boolean } {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 1_000,
  });
  if (revision.status !== 0) return {};
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 1_000,
  });
  return {
    revision: revision.stdout.trim(),
    ...(status.status === 0 ? { dirty: status.stdout.length > 0 } : {}),
  };
}

function fetchBackendDiagnostics(
  config: ReturnType<typeof loadConfig>,
): Promise<BackendDiagnosticsSnapshot | undefined> {
  const host = config.host === "0.0.0.0" || config.host === "localhost"
    ? "127.0.0.1"
    : config.host === "::"
      ? "::1"
      : config.host;
  return new Promise((resolveDiagnostics) => {
    const request = httpGet({
      host,
      port: config.controlPort,
      path: "/internal/diagnostics",
      timeout: 1_000,
      headers: {
        "x-devspace-internal-token": internalDiagnosticsToken(
          config.oauth.keys.internalDiagnostics,
        ),
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolveDiagnostics(undefined);
        return;
      }
      response.setEncoding("utf8");
      let body = "";
      response.on("data", (chunk: string) => {
        if (body.length <= 128 * 1_024) body += chunk;
      });
      response.on("end", () => {
        try {
          resolveDiagnostics(JSON.parse(body) as BackendDiagnosticsSnapshot);
        } catch {
          resolveDiagnostics(undefined);
        }
      });
    });
    request.on("timeout", () => {
      request.destroy();
      resolveDiagnostics(undefined);
    });
    request.on("error", () => resolveDiagnostics(undefined));
  });
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace admin           Open the local-only management panel",
      "  devspace admin --no-open Print the panel URL without opening a browser",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace config set widgets <off|changes|full>",
      "  devspace audit [filters] Query persistent safe audit events in China time",
      "  devspace audit health [--json] Compare CLI and backend audit health",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

function printVersion(): void {
  console.log(DEVSPACE_VERSION);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install a supported Node release (22.19 through 26) or use nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const shell = process.platform === "win32"
      ? process.env.BASH ?? "bash"
      : process.env.BASH ?? "/bin/bash";
    const args = ["-c"];
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
