import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatch,
  applyPreparedPatch,
  FileVersionConflictError,
  InvalidPatchError,
  isSamePatchFile,
  parsePatch,
  preparePatch,
  replaceFile,
} from "./apply-patch.js";
import { readFileVersion } from "./file-version.js";

const root = await mkdtemp(join(tmpdir(), "devspace-apply-patch-"));
const replacement = join(root, "replacement.txt");
const replacementTemporary = join(root, "replacement.tmp");
await writeFile(replacement, "old\n");
await writeFile(replacementTemporary, "new\n");
await replaceFile(replacementTemporary, replacement, true, "win32");
assert.equal(await readFile(replacement, "utf8"), "new\n");

const sameIdentity = async (): Promise<{ dev: number; ino: number }> => ({ dev: 1, ino: 2 });
const differentIdentity = async (path: string): Promise<{ dev: number; ino: number }> => ({
  dev: 1,
  ino: path.endsWith("foo.txt") ? 3 : 2,
});
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/Foo.txt"), true);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/foo.txt", sameIdentity), true);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/bar.txt", sameIdentity), false);
assert.equal(await isSamePatchFile("/tmp/Foo.txt", "/tmp/foo.txt", differentIdentity), false);

await writeFile(join(root, "alpha.txt"), "one\ntwo\nthree\n");
await writeFile(join(root, "remove.txt"), "remove me\n");
await writeFile(join(root, "windows.txt"), "first\r\nsecond\r\n");

const result = await applyPatch(
  root,
  `*** Begin Patch
*** Add File: nested/added.txt
+new
+file
*** Update File: alpha.txt
@@
 one
-two
+changed
 three
*** Update File: windows.txt
@@
 first
-second
+updated
*** Delete File: remove.txt
*** End Patch`,
);

assert.deepEqual(result.files, [
  { path: "nested/added.txt", operation: "add" },
  { path: "alpha.txt", operation: "update" },
  { path: "windows.txt", operation: "update" },
  { path: "remove.txt", operation: "delete" },
]);
assert.equal(result.additions, 4);
assert.equal(result.removals, 3);
assert.match(result.patch, /diff --git a\/alpha\.txt b\/alpha\.txt/);
assert.match(result.patch, /-two\n\+changed/);
assert.equal(await readFile(join(root, "nested/added.txt"), "utf8"), "new\nfile\n");
assert.equal(await readFile(join(root, "alpha.txt"), "utf8"), "one\nchanged\nthree\n");
assert.equal(await readFile(join(root, "windows.txt"), "utf8"), "first\r\nupdated\r\n");
await assert.rejects(readFile(join(root, "remove.txt"), "utf8"), /ENOENT/);

if (process.platform !== "win32") await chmod(join(root, "alpha.txt"), 0o755);
const moveResult = await applyPatch(
  root,
  `*** Begin Patch
*** Update File: alpha.txt
*** Move to: moved/alpha.txt
@@
-one
+ONE
 changed
*** End Patch`,
);
assert.deepEqual(moveResult.files, [
  { path: "moved/alpha.txt", previousPath: "alpha.txt", operation: "move" },
]);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");
if (process.platform !== "win32") {
  assert.notEqual((await stat(join(root, "moved/alpha.txt"))).mode & 0o111, 0);
}
await assert.rejects(readFile(join(root, "alpha.txt"), "utf8"), /ENOENT/);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: ../escape.txt
+no
*** End Patch`,
  ),
  /path escapes the workspace/,
);

const outside = await mkdtemp(join(tmpdir(), "devspace-apply-patch-outside-"));
await symlink(outside, join(root, "outside-link"), process.platform === "win32" ? "junction" : "dir");
await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: outside-link/escape.txt
+no
*** End Patch`,
  ),
  /path resolves outside the workspace/,
);

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Update File: moved/alpha.txt
@@
-not present
+replacement
*** End Patch`,
  ),
  (error: unknown) => {
    assert(error instanceof InvalidPatchError);
    assert.equal(error.code, "invalid_patch");
    assert.equal(error.path, "moved/alpha.txt");
    assert.match(error.publicText, /could not find hunk context/);
    assert.equal(error.publicText.includes(root), false);
    assert.equal(error.publicText.includes("not present"), false);
    return true;
  },
);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");

await assert.rejects(
  applyPatch(
    root,
    `*** Begin Patch
*** Add File: should-not-exist.txt
+staged
*** Update File: moved/alpha.txt
@@
-missing context
+replacement
*** End Patch`,
  ),
  /could not find hunk context/,
);
await assert.rejects(readFile(join(root, "should-not-exist.txt"), "utf8"), /ENOENT/);
assert.equal(await readFile(join(root, "moved/alpha.txt"), "utf8"), "ONE\nchanged\nthree\n");

const splitHunkRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-split-hunk-"));
await writeFile(
  join(splitHunkRoot, "long.txt"),
  Array.from({ length: 20 }, (_, index) => String(index + 1)).join("\n") + "\n",
);
const splitHunkResult = await applyPatch(
  splitHunkRoot,
  `*** Begin Patch
*** Update File: long.txt
@@
 1
-2
+two
 3
@@
 17
-18
+eighteen
 19
*** End Patch`,
);
assert.equal(splitHunkResult.patch.match(/^@@ /gm)?.length, 2);
assert.equal(
  await readFile(join(splitHunkRoot, "long.txt"), "utf8"),
  [
    "1", "two", "3", "4", "5", "6", "7", "8", "9", "10",
    "11", "12", "13", "14", "15", "16", "17", "eighteen", "19", "20",
  ].join("\n") + "\n",
);

const trailingSpaceRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-trailing-space-"));
await writeFile(join(trailingSpaceRoot, "spaces.txt"), "old\n");
const trailingSpaceResult = await applyPatch(
  trailingSpaceRoot,
  `*** Begin Patch
*** Update File: spaces.txt
@@
-old
+new${"   "}
*** End Patch`,
);
assert.equal(trailingSpaceResult.patch.endsWith("+new   "), true);
assert.equal(await readFile(join(trailingSpaceRoot, "spaces.txt"), "utf8"), "new   \n");

let syntaxError: InvalidPatchError | undefined;
assert.throws(
  () => parsePatch("*** Begin Patch\n*** End Patch"),
  (error: unknown) => {
    assert(error instanceof InvalidPatchError);
    syntaxError = error;
    return true;
  },
);
assert(syntaxError);
assert.equal(syntaxError.code, "invalid_patch");
assert.equal(syntaxError.publicText, "contains no file actions");
assert.equal(syntaxError.path, undefined);
assert.throws(
  () => parsePatch(`*** Begin Patch
*** Add File: ${join(root, "private.txt")}
*** End Patch`),
  (error: unknown) =>
    error instanceof InvalidPatchError &&
    error.path === undefined &&
    /has no content/.test(error.publicText) &&
    !error.publicText.includes(root),
);
assert.throws(() => parsePatch("*** Add File: bad.txt\n+x"), /missing .* marker/);
assert.throws(
  () => parsePatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch"),
  /has no content/,
);

const preparedRoot = await mkdtemp(join(tmpdir(), "devspace-prepared-patch-"));
await writeFile(join(preparedRoot, "before.txt"), "before\n");
const prepared = preparePatch(`*** Begin Patch
*** Update File: before.txt
*** Move to: after.txt
@@
-before
+after
*** Add File: extra.txt
+extra
*** End Patch`);
assert.deepEqual(prepared.paths, ["before.txt", "after.txt", "extra.txt"]);
const preparedResult = await applyPreparedPatch(preparedRoot, prepared);
assert.deepEqual(preparedResult.files, [
  { path: "after.txt", previousPath: "before.txt", operation: "move" },
  { path: "extra.txt", operation: "add" },
]);
assert.equal(await readFile(join(preparedRoot, "after.txt"), "utf8"), "after\n");
assert.equal(await readFile(join(preparedRoot, "extra.txt"), "utf8"), "extra\n");

const rollbackRoot = await mkdtemp(join(tmpdir(), "devspace-patch-rollback-"));
await writeFile(join(rollbackRoot, "first.txt"), "first original\n");
await writeFile(join(rollbackRoot, "delete.txt"), "delete original\n");
await writeFile(join(rollbackRoot, "last.txt"), "last original\n");
const injectedCommitFailure = new Error("injected patch commit failure");
let commitRenameCount = 0;
await assert.rejects(
  applyPatch(
    rollbackRoot,
    `*** Begin Patch
*** Update File: first.txt
@@
-first original
+first updated
*** Delete File: delete.txt
*** Add File: created/new.txt
+new output
*** Update File: last.txt
@@
-last original
+last updated
*** End Patch`,
    {
      commitOperations: {
        rename: async (source, destination) => {
          commitRenameCount += 1;
          if (commitRenameCount === 5) throw injectedCommitFailure;
          await rename(source, destination);
        },
      },
    },
  ),
  (error: unknown) => error === injectedCommitFailure,
);
assert.equal(await readFile(join(rollbackRoot, "first.txt"), "utf8"), "first original\n");
assert.equal(await readFile(join(rollbackRoot, "delete.txt"), "utf8"), "delete original\n");
assert.equal(await readFile(join(rollbackRoot, "last.txt"), "utf8"), "last original\n");
await assert.rejects(readFile(join(rollbackRoot, "created/new.txt"), "utf8"), /ENOENT/);
await assert.rejects(stat(join(rollbackRoot, "created")), /ENOENT/);
assert.deepEqual(
  (await readdir(rollbackRoot)).filter((path) => path.startsWith(".devspace-patch-")),
  [],
);

const overwriteRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-overwrite-"));
await writeFile(join(overwriteRoot, "duplicate.txt"), "old content\n");
await applyPatch(
  overwriteRoot,
  `*** Begin Patch
*** Add File: duplicate.txt
+new content
*** End Patch`,
);
assert.equal(await readFile(join(overwriteRoot, "duplicate.txt"), "utf8"), "new content\n");

await writeFile(join(overwriteRoot, "source.txt"), "from\n");
await writeFile(join(overwriteRoot, "destination.txt"), "existing\n");
await applyPatch(
  overwriteRoot,
  `*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-from
+new
*** End Patch`,
);
assert.equal(await readFile(join(overwriteRoot, "destination.txt"), "utf8"), "new\n");
await assert.rejects(readFile(join(overwriteRoot, "source.txt"), "utf8"), /ENOENT/);

const noNewlineRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-newline-"));
await writeFile(join(noNewlineRoot, "no-newline.txt"), "old");
await applyPatch(
  noNewlineRoot,
  `*** Begin Patch
*** Update File: no-newline.txt
@@
-old
+new
*** End Patch`,
);
assert.equal(await readFile(join(noNewlineRoot, "no-newline.txt"), "utf8"), "new\n");

const eofRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-eof-"));
await writeFile(join(eofRoot, "tail.txt"), "first\nsecond\n");
await applyPatch(
  eofRoot,
  `*** Begin Patch
*** Update File: tail.txt
@@
 first
-second
+second updated
*** End of File
*** End Patch`,
);
assert.equal(await readFile(join(eofRoot, "tail.txt"), "utf8"), "first\nsecond updated\n");
await assert.rejects(
  applyPatch(
    eofRoot,
    `*** Begin Patch
*** Update File: tail.txt
@@
 first
+not tail
*** End of File
*** End Patch`,
  ),
  /could not find hunk context/,
);

const lenientRoot = await mkdtemp(join(tmpdir(), "devspace-apply-patch-lenient-"));
await writeFile(join(lenientRoot, "file.txt"), "one\n");
await applyPatch(
  lenientRoot,
  `<<'EOF'
 *** Begin Patch
  *** Update File: file.txt
@@
-one
+two
 *** End Patch
EOF`,
);
assert.equal(await readFile(join(lenientRoot, "file.txt"), "utf8"), "two\n");

await applyPatch(
  lenientRoot,
  `*** Begin Patch
*** Environment ID: ignored
*** Update File: file.txt
 two
+three
*** End Patch`,
);
assert.equal(await readFile(join(lenientRoot, "file.txt"), "utf8"), "two\nthree\n");

await assert.rejects(
  applyPatch(
    lenientRoot,
    `*** Begin Patch
*** Add File: ${join(lenientRoot, "absolute.txt")}
+no
*** End Patch`,
  ),
  (error: unknown) =>
    error instanceof InvalidPatchError &&
    error.path === undefined &&
    /path must be relative/.test(error.publicText) &&
    !error.publicText.includes(lenientRoot),
);

await writeFile(join(lenientRoot, "binary.dat"), Buffer.from([0, 159, 146, 150]));
await assert.rejects(
  applyPatch(
    lenientRoot,
    `*** Begin Patch
*** Update File: binary.dat
@@
-x
+y
*** End Patch`,
  ),
  /not valid UTF-8|binary/,
);

const versionRoot = await mkdtemp(join(tmpdir(), "devspace-file-version-"));
const versionPath = join(versionRoot, "raw.dat");
const rawContents = Buffer.from([0, 159, 146, 150, 255]);
await writeFile(versionPath, rawContents);
const rawMetadata = await stat(versionPath, { bigint: true });
assert.deepEqual(await readFileVersion(versionPath), {
  hash: `sha256:${createHash("sha256").update(rawContents).digest("hex")}`,
  mtimeNs: rawMetadata.mtimeNs.toString(10),
});
assert.equal(await readFileVersion(join(versionRoot, "missing.txt")), null);

const preconditionRoot = await mkdtemp(join(tmpdir(), "devspace-patch-precondition-"));
await writeFile(join(preconditionRoot, "first.txt"), "first\n");
await writeFile(join(preconditionRoot, "second.txt"), "second\n");
const firstVersion = await readFileVersion(join(preconditionRoot, "first.txt"));
const secondVersion = await readFileVersion(join(preconditionRoot, "second.txt"));
assert(firstVersion);
assert(secondVersion);

await applyPatch(
  preconditionRoot,
  `*** Begin Patch
*** Update File: first.txt
@@
-first
+FIRST
*** End Patch`,
  { ifMatch: { "first.txt": firstVersion } },
);
assert.equal(await readFile(join(preconditionRoot, "first.txt"), "utf8"), "FIRST\n");

await applyPatch(
  preconditionRoot,
  `*** Begin Patch
*** Add File: created.txt
+created
*** End Patch`,
  { ifMatch: { "created.txt": null } },
);
assert.equal(await readFile(join(preconditionRoot, "created.txt"), "utf8"), "created\n");

const createdVersion = await readFileVersion(join(preconditionRoot, "created.txt"));
assert(createdVersion);
await applyPatch(
  preconditionRoot,
  `*** Begin Patch
*** Update File: created.txt
@@
-created
+updated
*** End Patch`,
  { ifMatch: { "created.txt": createdVersion.hash } },
);
assert.equal(await readFile(join(preconditionRoot, "created.txt"), "utf8"), "updated\n");

const incorrectSecondVersion = {
  ...secondVersion,
  hash: `sha256:${"0".repeat(64)}`,
};
let conflict: FileVersionConflictError | undefined;
try {
  await applyPatch(
    preconditionRoot,
    `*** Begin Patch
*** Update File: first.txt
@@
-FIRST
+changed first
*** Update File: second.txt
@@
-second
+changed second
*** End Patch`,
    {
      ifMatch: {
        "first.txt": await readFileVersion(join(preconditionRoot, "first.txt")),
        "second.txt": incorrectSecondVersion,
      },
    },
  );
} catch (error) {
  assert(error instanceof FileVersionConflictError);
  conflict = error;
}
assert(conflict);
assert.equal(conflict.path, "second.txt");
assert.deepEqual(conflict.expected, incorrectSecondVersion);
assert.deepEqual(conflict.actual, secondVersion);
assert.equal(conflict.message.includes(preconditionRoot), false);
assert.equal(await readFile(join(preconditionRoot, "first.txt"), "utf8"), "FIRST\n");
assert.equal(await readFile(join(preconditionRoot, "second.txt"), "utf8"), "second\n");

const missingExpectedVersion = { ...secondVersion };
await assert.rejects(
  applyPatch(
    preconditionRoot,
    `*** Begin Patch
*** Add File: absent.txt
+must remain absent
*** End Patch`,
    { ifMatch: { "absent.txt": missingExpectedVersion } },
  ),
  (error: unknown) =>
    error instanceof FileVersionConflictError &&
    error.path === "absent.txt" &&
    error.actual === null,
);
await assert.rejects(readFile(join(preconditionRoot, "absent.txt"), "utf8"), /ENOENT/);

await assert.rejects(
  applyPatch(
    preconditionRoot,
    `*** Begin Patch
*** Add File: second.txt
+must not overwrite
*** End Patch`,
    { ifMatch: { "second.txt": null } },
  ),
  (error: unknown) =>
    error instanceof FileVersionConflictError &&
    error.path === "second.txt" &&
    error.expected === null &&
    error.actual?.hash === secondVersion.hash,
);
assert.equal(await readFile(join(preconditionRoot, "second.txt"), "utf8"), "second\n");
