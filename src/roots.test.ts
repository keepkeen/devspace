import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertAllowedDirectory,
  assertAllowedPath,
  expandHomePath,
  resolveAllowedPath,
} from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "~/file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}

const canonicalRoot = mkdtempSync(join(tmpdir(), "devspace-roots-canonical-"));
try {
  const allowed = join(canonicalRoot, "allowed");
  const project = join(allowed, "project");
  const outside = join(canonicalRoot, "outside");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  assert.equal(assertAllowedDirectory(project, [allowed]), realpathSync(project));

  const link = join(allowed, "linked-outside");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => assertAllowedDirectory(link, [allowed]),
    /outside allowed roots/u,
  );
} finally {
  rmSync(canonicalRoot, { recursive: true, force: true });
}
