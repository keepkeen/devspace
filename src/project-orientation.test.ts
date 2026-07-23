import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inspectProjectOrientation } from "./project-orientation.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-project-orientation-test-"));
try {
  assert.deepEqual(await inspectProjectOrientation(root), { empty: true, topLevel: [] });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), "{}\n", "utf8");
  const plain = await inspectProjectOrientation(root);
  assert.deepEqual(plain.topLevel, ["package.json", "src/"]);
  assert.equal(plain.empty, false);
  assert.equal(plain.git, undefined);

  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "devspace@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "DevSpace Test"], { cwd: root });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "initial"], { cwd: root });
  const clean = await inspectProjectOrientation(root);
  assert.equal(clean.git?.dirty, false);
  assert.ok(clean.git?.branch);
  await writeFile(join(root, "package.json"), "{\"dirty\":true}\n", "utf8");
  assert.equal((await inspectProjectOrientation(root)).git?.dirty, true);
} finally {
  await rm(root, { recursive: true, force: true });
}
