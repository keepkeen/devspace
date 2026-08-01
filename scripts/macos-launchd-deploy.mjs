#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installOneShotLaunchAgent,
  runDeploymentPlan,
} from "./lib/macos-launchd-deployment.mjs";

const scriptPath = fileURLToPath(import.meta.url);

try {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  if (command === "install") {
    const projectRoot = resolve(required(args, "project-root"));
    const diagnosticsToken = await loadDiagnosticsToken(process.env, projectRoot);
    const result = await installOneShotLaunchAgent({
      projectRoot,
      stagedDistPath: resolve(required(args, "staged-dist")),
      serviceLabel: required(args, "service-label"),
      servicePlistPath: resolve(required(args, "service-plist")),
      controlReadinessUrl: args.get("control-readiness-url") ??
        "http://127.0.0.1:7677/internal/readiness",
      diagnosticsToken,
      scriptPath,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "run") {
    await runDeploymentPlan(resolve(required(args, "plan")));
  } else {
    throw new Error(
      "Usage: macos-launchd-deploy.mjs install --project-root PATH --staged-dist PATH " +
      "--service-label LABEL --service-plist PATH [--control-readiness-url URL]",
    );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "macOS deployment failed."}\n`);
  process.exitCode = 1;
}

function parseArgs(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid deployment argument near ${flag ?? "end of input"}.`);
    }
    const name = flag.slice(2);
    if (parsed.has(name)) throw new Error(`Duplicate deployment argument: --${name}.`);
    parsed.set(name, value);
  }
  return parsed;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing required deployment argument: --${name}.`);
  return value;
}

async function loadDiagnosticsToken(env, projectRoot) {
  const inline = env.DEVSPACE_DEPLOYMENT_INTERNAL_TOKEN?.trim();
  const tokenFile = env.DEVSPACE_DEPLOYMENT_INTERNAL_TOKEN_FILE?.trim();
  if (inline && tokenFile) {
    throw new Error(
      "Set only one of DEVSPACE_DEPLOYMENT_INTERNAL_TOKEN or DEVSPACE_DEPLOYMENT_INTERNAL_TOKEN_FILE.",
    );
  }
  const explicit = inline ?? (tokenFile ? (await readFile(resolve(tokenFile), "utf8")).trim() : "");
  if (explicit) return explicit;

  // The currently installed dist is still live at install time. Reuse its
  // config/key derivation instead of asking an operator to print or copy the
  // internal token. The derived token is written only to the mode-0600 plan.
  try {
    const [{ loadConfig }, { internalDiagnosticsToken }] = await Promise.all([
      import(pathToFileURL(join(projectRoot, "dist", "config.js")).href),
      import(pathToFileURL(join(projectRoot, "dist", "internal-auth.js")).href),
    ]);
    return internalDiagnosticsToken(loadConfig(env).oauth.keys.internalDiagnostics);
  } catch {
    throw new Error(
      "Could not derive the deployment diagnostics token from the current dist. " +
      "Set DEVSPACE_DEPLOYMENT_INTERNAL_TOKEN_FILE to a mode-0600 token file.",
    );
  }
}
