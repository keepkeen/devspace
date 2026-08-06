import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_TOOL_ERROR_MAX_CHARACTERS,
  MAX_TEXT_READ_FILE_BYTES,
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
assert.equal(pathError, "ENOENT: no such file, open '[project]/src/private.ts'");
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
const adapterOutsideRoot = await mkdtemp(join(tmpdir(), "devspace-pi-outside-"));
try {
  await mkdir(join(adapterRoot, "src", "nested"), { recursive: true });
  await mkdir(join(adapterRoot, "node_modules", "ignored"), { recursive: true });
  await writeFile(join(adapterRoot, "src", "a.ts"), "zero\nMATCH\npost\n");
  await writeFile(join(adapterRoot, "src", "nested", "b.ts"), "nested MATCH\n");
  await writeFile(join(adapterRoot, "node_modules", "ignored", "hidden.ts"), "MATCH\n");
  await writeFile(join(adapterRoot, ".env"), "visible\n");
  await symlink(join(adapterRoot, "src", "a.ts"), join(adapterRoot, "read-link.ts"));

  const symlinkRead = await readFileTool(
    { path: "read-link.ts" },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(symlinkRead.isError, true);
  assert.doesNotMatch(JSON.stringify(symlinkRead.content), /zero|MATCH|post/u);

  const symlinkGrep = await grepFilesTool(
    { pattern: "MATCH", path: "read-link.ts", literal: true },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(symlinkGrep.isError, true);
  assert.doesNotMatch(JSON.stringify(symlinkGrep.content), /read-link\.ts:2: MATCH/u);

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
  assert.equal(
    invalidPattern.content[0]?.type === "text" ? invalidPattern.content[0].text : "",
    "The search regular expression is invalid; correct the pattern and retry.",
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

  if (platform() !== "win32") {
    await writeFile(join(adapterOutsideRoot, "outside-secret.txt"), "outside secret\n");

    const listRacePath = join(adapterRoot, "list-race");
    const listRaceOriginal = join(adapterRoot, "list-race-original");
    await mkdir(listRacePath);
    await writeFile(join(listRacePath, "inside.txt"), "inside\n");
    const canonicalListRacePath = await realpath(listRacePath);
    let listRaceTriggered = false;
    const listRaceContext = {
      cwd: adapterRoot,
      root: adapterRoot,
      beforeDirectoryRead: async (path: string) => {
        if (path !== canonicalListRacePath || listRaceTriggered) return;
        listRaceTriggered = true;
        await rename(listRacePath, listRaceOriginal);
        await symlink(adapterOutsideRoot, listRacePath);
      },
    };
    const racedList = await listDirectoryTool(
      { path: "list-race" },
      listRaceContext,
    );
    assert.equal(listRaceTriggered, true);
    assert.equal(racedList.isError, true);
    assert.doesNotMatch(JSON.stringify(racedList.content), /outside-secret/u);
    await unlink(listRacePath);
    await rename(listRaceOriginal, listRacePath);

    const findRacePath = join(adapterRoot, "find-race");
    const findRaceOriginal = join(adapterRoot, "find-race-original");
    await mkdir(findRacePath);
    await writeFile(join(findRacePath, "inside.ts"), "inside\n");
    const canonicalFindRacePath = await realpath(findRacePath);
    let findRaceTriggered = false;
    const findRaceContext = {
      cwd: adapterRoot,
      root: adapterRoot,
      beforeDirectoryRead: async (path: string) => {
        if (path !== canonicalFindRacePath || findRaceTriggered) return;
        findRaceTriggered = true;
        await rename(findRacePath, findRaceOriginal);
        await symlink(adapterOutsideRoot, findRacePath);
      },
    };
    const racedFind = await findFilesTool(
      { pattern: "*.txt", path: "find-race" },
      findRaceContext,
    );
    assert.equal(findRaceTriggered, true);
    assert.equal(racedFind.isError, true);
    assert.doesNotMatch(JSON.stringify(racedFind.content), /outside-secret/u);
    await unlink(findRacePath);
    await rename(findRaceOriginal, findRacePath);
  }

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

  await writeFile(join(adapterRoot, "binary.dat"), Buffer.from([0x41, 0x00, 0x42]));
  const binary = await readFileTool(
    { path: "binary.dat" },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(binary.isError, true);
  assert.equal(binary.error?.code, "binary_file");
  assert.equal(binary.error?.safeToRetry, false);

  const lateBinaryBytes = Buffer.concat([
    Buffer.from("needle\n", "utf8"),
    Buffer.alloc(9_000, 0x61),
    Buffer.from([0x00, 0x62]),
  ]);
  await writeFile(join(adapterRoot, "late-binary.dat"), lateBinaryBytes);
  const lateBinary = await readFileTool(
    { path: "late-binary.dat" },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(lateBinary.isError, true);
  assert.equal(lateBinary.error?.code, "binary_file");
  const lateBinaryGrep = await grepFilesTool(
    { pattern: "needle", path: "late-binary.dat", literal: true },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(
    lateBinaryGrep.content[0]?.type === "text" ? lateBinaryGrep.content[0].text : "",
    "No matches found",
  );

  // ANSI escapes are ordinary text: a colored build log carries enough of them
  // to exceed the control-character ratio, so it must not read as binary.
  const escape = String.fromCharCode(27);
  await writeFile(
    join(adapterRoot, "colored.log"),
    Array.from(
      { length: 60 },
      (_unused, index) =>
        `${escape}[32m✓${escape}[0m src/module-${index}/component.test.ts (12 tests) passed`,
    ).join("\n"),
  );
  const coloredLog = await readFileTool(
    { path: "colored.log" },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(coloredLog.isError, undefined);
  assert.match(
    coloredLog.content[0]?.type === "text" ? coloredLog.content[0].text : "",
    /component\.test\.ts/u,
  );

  await writeFile(join(adapterRoot, "invalid-utf8.txt"), Buffer.from([0x61, 0xc3, 0x28]));
  const invalidUtf8 = await readFileTool(
    { path: "invalid-utf8.txt" },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(invalidUtf8.isError, true);
  assert.equal(invalidUtf8.error?.code, "invalid_utf8");
  const invalidUtf8Grep = await grepFilesTool(
    { pattern: "a", path: "invalid-utf8.txt", literal: true },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(
    invalidUtf8Grep.content[0]?.type === "text" ? invalidUtf8Grep.content[0].text : "",
    "No matches found",
  );

  await writeFile(
    join(adapterRoot, "oversized.txt"),
    Buffer.alloc(MAX_TEXT_READ_FILE_BYTES + 1, 0x61),
  );
  const oversizedFile = await readFileTool(
    { path: "oversized.txt", offset: 1, limit: 1 },
    { cwd: adapterRoot, root: adapterRoot },
  );
  assert.equal(oversizedFile.isError, true);
  assert.equal(oversizedFile.error?.code, "file_too_large");

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
  await rm(adapterOutsideRoot, { recursive: true, force: true });
}

console.log("pi-tools tests passed");
