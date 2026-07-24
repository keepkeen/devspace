import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateDirectCommandPaths,
  validateShellProtectedPaths,
  validateShellWriteTargets,
} from "./shell-write-targets.js";

const root = await mkdtemp(join(tmpdir(), "devspace-shell-write-targets-"));
const outside = await mkdtemp(join(tmpdir(), "devspace-shell-write-outside-"));

try {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "source.txt"), "source\n");
  await symlink(outside, join(root, "outside-link"));
  await symlink(join(outside, "missing"), join(root, "dangling-link"));
  const protectedRoot = join(outside, ".devspace");
  const stateRoot = join(outside, "state");
  const managedWorktree = join(protectedRoot, "worktrees", "current");
  const siblingWorktree = join(protectedRoot, "worktrees", "sibling");
  await mkdir(managedWorktree, { recursive: true });
  await mkdir(siblingWorktree, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(protectedRoot, "auth.json"), "secret\n");
  await writeFile(join(stateRoot, "metadata.sqlite"), "database\n");
  await writeFile(join(managedWorktree, "project.txt"), "project\n");
  await symlink(protectedRoot, join(root, "internal-link"));
  await symlink(join(protectedRoot, "auth.json"), join(root, "secret-file-link"));

  const allowed = [
    "touch file.txt",
    "mkdir -p build/generated",
    "rm -rf build/generated",
    "rm -f *.tmp",
    "rm --recursive src/generated",
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
    `cp ${join(outside, "readable-source.txt")} build/copied-from-outside.txt`,
    `touch -r ${join(outside, "reference.txt")} source.txt`,
    `touch --reference=${join(outside, "reference.txt")} source.txt`,
    `chmod --reference ${join(outside, "mode-reference.txt")} source.txt`,
    `chown --reference=${join(outside, "owner-reference.txt")} source.txt`,
    `chgrp --reference ${join(outside, "group-reference.txt")} source.txt`,
    "printf x >/dev/stdout",
    "printf x >/dev/stderr",
    "printf x >/dev/fd/3",
    "tee /dev/stdout",
    `bash -n <<'EOF'\ntouch ${join(outside, "parse-only.txt")}\nEOF`,
    `bash -n <<< 'touch ${join(outside, "parse-only-here-string.txt")}'`,
    `cat <<EOF\ntouch ${join(outside, "heredoc-data.txt")}\nEOF`,
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
    `mv ${join(outside, "move-source.txt")} build/moved-from-outside.txt`,
    `touch -r source.txt ${join(outside, "touch-reference-target.txt")}`,
    `chmod --reference ${join(outside, "mode-reference.txt")} ${join(outside, "chmod-reference-target.txt")}`,
    `bash <<'EOF'\ntouch ${join(outside, "heredoc-shell.txt")}\nEOF`,
    `printf '%s\\n' '<<EOF'\ntouch ${join(outside, "quoted-heredoc.txt")}\nEOF`,
    `printf '%s\\n' "<<EOF"\ntouch ${join(outside, "double-quoted-heredoc.txt")}\nEOF`,
    `printf '%s' 'literal\n<<EOF\n'\ntouch ${join(outside, "multiline-quoted-heredoc.txt")}\nEOF`,
    `printf ok # <<EOF\ntouch ${join(outside, "commented-heredoc.txt")}\nEOF`,
    `bash <<< 'touch ${join(outside, "here-string-shell.txt")}'`,
    `cat <(touch ${join(outside, "process-input.txt")})`,
    `cat >(touch ${join(outside, "process-output.txt")})`,
    `find . -exec touch ${join(outside, "find-exec.txt")} \\;`,
    `find . -execdir sh -c 'touch ${join(outside, "find-execdir.txt")}' {} +`,
    `find . -ok touch ${join(outside, "find-ok.txt")} \\;`,
    `find . -okdir touch ${join(outside, "find-okdir.txt")} \\;`,
    `printf x | xargs touch ${join(outside, "xargs.txt")}`,
    `printf x | xargs --replace touch ${join(outside, "xargs-replace.txt")}`,
    `printf x | xargs --eof touch ${join(outside, "xargs-eof.txt")}`,
    `trap 'touch ${join(outside, "trap.txt")}' EXIT`,
    `env -S 'touch ${join(outside, "env-split.txt")}'`,
    `command env -S 'touch ${join(outside, "wrapped-env-split.txt")}'`,
    `env -a custom-name touch ${join(outside, "env-argv0-short.txt")}`,
    `env --argv0 custom-name touch ${join(outside, "env-argv0-long.txt")}`,
    `if true; then touch ${join(outside, "conditional.txt")}; fi`,
    `2>/dev/null touch ${join(outside, "redirect-prefixed.txt")}`,
  ];
  for (const command of denied) {
    const violation = validateShellWriteTargets(command, root, root);
    assert(violation, `${command} should be rejected`);
    assert.match(violation.reason, /outside the workspace/);
  }

  assert.equal(
    validateDirectCommandPaths(
      "rm",
      ["-rf", "build/generated"],
      root,
      root,
      [protectedRoot, stateRoot],
    ),
    undefined,
    "direct argv should allow recursive cleanup inside the workspace",
  );
  assert.match(
    validateDirectCommandPaths(
      "rm",
      ["-rf", "."],
      root,
      root,
      [protectedRoot, stateRoot],
    )?.reason ?? "",
    /cannot delete the workspace root/i,
  );
  assert.match(
    validateDirectCommandPaths(
      "rm",
      ["-rf", outside],
      root,
      root,
      [protectedRoot, stateRoot],
    )?.reason ?? "",
    /outside the workspace/i,
  );
  assert.match(
    validateDirectCommandPaths(
      "cat",
      [join(stateRoot, "metadata.sqlite")],
      root,
      root,
      [protectedRoot, stateRoot],
    )?.reason ?? "",
    /protected DevSpace internal state/i,
  );
  assert.equal(
    validateDirectCommandPaths(
      "cp",
      [join(outside, "readable-source.txt"), "build/copied.txt"],
      root,
      root,
      [protectedRoot, stateRoot],
    ),
    undefined,
    "direct argv should allow an outside read source with an inside destination",
  );
  assert.match(
    validateDirectCommandPaths(
      "ln",
      ["-s", outside, "outside-created-link"],
      root,
      root,
      [protectedRoot, stateRoot],
    )?.reason ?? "",
    /symlink target is outside the workspace/i,
  );

  assert.match(
    validateShellWriteTargets(`rm -rf ${join(outside, "cache")}`, root, root)?.reason ?? "",
    /outside the workspace/,
  );
  assert.match(
    validateShellWriteTargets("rm -rf .", root, root)?.reason ?? "",
    /workspace root itself/,
  );
  assert.match(
    validateShellWriteTargets('rm -rf "$HOME/cache"', root, root)?.reason ?? "",
    /not safely workspace-relative/,
  );
  assert.match(
    validateShellWriteTargets("rm --recursive", root, root)?.reason ?? "",
    /explicit workspace target/,
  );

  const payloadOverflow = `echo ${Array.from({ length: 128 }, () => "$(printf safe)").join(" ")} $(touch ${join(outside, "overflow.txt")})`;
  const overflowViolation = validateShellWriteTargets(payloadOverflow, root, root);
  assert.equal(overflowViolation?.target, "<analysis-limit>");

  const ambiguousViolation = validateShellWriteTargets(
    `printf x | xargs --unknown-option ignored touch ${join(outside, "ambiguous.txt")}`,
    root,
    root,
  );
  assert.equal(ambiguousViolation?.target, "<analysis-limit>");

  const protectedRoots = [protectedRoot, stateRoot];
  const protectedCommands = [
    `cat ${join(protectedRoot, "auth.json")}`,
    `grep secret --file=${join(protectedRoot, "auth.json")}`,
    `sqlite3 ${join(stateRoot, "metadata.sqlite")} .tables`,
    `bash -lc 'cat ${join(protectedRoot, "auth.json")}'`,
    "cat internal-link/auth.json",
    "cat secret-file-link",
    `cat $'${join(protectedRoot, "auth.json")}'`,
    `cat $'\\x2f${join(protectedRoot, "auth.json").slice(1)}'`,
    `cat $'\\x2f'$'${join(protectedRoot, "auth.json").slice(1)}'`,
    `cat ${join(siblingWorktree, "project.txt")}`,
  ];
  for (const command of protectedCommands) {
    const violation = validateShellProtectedPaths(command, root, root, protectedRoots);
    assert(violation, `${command} should be rejected as protected internal state`);
    assert.match(violation.reason, /protected DevSpace internal state/i);
  }

  assert.equal(
    validateShellProtectedPaths(
      `cat ${join(outside, "readable-source.txt")}`,
      root,
      root,
      protectedRoots,
    ),
    undefined,
    "ordinary reads outside the workspace remain available",
  );
  assert.equal(
    validateShellProtectedPaths(
      `printf '%s\\n' $${join(protectedRoot, "auth.json")}`,
      root,
      root,
      protectedRoots,
    ),
    undefined,
    "an unquoted $/ path is relative and must not be mistaken for ANSI-C quoting",
  );
  assert(
    validateShellProtectedPaths(
      "cat .devspace/auth.json",
      outside,
      outside,
      protectedRoots,
    ),
    "an ancestor checkout must not make protected internal state readable",
  );
  assert.equal(
    validateShellProtectedPaths(
      "cat project.txt",
      managedWorktree,
      managedWorktree,
      protectedRoots,
      [managedWorktree],
    ),
    undefined,
    "the current managed worktree remains available inside a protected root",
  );
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

console.log("shell-write-target tests passed");
