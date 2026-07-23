import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_TOOL_ERROR_MAX_CHARACTERS,
  readFileTool,
  sanitizePiToolError,
} from "./pi-tools.js";

const context = {
  cwd: "/allowed/workspace/packages/app",
  root: "/allowed/workspace",
  readRoots: ["/allowed/workspace", "/shared/reference"],
};

const pathError = sanitizePiToolError(
  new Error("ENOENT: no such file, open '/allowed/workspace/src/private.ts'"),
  context,
);
assert.equal(pathError, "ENOENT: no such file, open '[workspace]/src/private.ts'");
assert.doesNotMatch(pathError, /\/allowed\/workspace/);

const readRootError = sanitizePiToolError(
  new Error("EACCES: permission denied, open '/shared/reference/secret.txt'"),
  context,
);
assert.match(readRootError, /^EACCES: permission denied/);
assert.match(readRootError, /\[read root\]\/secret\.txt/);
assert.doesNotMatch(readRootError, /\/shared\/reference/);

const multilineError = sanitizePiToolError(
  "TypeError: invalid input\n    at execute (/allowed/workspace/internal.ts:12:3)",
  context,
);
assert.equal(multilineError, "TypeError: invalid input");
assert.doesNotMatch(multilineError, /[\r\n]| at execute/);
assert.equal(sanitizePiToolError("EIO: failed\rstack details", context), "EIO: failed");

const unrelatedAbsolutePath = sanitizePiToolError(
  new Error("EIO: failed while reading /Users/private/.devspace/auth.json"),
  context,
);
assert.equal(unrelatedAbsolutePath, "EIO: failed while reading [path]");
assert.doesNotMatch(unrelatedAbsolutePath, /Users|devspace|auth\.json/);

const oversizedError = sanitizePiToolError(
  new Error(`EINVAL: ${"x".repeat(PI_TOOL_ERROR_MAX_CHARACTERS * 2)}`),
  context,
);
assert.equal(oversizedError.length, PI_TOOL_ERROR_MAX_CHARACTERS);
assert.match(oversizedError, /^EINVAL:/);

assert.equal(
  sanitizePiToolError({ code: "EIO" }, context),
  "EIO: Tool operation failed.",
);
assert.equal(sanitizePiToolError({}, context), "Tool operation failed.");

const adapterRoot = await mkdtemp(join(tmpdir(), "devspace-pi-error-report-"));
try {
  let reportedError: unknown;
  const response = await readFileTool(
    { path: "missing.txt" },
    {
      cwd: adapterRoot,
      root: adapterRoot,
      onError: (error) => {
        reportedError = error;
      },
    },
  );
  assert.equal(response.isError, true);
  assert.ok(reportedError instanceof Error);
  assert.doesNotMatch(JSON.stringify(response.content), new RegExp(adapterRoot));
  assert.match(reportedError.message, new RegExp(adapterRoot));
} finally {
  await rm(adapterRoot, { recursive: true, force: true });
}

console.log("pi-tools tests passed");
