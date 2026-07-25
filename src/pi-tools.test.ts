import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_TOOL_ERROR_MAX_CHARACTERS,
  InvalidSearchPatternError,
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  sanitizePiToolError,
  writeFileTool,
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
  await mkdir(join(adapterRoot, "src", "nested"), { recursive: true });
  await mkdir(join(adapterRoot, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(adapterRoot, "src", "a.ts"), "zero\nMATCH\npost\n");
  await writeFile(join(adapterRoot, "src", "nested", "b.ts"), "nested MATCH\n");
  await writeFile(join(adapterRoot, "node_modules", "ignored", "hidden.ts"), "MATCH\n");
  await writeFile(join(adapterRoot, ".env"), "visible\n");

  const readPage = await readFileTool(
    { path: "src/a.ts", offset: 2, limit: 1 },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(readPage.isError, undefined);
  assert.equal(readPage.content[0]?.type, "text");
  assert.match(readPage.content[0]?.type === "text" ? readPage.content[0].text : "", /^MATCH/u);
  assert.match(JSON.stringify(readPage.content), /Use offset=3 to continue/);

  const grep = await grepFilesTool(
    { pattern: "MATCH", path: "src", context: 1 },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(grep.isError, undefined);
  const grepText = grep.content[0]?.type === "text" ? grep.content[0].text : "";
  assert.match(grepText, /a\.ts:2: MATCH/);
  assert.match(grepText, /a\.ts-1- zero/);
  assert.match(grepText, /nested\/b\.ts:1: nested MATCH/);
  assert.doesNotMatch(grepText, /node_modules|hidden\.ts/);

  let invalidPatternReported = false;
  const invalidPattern = await grepFilesTool(
    { pattern: "[", path: "src" },
    {
      cwd: adapterRoot,
      root: adapterRoot,
      onError: () => {
        invalidPatternReported = true;
      },
    },
  );
  assert.equal(invalidPattern.isError, true);
  assert.equal(invalidPatternReported, false);
  assert.equal(invalidPattern.error?.code, "invalid_pattern");
  assert.equal(invalidPattern.error?.phase, "not_started");
  assert.equal(invalidPattern.error?.safeToRetry, true);
  assert.match(
    invalidPattern.content[0]?.type === "text" ? invalidPattern.content[0].text : "",
    /^invalid_pattern:/u,
  );
  assert.ok(new InvalidSearchPatternError() instanceof Error);

  const found = await findFilesTool(
    { pattern: "*.ts", path: "." },
    { cwd: adapterRoot, root: adapterRoot },
  );
  const foundText = found.content[0]?.type === "text" ? found.content[0].text : "";
  assert.match(foundText, /src\/a\.ts/);
  assert.match(foundText, /src\/nested\/b\.ts/);
  assert.doesNotMatch(foundText, /node_modules|hidden\.ts/);

  const listed = await listDirectoryTool(
    { path: "." },
    { cwd: adapterRoot, root: adapterRoot },
  );
  const listedText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
  assert.match(listedText, /^\.env/mu);
  assert.match(listedText, /^src\/$/mu);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  await writeFile(join(adapterRoot, "image.png"), png);
  const image = await readFileTool(
    { path: "image.png" },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.deepEqual(image.content, [
    { type: "text", text: "Read image file [image/png]" },
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
  ]);

  assert.equal((await writeFileTool(
    { path: "generated/new.txt", content: "before\n" },
    { cwd: adapterRoot, root: adapterRoot },
  )).isError, undefined);
  const edited = await editFileTool(
    { path: "generated/new.txt", edits: [{ oldText: "before", newText: "after" }] },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(join(adapterRoot, "generated", "new.txt"), "utf8"), "after\n");

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
