import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  const installedPackage = JSON.parse(
    readFileSync(join(installRoot, "node_modules", "@waishnav", "devspace", "package.json"), "utf8"),
  );
  const cliPath = join(installRoot, "node_modules", "@waishnav", "devspace", "dist", "cli.js");
  const installedVersion = execFileSync(process.execPath, [cliPath, "--version"], {
    cwd: installRoot,
    encoding: "utf8",
  }).trim();

  if (installedVersion !== installedPackage.version) {
    throw new Error(`Installed CLI reported ${installedVersion}; expected ${installedPackage.version}.`);
  }
  execFileSync(process.execPath, [cliPath, "help"], { cwd: installRoot, stdio: "ignore" });
  const doctor = execFileSync(process.execPath, [cliPath, "doctor"], {
    cwd: installRoot,
    encoding: "utf8",
  });
  if (!doctor.includes("SQLite native dependency: ok")) {
    throw new Error("Installed CLI doctor could not load the packaged SQLite runtime.");
  }
  await smokeServe(cliPath, installRoot);
  process.stdout.write(`Packed CLI smoke test passed (${installedVersion}).\n`);
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
}

async function smokeServe(cliPath, installRoot) {
  const port = await availablePort();
  const configDir = join(installRoot, "config");
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
    toolMode: "codex",
    widgets: "off",
  }));

  const child = spawn(process.execPath, [cliPath, "serve"], {
    cwd: installRoot,
    env: {
      ...process.env,
      DEVSPACE_CONFIG_DIR: configDir,
      DEVSPACE_LOG_LEVEL: "silent",
    },
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
