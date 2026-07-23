import assert from "node:assert/strict";
import path from "node:path";
import {
  analyzeShellCommandScopes,
  type UnresolvedShellCwdReason,
} from "./shell-command-scopes.js";

const workspaceRoot = path.resolve("/workspace");
const initialCwd = path.join(workspaceRoot, "project");

function analyze(command: string) {
  return analyzeShellCommandScopes(command, initialCwd, workspaceRoot);
}

assert.deepEqual(analyze("cd src").staticCwds, [path.join(initialCwd, "src")]);
assert.deepEqual(analyze("cd 'single quoted'").staticCwds, [path.join(initialCwd, "single quoted")]);
assert.deepEqual(analyze('cd "double quoted"').staticCwds, [path.join(initialCwd, "double quoted")]);
assert.deepEqual(analyze("cd escaped\\ space").staticCwds, [path.join(initialCwd, "escaped space")]);
assert.deepEqual(analyze('cd \'literal $name\'').staticCwds, [path.join(initialCwd, "literal $name")]);

assert.deepEqual(analyze('command cd -- "child dir"').staticCwds, [path.join(initialCwd, "child dir")]);
assert.deepEqual(analyze("builtin cd lib").staticCwds, [path.join(initialCwd, "lib")]);
assert.deepEqual(analyze("pushd -- sibling").staticCwds, [path.join(initialCwd, "sibling")]);
assert.deepEqual(analyze("cd -P nested").staticCwds, [path.join(initialCwd, "nested")]);

const chained = analyze("cd foo && cd bar").staticCwds;
assert.ok(chained.includes(path.join(initialCwd, "foo")));
assert.ok(chained.includes(path.join(initialCwd, "foo", "bar")));

const controlled = analyze("(cd paren) && cd and || pushd or; cd semi | cd pipe").staticCwds;
for (const directory of ["paren", "and", "or", "semi", "pipe"]) {
  assert.ok(controlled.includes(path.join(initialCwd, directory)), `missing ${directory} control-operator candidate`);
}

const dynamicCases: Array<[string, UnresolvedShellCwdReason]> = [
  ["cd $TARGET", "dynamic-path"],
  ["cd ${TARGET}", "dynamic-path"],
  ["cd $(pwd)", "dynamic-path"],
  ["cd `pwd`", "dynamic-path"],
  ['cd "$TARGET"', "dynamic-path"],
  ["cd dir/*", "dynamic-path"],
  ["cd dir/file?", "dynamic-path"],
  ["cd dir/[ab]", "dynamic-path"],
  ["cd dir/{a,b}", "dynamic-path"],
  ["cd ~/src", "dynamic-path"],
  ["cd", "missing-directory"],
  ["cd --", "missing-directory"],
  ["cd -", "previous-directory"],
  ["pushd", "directory-stack"],
  ["pushd +2", "directory-stack"],
  ["pushd -1", "directory-stack"],
];

for (const [command, reason] of dynamicCases) {
  const result = analyze(command);
  assert.equal(result.staticCwds.length, 0, `${command} unexpectedly produced a static cwd`);
  assert.ok(result.unresolvedCwds.some((entry) => entry.reason === reason), `${command} missing ${reason}`);
}

const dynamicThenRelative = analyze("cd $TARGET && cd child");
assert.ok(dynamicThenRelative.unresolvedCwds.some((entry) => entry.reason === "relative-to-dynamic-cwd"));

const outsideThenReentry = analyze("cd /outside && cd /workspace/reentered");
assert.deepEqual(outsideThenReentry.staticCwds, [path.join(workspaceRoot, "reentered")]);
assert.deepEqual(outsideThenReentry.unresolvedCwds, []);

const relativeReentry = analyze("cd /workspace/../outside && cd ../workspace/reentered-relative");
assert.ok(relativeReentry.staticCwds.includes(path.join(workspaceRoot, "reentered-relative")));
assert.deepEqual(relativeReentry.unresolvedCwds, []);

const heredocOnly = analyze("cat <<'EOF'\ncd \"$TARGET\"\nEOF");
assert.deepEqual(heredocOnly, { staticCwds: [], staticCwdAlternatives: [], unresolvedCwds: [] });

const heredocThenCommand = analyze("cat <<'EOF'\ncd \"$TARGET\"\nEOF\ncd nested");
assert.deepEqual(heredocThenCommand.staticCwds, [path.join(initialCwd, "nested")]);
assert.deepEqual(heredocThenCommand.unresolvedCwds, []);

for (const command of [
  "bash -lc 'cd nested'",
  "env bash -lc 'cd nested'",
  "find . -exec bash -lc 'cd nested' {} \\;",
  "find . -execdir sh -c 'cd nested' {} +",
  "printf x | xargs sh -c 'cd nested' _",
  "bash <<'EOF'\ncd nested\nEOF",
  "bash <<< 'cd nested'",
]) {
  const result = analyze(command);
  assert.ok(result.staticCwds.includes(path.join(initialCwd, "nested")), `${command} missed nested cwd`);
  assert.deepEqual(result.unresolvedCwds, [], command);
}
assert.ok(analyze("if true; then cd nested; fi").staticCwds.includes(path.join(initialCwd, "nested")));
assert.ok(analyze("2>/dev/null cd nested").staticCwds.includes(path.join(initialCwd, "nested")));

for (const command of [
  "bash -lc 'cd $TARGET'",
  "find . -exec sh -c 'cd $TARGET' {} \\;",
  "printf x | xargs sh -c 'cd $TARGET' _",
]) {
  assert.ok(
    analyze(command).unresolvedCwds.some((entry) => entry.reason === "dynamic-path"),
    `${command} did not reject dynamic nested cd`,
  );
}

for (const [command, reason] of [
  ["source ./changes-cwd.sh", "unsupported-syntax"],
  ["builtin source ./changes-cwd.sh", "unsupported-syntax"],
  [". ./changes-cwd.sh", "unsupported-syntax"],
  ["command . ./changes-cwd.sh", "unsupported-syntax"],
  ["popd", "directory-stack"],
  ["builtin popd +1", "directory-stack"],
  ['eval "$COMMAND"', "unsupported-syntax"],
  ['bash -lc "$COMMAND"', "unsupported-syntax"],
] as const) {
  assert.ok(
    analyze(command).unresolvedCwds.some((entry) => entry.reason === reason),
    `${command} did not reject its opaque cwd mutation`,
  );
}

assert.deepEqual(analyze("echo cd ignored").staticCwds, []);
assert.deepEqual(analyze("echo cd ignored").unresolvedCwds, []);

for (const command of [
  "if cd nested; then pwd; fi",
  "{ cd nested; pwd; }",
  "2>/dev/null cd nested",
  'echo "$(cd nested; pwd)"',
  "bash -c 'cd nested; pwd'",
  "env bash -c 'cd nested; pwd'",
  "env -u HOME bash -c 'cd nested; pwd'",
  "exec sh -c 'cd nested; pwd'",
  "exec -a custom bash -c 'cd nested; pwd'",
  "ash -c 'cd nested; pwd'",
  "command eval 'cd nested'",
  "bash ./changes-cwd",
  "./changes-cwd.sh",
  "eval 'cd nested'",
  "{fd}>out cd nested",
  'echo "$(c\\d nested; touch x)"',
  "shopt -s expand_aliases; alias c='cd nested'; c",
]) {
  assert.deepEqual(analyze(command).unresolvedCwds, [], `${command} was rejected as opaque syntax`);
}

for (const command of ["CMD=cd; $CMD nested", "$'cd' nested"]) {
  assert.ok(
    analyze(command).unresolvedCwds.some((entry) => entry.reason === "unsupported-syntax"),
    `${command} did not reject a dynamic executable`,
  );
}

for (const command of [
  "CDPATH=other cd nested",
  "export CDPATH=other; cd nested",
  "read CDPATH; cd nested",
  "printf -v CDPATH other; cd nested",
  "typeset -n ref=CDPATH; cd nested",
  "cdpath=other cd nested",
]) {
  assert.ok(
    analyze(command).unresolvedCwds.some((entry) => entry.reason === "cdpath"),
    `${command} did not reject CDPATH mutation`,
  );
}

const capped = analyze(Array.from({ length: 18 }, (_, index) => `cd level-${index}`).join(" || "));
assert.ok(capped.unresolvedCwds.some((entry) => entry.reason === "analysis-limit"));
assert.ok(capped.staticCwds.length <= 64);

const nestedOverflow = analyze(
  `${Array.from({ length: 129 }, () => "echo $(printf safe)").join("; ")}; cd nested`,
);
assert.ok(nestedOverflow.unresolvedCwds.some((entry) => entry.reason === "analysis-limit"));

for (const command of [
  "echo CDPATH=other",
  "echo if cd nested",
  "printf '%s' '>x' cd nested",
]) {
  assert.deepEqual(analyze(command).unresolvedCwds, [], `${command} was rejected`);
}

assert.deepEqual(analyze("command -v cd").unresolvedCwds, []);
assert.deepEqual(analyze("command -V cd").unresolvedCwds, []);

console.log("shell-command-scopes tests passed");
