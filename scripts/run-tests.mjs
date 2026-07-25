import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(projectRoot, "src");
const tests = discoverTestFiles(sourceRoot);

if (tests.length === 0) {
  throw new Error(`No test files were discovered under ${sourceRoot}.`);
}

const require = createRequire(import.meta.url);
const tsxCli = resolve(dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
let completed = 0;

console.log(`Discovered ${tests.length} test files under src/.`);

for (const testPath of tests) {
  const displayPath = relative(projectRoot, testPath).split(sep).join("/");
  const result = spawnSync(process.execPath, [tsxCli, testPath], {
    cwd: projectRoot,
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") {
    console.error(`Test timed out after 180 seconds: ${displayPath}`);
    process.exit(1);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  completed += 1;
}

if (completed !== tests.length) {
  throw new Error(`Test discovery found ${tests.length} files, but only ${completed} completed.`);
}

console.log(`Completed all ${completed} discovered test files.`);

function discoverTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverTestFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}
