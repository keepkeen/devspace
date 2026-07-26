import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratchRoot = mkdtempSync(join(tmpdir(), "devspace-pack-smoke-"));
const installRoot = join(scratchRoot, "install");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

function runNpm(args, options) {
  return npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], options)
    : execFileSync(npmCommand, args, options);
}

try {
  mkdirSync(installRoot);
  const packOutput = runNpm(["pack", "--json", "--pack-destination", scratchRoot], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [{ filename }] = JSON.parse(packOutput);
  const tarball = join(scratchRoot, filename);

  runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore" });
  runNpm(["install", tarball], {
    cwd: installRoot,
    stdio: "inherit",
  });
  assertInstalledDependencyTree(installRoot);
  await assertConsumerAuditClean(installRoot);

  const installedPackage = JSON.parse(
    readFileSync(join(installRoot, "node_modules", "@waishnav", "devspace", "package.json"), "utf8"),
  );
  const cliPath = join(installRoot, "node_modules", "@waishnav", "devspace", "dist", "cli.js");
  const cliConfigDir = join(scratchRoot, "cli-config");
  const cliStateDir = join(scratchRoot, "cli-state");
  const cliWorkspaceRoot = join(scratchRoot, "cli-workspace");
  mkdirSync(cliConfigDir);
  mkdirSync(cliStateDir);
  mkdirSync(cliWorkspaceRoot);
  const cliEnvironment = smokeEnvironment(process.env, {
    HOST: "127.0.0.1",
    PORT: "1",
    DEVSPACE_CONFIG_DIR: cliConfigDir,
    DEVSPACE_STATE_DIR: cliStateDir,
    DEVSPACE_ALLOWED_ROOTS: cliWorkspaceRoot,
    DEVSPACE_ALLOWED_HOSTS: "127.0.0.1",
    DEVSPACE_OAUTH_OWNER_TOKEN: "pack-smoke-owner-token-that-is-long-enough",
    DEVSPACE_PUBLIC_BASE_URL: "http://127.0.0.1:1",
    DEVSPACE_LOG_LEVEL: "silent",
  });
  const installedVersion = execFileSync(process.execPath, [cliPath, "--version"], {
    cwd: installRoot,
    encoding: "utf8",
    env: cliEnvironment,
  }).trim();

  if (installedVersion !== installedPackage.version) {
    throw new Error(`Installed CLI reported ${installedVersion}; expected ${installedPackage.version}.`);
  }
  execFileSync(process.execPath, [cliPath, "help"], {
    cwd: installRoot,
    stdio: "ignore",
    env: cliEnvironment,
  });
  const doctor = execFileSync(process.execPath, [cliPath, "doctor"], {
    cwd: installRoot,
    encoding: "utf8",
    env: cliEnvironment,
  });
  if (!doctor.includes("SQLite native dependency: ok")) {
    throw new Error("Installed CLI doctor could not load the packaged SQLite runtime.");
  }
  if (existsSync(join(cliStateDir, "devspace.sqlite"))) {
    throw new Error("Installed CLI doctor mutated its isolated state directory.");
  }
  await smokeServe(cliPath, installRoot);
  process.stdout.write(`Packed CLI smoke test passed (${installedVersion}).\n`);
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

function assertInstalledDependencyTree(installRoot) {
  const packageRoot = join(installRoot, "node_modules", "@waishnav", "devspace");
  for (const readme of ["README.md", "README_EN.md"]) {
    try {
      readFileSync(join(packageRoot, readme), "utf8");
    } catch {
      throw new Error(`Packed DevSpace is missing ${readme}.`);
    }
  }
  const bundledPackages = installedPackageVersions(join(packageRoot, "node_modules"));
  const mcpVersions = bundledPackages.get("@modelcontextprotocol/sdk") ?? [];
  const honoVersions = bundledPackages.get("@hono/node-server") ?? [];
  if (!mcpVersions.includes("1.29.0")) {
    throw new Error(`Packed dependency tree is missing @modelcontextprotocol/sdk 1.29.0.`);
  }
  if (!honoVersions.includes("2.0.11") || honoVersions.some((version) => version.startsWith("1."))) {
    throw new Error(
      `Packed MCP SDK contains unexpected @hono/node-server version(s): ${honoVersions.join(", ") || "none"}.`,
    );
  }
  for (const unwanted of [
    "@anthropic-ai/claude-agent-sdk",
    "@earendil-works/pi-coding-agent",
    "@modelcontextprotocol/ext-apps",
  ]) {
    try {
      createRequire(join(installRoot, "package.json")).resolve(`${unwanted}/package.json`);
      throw new Error(`Fresh consumer unexpectedly installed optional provider dependency ${unwanted}.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Fresh consumer unexpectedly")) throw error;
    }
  }
  process.stdout.write("Packed dependency tree uses the audited MCP SDK and omits optional provider SDKs.\n");
}

function installedPackageVersions(root) {
  const versions = new Map();
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        visited += 1;
        if (visited > 20_000) throw new Error("Packed dependency tree traversal exceeded its safety limit.");
        continue;
      }
      if (entry.name !== "package.json") continue;
      try {
        const metadata = JSON.parse(readFileSync(path, "utf8"));
        if (typeof metadata.name !== "string" || typeof metadata.version !== "string") continue;
        const current = versions.get(metadata.name) ?? [];
        if (!current.includes(metadata.version)) current.push(metadata.version);
        versions.set(metadata.name, current);
      } catch {
        // A malformed unrelated package is handled by npm install itself.
      }
    }
  }
  return versions;
}

async function assertConsumerAuditClean(installRoot) {
  const command = npmCli ? process.execPath : npmCommand;
  const args = npmCli
    ? [npmCli, "audit", "--omit=dev", "--audit-level=low", "--json"]
    : ["audit", "--omit=dev", "--audit-level=low", "--json"];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const audit = spawnSync(command, args, {
      cwd: installRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let parsed;
    try {
      parsed = JSON.parse(audit.stdout || "{}");
    } catch {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        continue;
      }
      throw new Error(
        `Consumer dependency audit returned invalid JSON: ${(audit.stderr || audit.stdout).slice(-2_000)}`,
      );
    }
    const vulnerabilities = parsed?.metadata?.vulnerabilities;
    if (vulnerabilities) {
      const total = Number(vulnerabilities.total ?? 0);
      if (audit.status === 0 && total === 0) {
        process.stdout.write("Fresh consumer production audit passed (0 vulnerabilities).\n");
        return;
      }
      const affected = Object.entries(parsed?.vulnerabilities ?? {})
        .map(([name, value]) => `${name} (${value?.severity ?? "unknown"})`)
        .join(", ");
      throw new Error(
        `Fresh consumer audit found ${total} production vulnerability(ies)` +
        `${affected ? `: ${affected}` : "."}`,
      );
    }
    const statusCode = Number(parsed?.statusCode ?? 0);
    const transient = statusCode >= 500 || /Service Unavailable|endpoint returned an error/iu.test(
      `${parsed?.message ?? ""}\n${audit.stderr ?? ""}`,
    );
    if (transient && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      continue;
    }
    throw new Error(
      `Fresh consumer audit could not complete${statusCode ? ` (HTTP ${statusCode})` : ""}: ` +
      `${parsed?.message ?? audit.stderr ?? "unknown audit failure"}`,
    );
  }
}

async function smokeServe(cliPath, installRoot) {
  const port = await availablePort();
  const configDir = join(installRoot, "config");
  const stateDir = join(installRoot, "state");
  const workspaceRoot = join(installRoot, "workspace");
  mkdirSync(configDir);
  mkdirSync(workspaceRoot);
  writeFileSync(join(configDir, "auth.json"), JSON.stringify({
    ownerToken: "pack-smoke-owner-token-that-is-long-enough",
  }));
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port,
    allowedRoots: [workspaceRoot],
    publicBaseUrl: `http://127.0.0.1:${port}`,
    toolMode: "full",
    widgets: "off",
  }));

  const child = spawn(process.execPath, [cliPath, "serve"], {
    cwd: installRoot,
    env: smokeEnvironment({
      ...process.env,
      HOST: "host-must-come-from-the-fixture",
      PORT: "port-must-come-from-the-fixture",
      DEVSPACE_TOOL_MODE: "mode-must-come-from-the-fixture",
    }, {
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_STATE_DIR: stateDir,
      DEVSPACE_LOG_LEVEL: "silent",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Installed CLI exited before readiness (${output.slice(-1_000)}).`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        if (response.ok && (await response.json()).status === "ready") return;
      } catch {
        // The child may still be loading native modules and migrations.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Installed CLI did not become ready (${output.slice(-1_000)}).`);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}

function smokeEnvironment(inheritedEnv, overrides) {
  const scrubbed = Object.fromEntries(Object.entries(inheritedEnv).filter(([name]) => {
    const normalized = name.toUpperCase();
    return normalized !== "HOST" && normalized !== "PORT" && !normalized.startsWith("DEVSPACE_");
  }));
  return { ...scrubbed, ...overrides };
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Unable to reserve a smoke-test port."));
        return;
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}
