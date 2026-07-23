import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateShellWriteTargets } from "./shell-write-targets.js";

const root = await mkdtemp(join(tmpdir(), "devspace-shell-write-targets-"));
const outside = await mkdtemp(join(tmpdir(), "devspace-shell-write-outside-"));

try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "source.txt"), "source\n");
  await symlink(outside, join(root, "outside-link"));
  await symlink(join(outside, "missing"), join(root, "dangling-link"));

  const allowed = [
    "touch file.txt",
    "mkdir -p build/generated",
    "cp source.txt build/copy.txt",
    "mv source.txt build/moved.txt",
    "printf 'hello' > build/output.txt",
    "printf 'hello' >>build/output.txt",
    "sed -i '' 's/source/changed/' source.txt",
    "bash -lc 'touch build/from-shell.txt'",
    "cd src && touch ../from-nested.txt",
    "mkdir future && cd future && touch created.txt",
    "./project-script.sh",
    "printf x >\"$(printf dynamic.txt)\"",
  ];
  for (const command of allowed) {
    assert.equal(
      validateShellWriteTargets(command, root, root),
      undefined,
      `${command} should be allowed`,
    );
  }

  const denied = [
    `touch ${join(outside, "touch.txt")}`,
    `mkdir ${join(outside, "directory")}`,
    `cp source.txt ${join(outside, "copy.txt")}`,
    `printf x > ${join(outside, "redirect.txt")}`,
    `echo hi>${join(outside, "attached-redirect.txt")}`,
    `echo hi &>${join(outside, "combined-redirect.txt")}`,
    `echo hi >&${join(outside, "duplicate-redirect.txt")}`,
    `cp -t${outside} source.txt`,
    `sed -i '' 's/a/b/' ${join(outside, "sed.txt")}`,
    `sed -i '' 's/a/b/' ${join(outside, "sed-first.txt")} source.txt`,
    `chmod --reference=source.txt ${join(outside, "chmod.txt")}`,
    "printf x > ../escaped.txt",
    "touch outside-link/escaped.txt",
    "touch dangling-link",
    `bash -lc 'touch ${join(outside, "nested.txt")}'`,
    `bash -xc 'touch ${join(outside, "nested-xtrace.txt")}'`,
    `eval 'touch ${join(outside, "eval.txt")}'`,
    `echo $(touch ${join(outside, "substitution.txt")})`,
    `cd ${outside} && touch escaped.txt`,
    `ln -s ${outside} outside-created-link && touch outside-created-link/escaped.txt`,
    `ln --symbolic ${outside} outside-long-link && touch outside-long-link/escaped.txt`,
  ];
  for (const command of denied) {
    const violation = validateShellWriteTargets(command, root, root);
    assert(violation, `${command} should be rejected`);
    assert.match(violation.reason, /outside the workspace/);
  }
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

console.log("shell-write-target tests passed");
