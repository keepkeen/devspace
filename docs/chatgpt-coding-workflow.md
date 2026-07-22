# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open One Workspace

When a conversation needs a local project and does not already have its
`workspaceId`, ChatGPT should call `open_workspace` with the exact path:

```json
{
  "path": "~/work/my-project"
}
```

For checkout mode, DevSpace reuses the active workspace belonging to the same
authorized MCP client and canonical project path. Different authorized clients
receive isolated workspace sessions while operating on the same local files.

The result includes a `workspaceId`. All later file, search, edit, show-changes,
and shell calls in that conversation should reuse the same ID.

Do not reopen the same folder unless:

- the `workspaceId` is rejected as unknown
- the user switches to another folder
- the user switches between checkout and worktree mode

Do not call `close_workspace` as a normal end-of-turn or end-of-conversation
step. Call it only after the user explicitly asks to close or release the
workspace.

## Checkout Mode

Checkout mode is the default. DevSpace opens the actual directory:

```json
{
  "path": "~/work/my-project"
}
```

Use this when the user wants ChatGPT to work in the current checkout.

## Worktree Mode

Use worktree mode for isolated parallel work:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under:

```text
~/.devspace/worktrees
```

Worktree mode requires a Git repository with at least one commit. It starts from
`HEAD` unless `baseRef` is provided.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

## Project Instructions

When a workspace opens, DevSpace loads the first matching global instruction
from the built-in names and the first matching project-root instruction in this
priority order:

- `AGENTS.override.md`
- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`
- configured project document fallback filenames

Nested instruction files are discovered lazily when a later tool enters their
directory scope. DevSpace returns newly applicable instruction content with
that tool result and caches directory listings and file versions. Mutating and
shell tools stop before execution when they discover new instructions, so the
model can follow them and retry safely with the returned one-time
`instructionToken`. The token prevents parallel mutations from bypassing a
newly discovered instruction scope.

Shell calls also inspect literal `cd` and `pushd` targets before execution.
Dynamic targets such as `cd "$TARGET"`, `cd $(command)`, or `cd ~/path` are
rejected because their instruction scope cannot be established safely; pass a
literal `workingDirectory` or literal shell path instead. Cwd destinations must
already exist, inherited `CDPATH` is removed, and opaque nested-shell forms
fail closed. Create a directory in one call and enter it in a later call.

This avoids recursively scanning large repositories during `open_workspace`
while keeping scoped instructions explicit and inspectable.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills from:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also keeps compatibility with:

- the bundled `subagent-delegation` skill when `DEVSPACE_SUBAGENTS=1`, unless `~/.devspace/skills/subagent-delegation/SKILL.md` exists
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

When `open_workspace` returns matching skills, the model should read the
advertised `SKILL.md` before following that skill. `~/...` advertised paths are
accepted. A skill activates only after a successful, complete, unbounded, and
untruncated `SKILL.md` read; partial and batch reads do not activate its
supporting files.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. That skill teaches the minimal
`devspace agents ls`, `devspace agents run`, and `devspace agents show`
workflow. The catalog comes from `open_workspace`; `devspace agents ls` lists
existing subagent sessions for that workspace.

## Tool Names

By default DevSpace runs in `DEVSPACE_TOOL_MODE=codex`, the Codex-style unified
exec surface best suited to browser MCP hosts like ChatGPT. It exposes:

- `open_workspace`
- `read`
- `batch_read`
- `batch_inspect`
- `apply_patch`
- `exec_command`
- `write_stdin`

Use `batch_read` when 2–8 file paths are already known, and `batch_inspect` when
2–8 independent grep, glob, or directory-list operations are already known.
Do not batch an iterative investigation when each next target depends on the
previous result.

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.
A small command policy blocks `rm -f`, `sudo`, and pipe-to-shell and tells the
model to use `apply_patch` instead.

Use `DEVSPACE_TOOL_MODE=full` to expose the dedicated file and shell tools:

- `open_workspace`
- `read`
- `batch_read`
- `batch_inspect`
- `write`
- `edit`
- `grep`
- `glob`
- `ls`
- `bash`
- `write_stdin`

Use `DEVSPACE_TOOL_MODE=minimal` for `open_workspace`, `read`, `batch_read`,
`batch_inspect`, `write`, `edit`, `bash`, and `write_stdin` (clients can use
the bounded batch inspection tool or `bash` with `rg`, `find`, and `ls`).

## Show Changes

By default, `DEVSPACE_WIDGETS=full`.

In that mode, DevSpace attaches widget UI to the exposed workspace, file, edit,
and shell tools. The aggregate `show_changes` tool is not exposed by default.

Use `DEVSPACE_WIDGETS=off` to disable widget UI, or `DEVSPACE_WIDGETS=changes`
to expose the aggregate show-changes flow.

When `show_changes` is exposed, models should call it exactly once after the
final file modification in any turn that changes files. The tool only requires
the `workspaceId`; DevSpace automatically compares against the last shown
checkpoint and advances that checkpoint after rendering the aggregate diff.

## Shell Use

The shell tool is for commands that belong in a terminal:

- tests
- builds
- git inspection
- package scripts
- environment checks

Behavior is aligned with Codex's unified exec surface:

- default tool mode is `codex` (`exec_command` + `write_stdin`)
- working directory does **not** persist; pass `workingDirectory` when needed and do not rely on `cd`
- shell env vars / aliases do **not** persist
- long-running processes return a `sessionId`; poll with `write_stdin`
- truncated output reports approximate original token count and omitted bytes
- a small command policy blocks `rm -f`, `sudo`, and pipe-to-shell
- independent commands should be issued as parallel tool calls; dependent ones use `&&`
- HEREDOC is allowed for git commit / `gh pr` message bodies only
- do not sleep-poll; use session + `write_stdin` instead

In `full` / `minimal` modes, `bash` defaults to a 120s timeout (max 600) and
supports `run_in_background`. File writes for project source should go through
`apply_patch` (codex) or edit/write (full/minimal) rather than shell redirection,
`tee`, `sed -i`, or generated scripts.
