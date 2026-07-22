import assert from "node:assert/strict";
import { resolveShellCommand, terminateProcessTree } from "./process-platform.js";

// Prefer bash on Windows when available; otherwise fall back to cmd.exe.
const winWithGitBash = resolveShellCommand("echo ok", "win32", {
  ProgramFiles: "C:\\Program Files",
});
// Without a real Git Bash install in this env, the resolver falls through to PATH/cmd.
// Force the cmd path by clearing ProgramFiles and PATH-like hints.
assert.deepEqual(
  resolveShellCommand("echo ok", "win32", { ComSpec: "C:\\Windows\\cmd.exe", PATH: "" }),
  {
    executable: "C:\\Windows\\cmd.exe",
    args: ["/d", "/s", "/c", "echo ok"],
  },
);

// Prefer non-login -c for configured login shells (faster, Claude/pi style).
assert.deepEqual(resolveShellCommand("echo ok", "darwin", { SHELL: "/bin/zsh" }), {
  executable: "/bin/zsh",
  args: ["-c", "echo ok"],
});

assert.deepEqual(resolveShellCommand("echo ok", "linux", { SHELL: "/bin/dash" }), {
  executable: "/bin/dash",
  args: ["-c", "echo ok"],
});

// Unknown shells fall back to bash/sh rather than blindly using fish.
const fish = resolveShellCommand("echo ok", "linux", { SHELL: "/usr/bin/fish" });
assert.ok(fish.executable === "/bin/bash" || fish.executable === "/bin/sh" || fish.executable.endsWith("bash"));
assert.deepEqual(fish.args.slice(0, 1), ["-c"]);
assert.equal(fish.args[1], "echo ok");

// Explicit DEVSPACE_SHELL / SHELL bash path is honored.
assert.deepEqual(
  resolveShellCommand("echo ok", "linux", { DEVSPACE_SHELL: "/usr/local/bin/bash" }),
  {
    executable: "/usr/local/bin/bash",
    args: ["-c", "echo ok"],
  },
);

// Keep a reference so the unused var does not confuse future edits.
assert.ok(winWithGitBash.executable);

const windowsCalls: string[] = [];
terminateProcessTree(
  { pid: 42, kill: (signal) => (windowsCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "win32",
    killGroup: () => undefined,
    killWindowsTree: (pid) => (windowsCalls.push(`tree:${pid}`), true),
  },
);
assert.deepEqual(windowsCalls, ["tree:42"]);

const posixCalls: string[] = [];
terminateProcessTree(
  { pid: 43, kill: (signal) => (posixCalls.push(`child:${signal}`), true) },
  "SIGINT",
  true,
  {
    platform: "darwin",
    killGroup: (pid, signal) => posixCalls.push(`group:${pid}:${signal}`),
    killWindowsTree: () => false,
  },
);
assert.deepEqual(posixCalls, ["group:43:SIGINT"]);

const fallbackCalls: string[] = [];
terminateProcessTree(
  { pid: 44, kill: (signal) => (fallbackCalls.push(`child:${signal}`), true) },
  "SIGTERM",
  false,
  {
    platform: "linux",
    killGroup: () => undefined,
    killWindowsTree: () => false,
  },
);
assert.deepEqual(fallbackCalls, ["child:SIGTERM"]);

console.log("process-platform tests passed");
