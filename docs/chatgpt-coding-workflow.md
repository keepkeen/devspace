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

Whitespace-only instruction files are ignored so the next filename in priority
order can apply. The complete effective chain—global, project root, and nested
files—is limited to 32 KiB of UTF-8 content. DevSpace rejects an over-budget
chain instead of silently truncating instructions.

Shell calls also inspect literal `cd` and `pushd` targets before execution.
Dynamic targets such as `cd "$TARGET"`, `cd $(command)`, or `cd ~/path` are
rejected because their instruction scope cannot be established safely; pass a
literal `workingDirectory` or literal shell path instead. Cwd destinations must
already exist, inherited `CDPATH` is removed, and opaque nested-shell forms
fail closed. Create a directory in one call and enter it in a later call.
The same check applies to writable `write_stdin` input. DevSpace retains the
current directory of recognized interactive shells and buffers incomplete input
until a newline, so splitting `cd` across MCP calls cannot bypass the gate.
Interactive directory changes must use one standalone literal `cd` per line.
Other processes such as Python REPLs receive opaque stdin without shell parsing.
Polling and a separate Ctrl-C call remain available without an instruction
acknowledgement.

This avoids recursively scanning large repositories during `open_workspace`
while keeping scoped instructions explicit and inspectable.

## Skills

Skills are enabled by default for coding-agent workflows.

DevSpace discovers standard Agent Skills in this order:

- project `.agents/skills` directories from the approved repository boundary down to the opened workspace
- user Skills in `~/.agents/skills`
- Admin Skills in `DEVSPACE_ADMIN_SKILLS_DIR` (default `/etc/codex/skills`)
- Skills bundled with DevSpace

It also keeps compatibility with:

- `~/.devspace/skills`
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

Relative configured paths resolve from the opened workspace, not from the
server process directory. `DEVSPACE_DISABLED_SKILL_PATHS` disables exact Skill
directories or `SKILL.md` paths. Discovery is depth/entry bounded, follows a
symlinked Skill directory only as one Skill root, rejects symlink escapes from
support-file reads, and detects cycles.
Repository ancestors above the most specific matching allowed root are never
scanned or exposed.

Every `SKILL.md` must start with valid YAML frontmatter containing non-empty
string `name` and `description` values. Optional `agents/openai.yaml` metadata
is loaded; `policy.allow_implicit_invocation: false` keeps the Skill available
for an explicit user request but prevents the model from selecting it
implicitly. Skills with the same name are all retained with distinct stable
`skillId`, path, source, and scope values.
Invalid, oversized, or escaping OpenAI metadata fails closed by disabling
implicit invocation while leaving explicit user selection available.

When Subagents are enabled, DevSpace discovers agent profiles
from `~/.devspace/agents/*.md` and project `.devspace/agents/*.md`.
`open_workspace` exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

`open_workspace` returns a deterministic Skill catalog capped at 8,000
serialized characters and reports how many entries were omitted. Descriptions
are shortened before whole entries are omitted. An exact user-provided Skill
name can still be passed to `load_skill` even if its catalog entry was omitted.

For ChatGPT web, the model should call `load_skill` with the advertised
`skillId` before following a Skill. The tool atomically reads the complete
`SKILL.md` (maximum 64 KiB) and only then activates access to support files. An exact `name` is
also accepted when it identifies one Skill; duplicate names require `skillId`.
This is DevSpace's explicit replacement for Codex's `$skill` and `/skills`
surfaces. Direct and batch reads cannot bypass `load_skill`; activation and
manifest access go through it so the discovery-time hash can be checked.

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
- `close_workspace`
- `read`
- `batch_read`
- `batch_inspect`
- `load_skill`
- `apply_patch`
- `exec_command`
- `write_stdin`
- `read_process_output`

Use `batch_read` when 2–8 file paths are already known, and `batch_inspect` when
2–8 independent grep, glob, or directory-list operations are already known.
Do not batch an iterative investigation when each next target depends on the
previous result.

### Result payload contract

Large model-visible text has one canonical location. DevSpace does not mirror
file contents, Skill manifests, or process output between MCP `content` and
`structuredContent`:

- `read` and `load_skill` return their body in text `content`; structured data
  contains only compact identifiers, status, and other follow-up metadata.
- `batch_read` and `batch_inspect` return a short text completion summary and
  keep each independent result in `structuredContent.items[]`. There is no
  concatenated aggregate `structuredContent.result`.
- `exec_command`, `bash`, and `write_stdin` return the current inline output in
  text `content`. Their structured data contains process state such as
  `sessionId`, `running`, `exitCode`, timing/truncation metrics, and `outputId`,
  but no copy of the inline output.
- `read_process_output` returns the requested UTF-8 page in text `content` and
  keeps only paging metadata in `structuredContent`: `outputId`, `offset`,
  `nextOffset`, `eof`, `status`, `totalBytes`, `storedBytes`, and
  `droppedBytes`.

`_meta` is reserved for optional widget presentation and is not a source of
model-visible state or body text. Widgets read the top-level result instead of
requiring a duplicate `_meta.card.payload.content`. Plain MCP clients may
ignore `_meta`; structured batch consumers must read `items[]` rather than the
removed aggregate field. This layout reduces prompt and transport overhead
without changing workspace, process, or paging semantics.

In this mode, `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are not
registered. `exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.
For multiline Python, SQL, or remote SSH scripts, pass the body through the
structured `stdin` field instead of nesting shell quotes. Pipe stdin closes by
default after the initial payload; set `closeStdin: false` only when later
`write_stdin` calls must add data. PTY sessions cannot use automatic EOF.
A small command policy blocks `sudo`, forced or recursive `rm`, and
pipe-to-shell. Normal workspace shell writes are allowed; explicit literal
targets for common mutations and redirections are rejected if they leave the
workspace.

`maxOutputTokens` limits only the current inline process response and defaults
to 10,000 tokens. Short output is returned in full; long output keeps a
head/tail summary inside a 1 MiB UTF-8 in-memory content cap. Every process that
produces output also returns an opaque `outputId` whose retained UTF-8 bytes can
be replayed with `read_process_output(workspaceId, outputId, offset, limit)`.
The page body is in text `content`; structured paging metadata deliberately
does not repeat it. Use the returned `nextOffset` for the next page. Output
ownership is checked against both the OAuth client and workspace; no local log
path is exposed.
`droppedBytes` is nonzero only when the per-output or total durable disk quota
was reached, meaning those bytes cannot be recovered. Completed output uses its
own TTL and remains available after the short-lived process session is removed
or after the backend restarts.

Use `DEVSPACE_TOOL_MODE=full` to expose the dedicated file and shell tools:

- `open_workspace`
- `close_workspace`
- `read`
- `batch_read`
- `batch_inspect`
- `load_skill`
- `write`
- `edit`
- `grep`
- `glob`
- `ls`
- `bash`
- `write_stdin`
- `read_process_output`

Use `DEVSPACE_TOOL_MODE=minimal` for `open_workspace`, `close_workspace`,
`read`, `batch_read`, `batch_inspect`, `load_skill`, `write`, `edit`, `bash`,
`write_stdin`, and `read_process_output` (clients can use the bounded batch
inspection tool or `bash` with `rg`, `find`, and `ls`).

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
- a small command policy blocks forced/recursive `rm`, `sudo`, and pipe-to-shell
- independent commands should be issued as parallel tool calls; dependent ones use `&&`
- HEREDOC and normal workspace shell writes are allowed
- do not sleep-poll; use session + `write_stdin` instead

In `full` / `minimal` modes, `bash` defaults to a 120s timeout (max 600) and
supports `run_in_background`. Shell writes are allowed under the same command
policy; `apply_patch` or edit/write remain preferable for precise reviewed edits.
