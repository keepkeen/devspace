# ChatGPT Coding Workflow

DevSpace brings a Codex-style coding-agent loop to ChatGPT and other MCP hosts:
inspect the repo, follow local instructions, make scoped edits, run
verification, and show the user what changed.

## Open And Resume Workspaces

The absolute host path is needed only the first time. Give the workspace a
connection-scoped alias:

```json
{
  "path": "~/work/my-project",
  "alias": "my-project"
}
```

`open_workspace` defaults to `contextMode: "metadata"`. It returns identity,
mode, access, generation, and revisions without an operational `workspaceId` or
instruction/Skill bodies. Before work, load full context by alias:

```json
{
  "alias": "my-project",
  "contextMode": "full"
}
```

Call the latter through `get_workspace_context`. Its result contains the
operational `workspaceId`; reuse that ID for later tools in the conversation.

In a new conversation, do not resend or guess the host path. Call
`list_workspaces`, select the intended alias, then call:

```json
{
  "alias": "my-project",
  "contextMode": "full"
}
```

through `resume_workspace`. Aliases and Workspace IDs are scoped to the OAuth
connection, so a second ChatGPT account or a newly registered connector cannot
use them.

ChatGPT OAuth clients use stateless MCP HTTP requests: each tool call may arrive
on a fresh transport, and a stale `mcp-session-id` header is ignored. The
`workspaceId` is the durable continuity key, not the transport session. Other
MCP hosts retain stateful Streamable HTTP behavior.

Do not reopen the same folder by path unless:

- its alias is no longer listed
- the user switches to another folder
- the user switches between checkout and worktree mode

Do not call `close_workspace` as a normal end-of-turn or end-of-conversation
step. Call it only after the user explicitly asks to close or release the
workspace.

`contextMode: "full"` is the safe default for resume/context calls and ignores
revision hints. Only when the exact returned context is still retained may a
caller select `contextMode: "retained"` and pass
`instructionRevision` as `knownInstructionRevision` and `skillRevision` as
`knownSkillRevision`. DevSpace omits only the corresponding unchanged
instruction or Skill context. `contextMode: "metadata"` never returns an
operational handle.

After a backend restart or resident-cache eviction, direct use of an old ID
returns `workspace_resume_required`. Resume by alias with full context. The
response increments `workspaceGeneration` after cold hydration and reloads
agent profiles, Skills, root instructions, and durable review checkpoints.

## Checkout Mode

Checkout mode opens the actual directory and defaults to read-only:

```json
{
  "path": "~/work/my-project"
}
```

Use it for inspection. To modify the current checkout, make that authority
explicit:

```json
{
  "path": "~/work/my-project",
  "writeAccess": "read_write"
}
```

Existing persisted checkout sessions are migrated as writable for continuity.
Read-only workspaces reject `apply_patch`, `exec_command`, mutating
`write_stdin`, and review-checkpoint advancement. Shell execution is disabled
entirely because lexical command inspection is not an OS read-only sandbox.

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

Managed worktrees are writable and are the recommended mode for edits.

Opening the same source commit again on the same OAuth connection reuses the
active managed worktree. Set `forceNew: true` only when the user explicitly
needs a separate isolation. `list_workspaces` reports managed state and the
persisted `dirtySource` flag. Missing managed directories are removed from the
resumable list, while lifecycle cleanup removes only clean expired worktrees;
dirty worktrees are retained.

Uncommitted source checkout changes are not copied into the managed worktree.
DevSpace reports when the source checkout was dirty so the model can decide how
to proceed with the user.

Workspace context also includes a bounded `project` orientation record with up
to 20 top-level names, `empty`, and best-effort Git branch/dirty state. This
avoids a separate directory listing and `git status` round trip after opening.

## Project Instructions

When full workspace context is requested, DevSpace first loads the optional file explicitly
configured by `userInstructionsPath` or `DEVSPACE_USER_INSTRUCTIONS_PATH`, then
the first matching project-root instruction in this priority order:

- `AGENTS.override.md`
- `AGENTS.md`
- `AGENTS.MD`
- `CLAUDE.md`
- `CLAUDE.MD`
- configured project document fallback filenames

Nested instruction files are discovered lazily by path. Read and inspection
tools do not inject their bodies; they return only
`scopedInstructionsAvailable=true`. Before modifying or executing in that
scope, call `load_workspace_instructions` with the intended paths. It returns
only structured `workspaceInstructions[]` records—source, scope, relativePath,
revision, trust, and content—plus a one-time `instructionToken`. Pass that token
to the intended mutation. Instruction Markdown is never concatenated with a
server-authored prompt or error message.

Whitespace-only instruction files are ignored so the next filename in priority
order can apply. DevSpace does not implicitly import `~/.codex/AGENTS.md`;
`DEVSPACE_AGENT_DIR` is used only for compatible Skill discovery. The complete
effective chain—explicit user file, project root, and nested
files—is limited to 32 KiB of UTF-8 content. DevSpace rejects an over-budget
chain instead of silently truncating instructions.

Workspace metadata/context results include an `instructionRevision` beginning with
`sha256-v1:`. It hashes the ordered initial instruction path/content pairs, so
clients can recognize an unchanged chain across later turns without treating a
repeated copy as new policy. A changed path or changed content produces a new
revision.

They also return an independent `skillRevision`. The revision covers the full
discovered Skill set, including content and invocation-policy hashes, even when
the catalog budget omits entries. A matching `knownSkillRevision` suppresses
the catalog only when `contextMode: "retained"` is explicit.

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
Full workspace context exposes a compact catalog with profile names, descriptions,
providers, and optional models/thinking levels so the model can choose a configured agent
without seeing provider-specific launch details.

Example profiles are packaged under `examples/agents/` for users who want
starter templates. Copy or adapt them into one of the active profile directories
before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Full workspace context returns a deterministic Skill catalog capped at 8,000 UTF-8 bytes
serialized characters and reports how many entries were omitted. Descriptions
are shortened before whole same-name groups are omitted. Common entries contain
only selection data; duplicate names additionally receive a privacy-safe
logical path and scope. An exact user-provided Skill name can still be passed
to `load_skill` even if its catalog entry was omitted.

For ChatGPT web, the model should call `load_skill` with the advertised
`skillId` before following a Skill. The tool atomically reads the complete
`SKILL.md` (maximum 64 KiB) and only then activates access to support files. An exact `name` is
also accepted when it identifies one Skill; duplicate names require `skillId`.
This is DevSpace's explicit replacement for Codex's `$skill` and `/skills`
surfaces. Direct and batch reads cannot bypass `load_skill`; activation and
manifest access go through it so the discovery-time hash can be checked.
After loading, `load_skill` returns a virtual root such as
`skill://<skillId>/`. The model can read `references/`, `scripts/`, and other
support files with paths such as
`skill://<skillId>/references/example.md`, without receiving the host's
absolute Skill directory. Traversal, encoded separators, and symlink escapes
remain blocked.

Skill paths may be outside the workspace. DevSpace only permits reading:

- advertised `SKILL.md` files
- files under a skill directory after that skill's `SKILL.md` has been read

Set `DEVSPACE_SKILLS=0` to hide skills from workspace output. Set
`DEVSPACE_SUBAGENTS=1` to expose the experimental subagent catalog and
`subagent-delegation` skill. That skill teaches the minimal
`devspace agents ls`, `devspace agents run`, and `devspace agents show`
workflow. The catalog comes from full context; `devspace agents ls` lists
existing subagent sessions for that workspace.

## Tool Names

DevSpace exposes one fixed Codex-style surface for browser MCP hosts such as
ChatGPT:

- `open_workspace`
- `list_workspaces`
- `resume_workspace`
- `get_workspace_context`
- `load_workspace_instructions`
- `get_operation_status`
- `close_workspace`
- `revoke_workspace`
- `read`
- `batch_read`
- `batch_inspect`
- `load_skill`
- `list_skills`
- `apply_patch`
- `exec_command`
- `write_stdin`
- `read_process_output`

Use `batch_read` when 2–8 file paths are already known, and `batch_inspect` when
2–8 independent grep, glob, or directory-list operations are already known.
Do not batch an iterative investigation when each next target depends on the
previous result.

### Result payload contract

Every tool result uses an `ok` field. A tool that did not start returns a
machine-readable error object instead of requiring the model to interpret its
prose:

```json
{
  "ok": false,
  "error": {
    "code": "workspace_resume_required",
    "retryable": true,
    "safeToRetry": true,
    "recovery": "resume_workspace",
    "phase": "not_started"
  }
}
```

All Workspace-scoped tools require `workspaceId` and `workspaceGeneration`.
Using an old generation returns `stale_workspace_generation` before the tool
starts. Cold hydration, allowed-root changes, credential-epoch changes, and
close/reopen transitions advance the generation.

`apply_patch`, `exec_command`, and a mutating `write_stdin` accept an optional
`operationId`. Use a new ID for each intended mutation. If an HTTP response is
lost, retry the identical call with the same ID: DevSpace replays the stored
result instead of applying the mutation twice. Reusing an ID with different
arguments is rejected. If a crash leaves the outcome unknowable, DevSpace
returns `operation_outcome_unknown` and does not rerun it automatically.
Use `get_operation_status(operationId)` to inspect the retained state without
rerunning the operation or copying its stored result body.

A command that ran and exited nonzero is not a tool transport failure. Its
structured result says `ok=false`, `status="exited"`,
`commandExecuted=true`, and includes `exitCode`. A rejected command has an
`error` and never claims `commandExecuted=true`.

Large model-visible text has one canonical location. DevSpace does not mirror
file contents, Skill manifests, or process output between MCP `content` and
`structuredContent`:

- `read` and `load_skill` return their body only in text `content`. Successful
  reads add `contentHash` and exact decimal-string `mtimeNs` as structured
  metadata; `apply_patch.ifMatch` can require those versions before any write.
- `batch_read` and `batch_inspect` return a short text completion summary and
  keep ordered results in `structuredContent.items[]` as optional `ref`, `ok`,
  `result`, and exceptional `truncated=true`. Top-level `status`, `succeeded`,
  and `failed` make partial completion explicit. Host paths and operations are
  not echoed, and there is no aggregate `result`.
- `exec_command` and `write_stdin` return the current inline output in
  text `content`. Structured data contains process semantics and actionable or
  exceptional fields: `ok`, `status`, `commandExecuted`, active `sessionId`,
  recoverable `outputId`, nonzero `exitCode`, `signal`, and `timedOut=true`.
- `read_process_output` returns the requested UTF-8 page in text `content` and
  keeps only `nextOffset`, terminal `eof=true`, and exceptional/nonterminal
  `status` in `structuredContent`. Absence of `status` means completed;
  `status=unknown` means completion cannot be proved, so verify side effects
  before rerunning.
- `close_workspace`, `apply_patch`, and `show_changes` return one concise text
  result. Their detailed presentation data is UI-only `_meta`.

`_meta` is reserved for optional widget presentation and is not a source of
model-visible state or body text. Widgets read the top-level result instead of
requiring a duplicate `_meta.card.payload.content`. Plain MCP clients may
ignore `_meta`; structured batch consumers must read `items[]` rather than the
removed aggregate field. This layout reduces prompt and transport overhead
without changing workspace, process, or paging semantics.

The legacy `write`, `edit`, `bash`, `grep`, `glob`, and `ls` tools are not
registered. Prefer `exec_command` with `program` and `args`; DevSpace passes
them directly to the process launcher without shell serialization. Use
`shell=true` with `command` only when shell syntax is required. Legacy `cmd`
remains accepted. `network="deny"` fails closed because this runtime does not
claim per-process network isolation without an OS sandbox.

`exec_command` returns a process session ID when a command is still
running after its yield window. Use `write_stdin` to poll it, send input, resize
a PTY, or send Ctrl-C. Set `tty: true` only for commands that need a terminal.
Use `timeoutMs` for a shorter per-command hard deadline; it cannot exceed the
server's global command runtime limit.
For multiline Python, SQL, or remote SSH scripts, pass the body through the
structured `stdin` field instead of nesting shell quotes. Pipe stdin closes by
default after the initial payload; set `closeStdin: false` only when later
`write_stdin` calls must add data. PTY sessions cannot use automatic EOF.
A bounded command policy follows common static nesting and blocks executable
`sudo`, forced or recursive `rm`, and pipe-to-executing-shell. Parse-only shell
checks remain available. Normal workspace shell writes are allowed; explicit
literal targets for common mutations and redirections are rejected if they
leave the workspace. This is an accident guardrail, not an OS sandbox.

`maxOutputTokens` limits only the current inline process response and defaults
to 10,000 tokens. Short output is returned in full; long output keeps a
head/tail summary inside a 1 MiB UTF-8 in-memory content cap. When durable
storage is available, an active process or truncated inline result returns an
opaque `outputId` whose retained UTF-8 bytes can be replayed with
`read_process_output(workspaceId, outputId, offset, limit)`.
The page body is in text `content`; structured paging metadata deliberately
does not repeat it. Use the returned `nextOffset` for the next page. Output
ownership is checked against both the OAuth client and workspace; no local log
path is exposed.
An exceptional text warning reports bytes that exceeded the final durable disk
quota and cannot be recovered. Completed output uses its
own TTL and remains available after the short-lived process session is removed
or after the backend restarts.

Legacy `toolMode`, `DEVSPACE_TOOL_MODE`, and `DEVSPACE_MINIMAL_TOOLS` values are
ignored. This preserves startup compatibility with old configuration files
without changing the model-facing tool names between turns.

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

- the command contract is always `exec_command` + `write_stdin`
- working directory does **not** persist; pass `workingDirectory` when needed and do not rely on `cd`
- shell env vars / aliases do **not** persist
- long-running processes return a `sessionId`; poll with `write_stdin`
- truncated output reports omitted bytes and, when durable storage is available,
  an `outputId` recovery command
- bounded static checks block forced/recursive `rm`, executable `sudo`, and pipe-to-executing-shell
- independent commands should be issued as parallel tool calls; dependent ones use `&&`
- HEREDOC and normal workspace shell writes are allowed
- do not sleep-poll; use session + `write_stdin` instead
