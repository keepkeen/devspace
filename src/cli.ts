#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import { satisfies } from "semver";
import { DEVSPACE_VERSION, SUPPORTED_NODE_RANGE } from "./version.js";
import { loadConfig } from "./config.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import {
  isLocalAgentProvider,
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import {
  assertLocalAgentProviderAvailable,
  formatLocalAgentProviderAvailabilitySummary,
} from "./local-agent-availability.js";
import {
  formatAvailableLocalAgentTargets,
  parseLocalAgentRunArgs,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import { createLocalAgentStore, type LocalAgentRecord } from "./local-agent-store.js";
import {
  readLocalAgentOutput,
  removeLocalAgentOutputSync,
  writeLocalAgentOutput,
} from "./local-agent-output.js";
import {
  localAgentWorkerSpawnOptions,
  shouldUnrefLocalAgentWorker,
} from "./local-agent-worker.js";
import type { LocalAgentRunResult } from "./local-agent-runtime.js";
import {
  cleanupDetachedAgentPromptArtifacts,
  removeDetachedAgentPrompt,
} from "./detached-agent-cleanup.js";
import {
  createDevspaceAuth,
  ensureDevspaceDefaultSkills,
  generateOwnerToken,
  loadDevspaceFiles,
  resolveSubagentsFlag,
  writeDevspaceAuth,
  writeDevspaceConfig,
  updateDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { assertAllowedDirectory, expandHomePath } from "./roots.js";
import { shutdownHttpServers } from "./server-shutdown.js";
import { AuditEventStore, type AuditEventQuery } from "./audit-events.js";
import { formatChinaTimestamp } from "./logger.js";
import { inspectInstructionHealth } from "./instruction-health.js";
import { inspectDoctorOAuthState } from "./doctor-oauth.js";

type Command = "serve" | "admin" | "init" | "doctor" | "config" | "auth" | "audit" | "agents" | "help" | "version";
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
    case "auth":
      await ensureConfigured();
      await runAuthCommand(args);
      return;
    case "audit":
      await ensureConfigured();
      runAuditCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
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
    command === "audit" ||
    command === "agents"
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
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
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
      subagents: resolveSubagentsFlag(files.config),
    };
    const displayedOwnerPassword = files.auth.ownerPasswordHash
      ? files.migratedOwnerPassword
      : generateOwnerToken();
    const auth = files.auth.ownerPasswordHash
      ? files.auth
      : createDevspaceAuth(displayedOwnerPassword!);

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);
    const seededSkillPaths = config.subagents ? ensureDevspaceDefaultSkills() : [];

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      ...seededSkillPaths.map((path) => `Default skill: ${path}`),
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    if (displayedOwnerPassword) {
      prompts.note(
        [
          `Owner password: ${displayedOwnerPassword}`,
          "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
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
  const { app, controlApp, config, beginClose, close, localAgentProviders } = createServer();
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log("auth: Owner password approval required");
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });
  const controlServer = controlApp.listen(config.controlPort, "127.0.0.1", () => {
    console.log(`local control plane: http://127.0.0.1:${config.controlPort}`);
  });

  // A bind failure would otherwise be an unhandled 'error' event that exits the
  // process with the databases open and the singleton locks held. A second
  // instance collides on both ports, so this runs once and closes the listener
  // that did bind rather than leaving it accepting connections while draining.
  let listenFailureHandled = false;
  const listenerFailed = (listener: "public" | "control", error: unknown) => {
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
        "Adding an allowed root expands those grants; reconnect them through OAuth and select explicit project roots.",
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

  throw new Error("Supported config keys: publicBaseUrl.");
}

async function runAuthCommand(args: string[]): Promise<void> {
  const [subcommand, ...rawRest] = args;
  const apply = rawRest.includes("--apply");
  const rest = rawRest.filter((entry) => entry !== "--apply");
  const config = loadConfig();
  const { SqliteOAuthStore } = await import("./oauth-store.js");
  const store = new SqliteOAuthStore(config.stateDir);
  try {
    switch (subcommand) {
      case "principals":
      case "ls":
      case "list": {
        const principals = store.listConnectionPrincipals();
        if (principals.length === 0) {
          console.log("No active connection principals.");
          return;
        }
        for (const principal of principals) {
          const aliases = principal.aliases.length > 0
            ? ` aliases=${principal.aliases.join(",")}`
            : "";
          console.log(
            `${principal.principalId} clients=${principal.clientCount}` +
              ` activeWorkspaces=${principal.activeWorkspaces}` +
              ` retainedWorkspaces=${principal.retainedWorkspaces}${aliases}`,
          );
        }
        return;
      }
      case "reconnect-code": {
        const [principalId, ...unexpected] = rest;
        if (unexpected.length > 0) throw new Error(`Unexpected auth argument: ${unexpected[0]}`);
        if (!principalId) {
          throw new Error("`devspace auth reconnect-code` requires a connection principal ID.");
        }
        const issued = store.issueReconnectCode(principalId);
        console.log(`Reconnect code: ${issued.code}`);
        console.log(`Principal: ${issued.principalId}`);
        console.log(`Expires: ${issued.expiresAt}`);
        console.log("Enter this code once on the DevSpace OAuth approval page for the new connector registration.");
        return;
      }
      case "transfer-workspaces": {
        const [sourcePrincipalId, targetPrincipalId, ...unexpected] = rest;
        if (!sourcePrincipalId || !targetPrincipalId || unexpected.length > 0) {
          throw new Error(
            "Usage: devspace auth transfer-workspaces <source-principal> <target-principal> [--apply]",
          );
        }
        const preview = store.previewWorkspaceTransfer(sourcePrincipalId, targetPrincipalId);
        console.log(JSON.stringify({ action: "transfer-workspaces", apply, preview }, null, 2));
        if (!apply) {
          console.log("Dry run only. Add --apply after reviewing conflicts and counts.");
          return;
        }
        if (!preview.transferable) {
          throw new Error("Workspace transfer is not safe; resolve the reported conflicts first.");
        }
        await assertBackendStopped(config);
        console.log(JSON.stringify({
          action: "transfer-workspaces",
          result: store.transferPrincipalWorkspaces(sourcePrincipalId, targetPrincipalId),
        }, null, 2));
        return;
      }
      case "close-orphan": {
        const [principalId, ...unexpected] = rest;
        if (!principalId || unexpected.length > 0) {
          throw new Error("Usage: devspace auth close-orphan <principal-id> [--apply]");
        }
        const preview = store.previewOrphanClose(principalId);
        console.log(JSON.stringify({ action: "close-orphan", apply, preview }, null, 2));
        if (!apply) {
          console.log("Dry run only. Add --apply to close active records without deleting worktrees.");
          return;
        }
        if (!preview.closable) throw new Error("The principal still has an active OAuth client.");
        await assertBackendStopped(config);
        console.log(JSON.stringify({
          action: "close-orphan",
          result: store.closeOrphanPrincipal(principalId),
        }, null, 2));
        return;
      }
      case "relink-client": {
        const [clientId, targetPrincipalId, ...unexpected] = rest;
        if (!clientId || !targetPrincipalId || unexpected.length > 0) {
          throw new Error(
            "Usage: devspace auth relink-client <oauth-client-id> <target-principal> [--apply]",
          );
        }
        const preview = store.previewClientRelink(clientId, targetPrincipalId);
        console.log(JSON.stringify({ action: "relink-client", apply, preview }, null, 2));
        if (!apply) {
          console.log("Dry run only. Add --apply to revoke current tokens and relink the client.");
          return;
        }
        if (!preview.relinkable) {
          throw new Error("Transfer or close the source principal's retained Workspaces first.");
        }
        await assertBackendStopped(config);
        console.log(JSON.stringify({
          action: "relink-client",
          result: store.relinkClientToPrincipal(clientId, targetPrincipalId),
        }, null, 2));
        return;
      }
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printAuthHelp();
        return;
      default:
        throw new Error(`Unknown auth command: ${subcommand}`);
    }
  } finally {
    store.close();
  }
}

function printAuthHelp(): void {
  console.log([
    "DevSpace connection principals",
    "",
    "Usage:",
    "  devspace auth principals",
    "  devspace auth reconnect-code <principal-id>",
    "  devspace auth transfer-workspaces <source> <target> [--apply]",
    "  devspace auth close-orphan <principal-id> [--apply]",
    "  devspace auth relink-client <oauth-client-id> <target> [--apply]",
    "",
    "Mutation commands are dry-run by default and require the backend to be stopped",
    "when --apply is used. OAuth approval can also reuse a principal locally after",
    "Owner-password verification. A principal is not a verified ChatGPT identity.",
  ].join("\n"));
}

function runAuditCommand(args: string[]): void {
  const config = loadConfig();
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
      case "--workspace-activity": query.workspaceActivityRef = value; break;
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
        event.workspaceActivityRef ? `workspace=${event.workspaceActivityRef}` : "",
        event.errorCode ? `error=${event.errorCode}` : "",
        Object.keys(event.details).length > 0 ? `details=${JSON.stringify(event.details)}` : "",
      ].filter(Boolean).join(" "));
    }
  } finally {
    store.close();
  }
}

async function assertBackendStopped(config: ReturnType<typeof loadConfig>): Promise<void> {
  const host = config.host === "0.0.0.0" || config.host === "localhost"
    ? "127.0.0.1"
    : config.host === "::"
      ? "::1"
      : config.host;
  const running = await new Promise<boolean>((resolveProbe) => {
    const request = httpGet({ host, port: config.port, path: "/readyz", timeout: 500 }, (response) => {
      response.resume();
      resolveProbe(response.statusCode === 200);
    });
    request.on("timeout", () => {
      request.destroy();
      resolveProbe(false);
    });
    request.on("error", () => resolveProbe(false));
  });
  if (running) {
    throw new Error(
      "Stop the DevSpace backend before applying principal state changes, then rerun this command.",
    );
  }
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
      "  devspace auth principals List local connection principals",
      "  devspace auth reconnect-code <principal-id>",
      "  devspace auth transfer-workspaces <source> <target> [--apply]",
      "  devspace auth close-orphan <principal-id> [--apply]",
      "  devspace auth relink-client <oauth-client-id> <target> [--apply]",
      "  devspace audit [filters] Query persistent safe audit events in China time",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] <prompt>",
      "  devspace agents show <id>",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

async function runAgentsCommand(args: string[]): Promise<void> {
  await cleanupDetachedAgentPromptArtifacts();
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList();
      return;
    case "run":
      await runAgentsRun(rest);
      return;
    case "show":
      await runAgentsShow(rest);
      return;
    case "__worker":
      await runAgentsWorker(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsList(): Promise<void> {
  const config = loadConfig();
  const workspaceRoot = resolveCurrentWorkspaceRoot(config.allowedRoots);
  const store = createLocalAgentStore(config);
  store.cleanup();
  const agents = store.list(resolveCurrentWorkspaceScope(workspaceRoot));

  if (agents.length === 0) {
    console.log("No subagent sessions found for this workspace.");
    return;
  }

  for (const agent of agents) {
    console.log(formatAgentLine(agent));
  }
}

async function runAgentsRun(args: string[]): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);

  const config = loadConfig();
  const workspaceRoot = resolveCurrentWorkspaceRoot(config.allowedRoots);
  const workspaceScope = resolveCurrentWorkspaceScope(workspaceRoot);
  const store = createLocalAgentStore(config);
  store.cleanup();
  const existing = store.get(parsed.target, workspaceScope);

  if (existing) {
    if (!isLocalAgentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
    }
    assertLocalAgentProviderAvailable(existing.provider);
    const promptFile = writeAgentPromptFile(parsed.prompt);
    try {
      removeLocalAgentOutputSync(config.stateDir, existing.id);
      store.update(existing.id, {
        status: "starting",
        model: parsed.model ?? existing.model,
        thinking: parsed.thinking ?? existing.thinking,
        latestResponse: undefined,
        error: undefined,
      });
      spawnAgentWorker(existing.id, promptFile);
    } catch (error) {
      await removeDetachedAgentPrompt(promptFile);
      throw error;
    }
    console.log(formatAgentLine({
      ...existing,
      status: "running",
      model: parsed.model ?? existing.model,
      thinking: parsed.thinking ?? existing.thinking,
    }));
    return;
  }

  const profiles = await loadLocalAgentProfiles(config, workspaceRoot);
  const target = resolveLocalAgentTarget(parsed.target, profiles, parsed.model, parsed.thinking);
  if (!target) {
    throw new Error(
      `Unknown subagent profile, provider, or id: ${parsed.target}. Available ${formatAvailableLocalAgentTargets(profiles)}`,
    );
  }
  assertLocalAgentProviderAvailable(target.provider);

  const promptFile = writeAgentPromptFile(parsed.prompt);
  let record: LocalAgentRecord;
  try {
    record = store.create({
      workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
      workspaceRoot,
      profileName: target.name,
      provider: target.provider,
      model: target.model,
      thinking: target.thinking,
    });
    spawnAgentWorker(record.id, promptFile);
  } catch (error) {
    await removeDetachedAgentPrompt(promptFile);
    throw error;
  }
  console.log(formatAgentLine({ ...record, status: "running" }));
}

async function runAgentsShow(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace agents show <id>");

  const config = loadConfig();
  const workspaceRoot = resolveCurrentWorkspaceRoot(config.allowedRoots);
  const workspaceScope = resolveCurrentWorkspaceScope(workspaceRoot);
  const store = createLocalAgentStore(config);
  store.cleanup();
  let record = store.get(id, workspaceScope);
  if (!record) throw new Error(`Unknown subagent id: ${id}`);

  const deadline = Date.now() + 15_000;
  while ((record.status === "starting" || record.status === "running") && Date.now() < deadline) {
    await sleep(500);
    record = store.get(id, workspaceScope) ?? record;
  }

  console.log(formatAgentLine(record));
  const retainedOutput = readLocalAgentOutput(config.stateDir, record.id);
  if (retainedOutput !== undefined) {
    output.write(retainedOutput);
    if (!retainedOutput.endsWith("\n")) output.write("\n");
    return;
  }
  if (record.latestResponse) {
    console.log(record.latestResponse);
    return;
  }
  if (record.error) {
    console.log(record.error);
    return;
  }
  if (record.status === "starting" || record.status === "running") {
    console.log(`No final response yet. Call \`devspace agents show ${record.id}\` again later.`);
  }
}

async function runAgentsWorker(args: string[]): Promise<void> {
  const [id, promptFileFlag, promptFile] = args;
  if (!id || promptFileFlag !== "--prompt-file" || !promptFile) {
    throw new Error("Usage: devspace agents __worker <id> --prompt-file <path>");
  }

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  try {
    store.cleanup();
    const record = store.getForWorker(id);
    if (!record) throw new Error(`Unknown subagent id: ${id}`);
    // The worker learns its workspace from the record, so the recorded root has
    // to be confined here. Otherwise a stale or hand-written row could run an
    // agent rooted outside every authorized project.
    const workspaceRoot = assertAllowedDirectory(record.workspaceRoot, config.allowedRoots);
    const effectiveRecord = { ...record, workspaceRoot };

    store.update(record.id, { workspaceRoot, status: "running", error: undefined });
    try {
      const profiles = await loadLocalAgentProfiles(config, workspaceRoot);
      const profile = profiles.find((candidate) => candidate.name === effectiveRecord.profileName);
      const prompt = await readFile(promptFile, "utf8");
      const result = profile
        ? await runLocalAgentProfile(profile, effectiveRecord, prompt)
        : await runRawLocalAgentProvider(effectiveRecord, prompt);
      writeLocalAgentOutput(config.stateDir, effectiveRecord.id, result.finalResponse);
      store.update(effectiveRecord.id, {
        providerSessionId: result.providerSessionId ?? undefined,
        status: "idle",
        latestResponse: result.finalResponse,
        error: undefined,
      });
    } catch (error) {
      removeLocalAgentOutputSync(config.stateDir, effectiveRecord.id);
      store.update(effectiveRecord.id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    await removeDetachedAgentPrompt(promptFile);
  }
}

async function runLocalAgentProfile(
  profile: LocalAgentProfile,
  record: LocalAgentRecord,
  prompt: string,
): Promise<LocalAgentRunResult> {
  const body = profile.body.trim();
  const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
  return runLocalAgentProvider(profile.provider, {
    prompt: fullPrompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "allowed",
    model: record.model ?? profile.model,
    thinking: record.thinking ?? profile.thinking,
  });
}

async function runRawLocalAgentProvider(
  record: LocalAgentRecord,
  prompt: string,
): Promise<LocalAgentRunResult> {
  if (record.profileName !== record.provider || !isLocalAgentProvider(record.provider)) {
    throw new Error(`Subagent profile not found: ${record.profileName}`);
  }

  return runLocalAgentProvider(record.provider, {
    prompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "allowed",
    model: record.model,
    thinking: record.thinking,
  });
}

function spawnAgentWorker(agentId: string, promptFile: string): void {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "agents",
    "__worker",
    agentId,
    "--prompt-file",
    promptFile,
  ], localAgentWorkerSpawnOptions(process.env));
  child.once("error", () => {
    void removeDetachedAgentPrompt(promptFile);
  });
  if (shouldUnrefLocalAgentWorker()) child.unref();
}

function writeAgentPromptFile(prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
  const filePath = join(directory, "prompt.txt");
  writeFileSync(filePath, prompt, { mode: 0o600 });
  return filePath;
}

function resolveCurrentWorkspaceRoot(allowedRoots?: string[]): string {
  const workspaceRoot = resolve(process.env.DEVSPACE_WORKSPACE_ROOT || process.cwd());
  // DEVSPACE_WORKSPACE_ROOT is only protected on the MCP `environment` input, so
  // any other entry point could otherwise root a subagent outside every
  // authorized project.
  return allowedRoots ? assertAllowedDirectory(workspaceRoot, allowedRoots) : workspaceRoot;
}

function resolveCurrentWorkspaceScope(
  workspaceRoot = resolveCurrentWorkspaceRoot(),
): { workspaceId?: string; workspaceRoot: string } {
  return {
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
    workspaceRoot,
  };
}

function formatAgentLine(agent: Pick<
  LocalAgentRecord,
  "id" | "status" | "profileName" | "provider" | "model" | "thinking"
>): string {
  const model = agent.model ? ` ${agent.model}` : "";
  const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
  return `${agent.id} ${agent.status} ${agent.profileName} ${agent.provider}${model}${thinking}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] <prompt>",
      "  devspace agents show <id>",
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
