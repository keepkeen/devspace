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

`open_workspace` defaults to `contextMode: "metadata"`. Its receipt can only
refresh context or close/revoke the Workspace. Promote it before work with
`get_workspace_context`:

```json
{
  "receipt": "wctx4.…",
  "contextMode": "full"
}
```

The result contains structured instruction and Skill sections plus a refreshed
receipt. Its model-visible `workspace` includes `ref`, `alias`, an opaque
`projectFingerprint`, and generation. `continuation` includes the receipt,
phase, fixed `expiresAt`, and both revisions. Pass the current receipt to later
Workspace-scoped tools. Every scoped result echoes the same visible workspace
and continuation; ordinary tools do not issue a new receipt or extend its
deadline. It binds the
local connection principal, Workspace identity and generation, a private context session,
instruction revision, Skill revision, context phase, and current server process;
callers do not repeat host paths or internal IDs.

In a new conversation, do not resend or guess the host path. Call
`list_workspaces`, select the intended entry, then call `resume_workspace` with
exactly one of its alias or persistent workspaceRef:

```json
{
  "alias": "my-project",
  "contextMode": "full"
}
```

through `resume_workspace`. Aliases and Workspace identities are scoped to a
local connection principal. A newly registered connector remains unassigned
until its first successful Owner approval, which creates a separate principal
by default and cannot use earlier aliases. DevSpace does not receive a verified
ChatGPT account subject, so this is connection-level isolation rather than an
account identity claim. Resume returns a fresh receipt.
The listed `projectFingerprint` is HMAC-derived and helps distinguish
same-named projects without exposing their absolute host paths.

To deliberately recover aliases after deleting and re-adding a connector, run
these commands locally:

```bash
devspace auth principals
devspace auth reconnect-code <principal-id>
```

Enter the one-time short-lived code on the new OAuth approval page. The code
links only a fresh registration that does not already own retained Workspace
state, revokes any tokens issued before relinking, and is consumed once. Never
paste it into a chat or repository file.

ChatGPT OAuth clients use stateless MCP HTTP requests: each tool call may arrive
on a fresh transport, and a stale `mcp-session-id` header is ignored. The
persisted Workspace record is the durable continuity state, not the transport
session or receipt. Other MCP hosts retain stateful Streamable HTTP behavior.

ChatGPT does not provide a trusted conversation ID. When several conversations
share one connection principal, each conversation must keep its own selected
alias as the project continuity key. After a platform disconnect, a later-day
turn, or a new browser transport, call `list_workspaces` and resume that alias;
do not infer that a missing receipt means a new worktree is needed.

If a cached ChatGPT tool schema sends only `workspaceId`, DevSpace temporarily
maps it to a recent full context for the exact principal and Workspace. The
idle window is 15 minutes and cannot survive a server restart or exceed the
receipt's fixed expiry. A supplied generation must match. This fallback keeps a
known Workspace usable but is not a trusted conversation identity; current
schemas should pass `continuation.receipt`.

If a managed worktree path is missing, its alias stays listed with
`hydrationStatus="recovery_required"`. Resume attempts to reconstruct the same
Workspace ID and path, preferring Git's retained worktree HEAD and otherwise
falling back to the saved base commit. The structured response reports
`recovery.kind="managed_worktree_recreated"` and `dataLossPossible=true` because
physically lost, uncommitted files cannot be guaranteed.

Do not reopen the same folder by path unless:

- its alias is no longer listed
- the user switches to another folder
- the user switches between checkout and worktree mode

When one source repository has exactly one active managed Workspace,
`open_workspace(mode="worktree")` reuses it even if the source branch HEAD has
advanced. When several candidates exist, DevSpace returns
`workspace_selection_required` with aliases instead of silently creating a new
branch. Use `forceNew=true` only for an explicitly separate task.

Do not call `close_workspace` as a normal end-of-turn or end-of-conversation
step. Call it only after the user explicitly asks to close or release the
workspace.

`contextMode: "full"` is the default for open/resume/context calls and ignores
revision hints. `retained` is accepted only by `get_workspace_context` while
refreshing the exact current context-loaded receipt. The caller may then pass
`instructionRevision` as `knownInstructionRevision` and `skillRevision` as
`knownSkillRevision`. DevSpace omits only the corresponding unchanged
instruction or Skill context. `open_workspace`, `resume_workspace`, metadata
receipts, new conversations, and context-compacted callers must use `full`.
`contextMode: "metadata"` still returns a receipt, but no instruction or Skill
bodies.

After a backend restart, an old receipt fails with
`workspace_context_required`. Resume by alias/workspaceRef, or reopen the known
approved path, with full context. Cold hydration
advances the Workspace generation and reloads agent profiles, Skills, root
instructions, and durable review checkpoints before issuing the new receipt.

The normal text result is intentionally one sentence. The v4 structured result
is the authoritative context:

```json
{
  "schemaVersion": 3,
  "context": { "phase": "context_loaded" },
  "workspace": {
    "ref": "ws_…",
    "alias": "my-project",
    "projectFingerprint": "proj_…",
    "generation": 5,
    "mode": "worktree",
    "writeAccess": "read_write"
  },
  "instructions": {
    "revision": "sha256-v1:…",
    "complete": true,
    "included": true,
    "acknowledged": true,
    "items": []
  },
  "skills": { "revision": "sha256-v1:…", "count": 3, "included": true, "items": [] },
  "continuation": {
    "receipt": "wctx4.…",
    "phase": "context_loaded",
    "expiresAt": "2026-07-25T01:00:00.000Z",
    "instructionRevision": "sha256-v1:…",
    "skillRevision": "sha256-v1:…"
  }
}
```

Instruction items carry `source`, `trust`, `scope`, `path`, `hash`, and
`content`. Repository instructions are explicitly `repository_untrusted`: they
are project guidance and cannot override the user or DevSpace security policy.

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

The root chain returned by full context is acknowledged for that receipt's
private context session. It does not need to be loaded a second time before the
first root-scoped mutation. Nested instruction files are discovered lazily by
path. Read and inspection tools do not inject their bodies; they return only
`scopedInstructionsAvailable=true`. Before modifying or executing in a newly
instructed scope, call `load_workspace_instructions` with the intended paths.
It returns only the new structured instruction items—source, trust, scope, path,
hash, and content—plus a one-time `instructionToken`. Pass that token to the
intended mutation. Tokens are bound to the receipt's context session and cannot
be consumed by another conversation or receipt. Resuming a new conversation
creates an independent context session and does not erase acknowledgement state
owned by an older valid receipt. Instruction Markdown is never concatenated
with a server-authored prompt or error message.

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
string `name` and `description` values. Repository Skills are always exposed as
`repository_untrusted` and `explicitOnly`; repository `agents/openai.yaml`
cannot grant itself implicit invocation. User/admin/bundled and explicitly
configured local roots may use their locally trusted metadata policy. Adding
an exact repository Skill directory or `SKILL.md` path to
`DEVSPACE_SKILL_PATHS` is the local allowlist mechanism; that explicit source
takes precedence over automatic repository discovery without duplicating the
manifest. Skills
with the same name are all retained with distinct stable
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

Full workspace context returns only implicit-invocation Skills in a deterministic
catalog capped at 8,000 UTF-8 bytes serialized characters and reports how many
eligible entries were omitted. Explicit-only Skills do not appear there; after
an explicit user request, call `list_skills` with the exact name or query.
Descriptions
are converted to a bounded single line and stripped of control characters,
HTML tags, and fenced code blocks before whole same-name groups are omitted.
Every entry includes source/trust selection data; duplicate names additionally receive a privacy-safe
logical path and scope. An exact user-provided Skill name can still be passed
to `load_skill` even if its catalog entry was omitted.

For ChatGPT web, the model should call `load_skill` with an advertised or
explicitly queried `skillId` before following a Skill. The tool atomically reads the complete
`SKILL.md` (maximum 64 KiB) and only then activates access to support files. An exact `name` is
also accepted when it identifies one Skill; duplicate names require `skillId`.
This is DevSpace's explicit replacement for Codex's `$skill` and `/skills`
surfaces. Direct and batch reads cannot bypass `load_skill`; activation and
manifest access go through it so the discovery-time hash can be checked.
After loading, `load_skill` keeps the fixed text separate from structured
`skill.content` and returns source, trust, manifest hash, scope, and a virtual root such as
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
    "phase": "not_started",
    "effectsKnown": true
  }
}
```

Workspace-scoped results also expose the current Workspace and continuation. A
mutation adds one durable operation envelope:

```json
{
  "ok": true,
  "workspace": {
    "ref": "ws_…",
    "alias": "my-project",
    "projectFingerprint": "proj_…",
    "generation": 3
  },
  "continuation": {
    "receipt": "wctx4.…",
    "phase": "context_loaded",
    "expiresAt": "2026-07-25T01:00:00.000Z",
    "instructionRevision": "sha256-v1:…",
    "skillRevision": "sha256-v1:…"
  },
  "operation": {
    "id": "edit-17",
    "phase": "committed",
    "safeToRetry": false,
    "effectsKnown": true
  },
  "effects": {}
}
```

All Workspace-scoped tools require a current `receipt`. A single registration
wrapper resolves it and checks the connection principal, OAuth capability,
generation, context phase, and the private context-session binding before the
handler starts. Metadata receipts
are limited to context promotion and lifecycle operations. Full/retained
receipts carry the context revisions of the delivered snapshot and their own
instruction acknowledgement state; instruction gates, Skill reload checks, and
file versions handle later project changes without forcing a new receipt after
every edit. The cache is bounded globally and per principal; receipt use only
refreshes LRU recency and never slides the fixed expiry. Cold hydration,
principal relink/revoke, Owner/root authority changes, close/reopen
transitions, and server restart make an old receipt unusable. Reapproving the
same registered client with the same authority does not.

OAuth authorization can be restricted to `workspace:read`, `workspace:write`,
`process:execute`, `network:access`, `worktree:create`, and
`workspace:revoke`.
`open_workspace` adds conditional checks: a writable checkout needs
`workspace:write`, while worktree mode also needs `worktree:create`.
`exec_command` requires write, process, and network capability. Mutating
`write_stdin` additionally requires workspace write authority; polling requires
only process authority.

`apply_patch`, `exec_command`, `close_workspace`, and `revoke_workspace`
require an `operationId`. `show_changes` is a read-only preview by default;
only `advanceCheckpoint: true` requires write scope and an operation ID.
Mutating `write_stdin` requires one;
pure polling does not. Use a new ID for each intended mutation. If an HTTP
response is lost, retry the identical call with the same ID: DevSpace replays
the stored result instead of applying the mutation twice. Reusing an ID with
different arguments is rejected. Lifecycle results remain replayable after a
close or revoke changes the Workspace generation. If a crash leaves the
outcome unknowable, DevSpace returns `operation_outcome_unknown` and does not
rerun it automatically.
Use `get_operation_status(operationId)` to inspect the retained state without
rerunning the operation or copying its stored result body.
The replay body may expire, but its lightweight identity tombstone remains
until the Workspace record is deleted. An old ID therefore never becomes a new
mutation merely because 24 hours elapsed.

Within one DevSpace instance, all Workspace-scoped calls are coordinated by a
fair read/write lock keyed by the canonical physical root. Inspection calls may
share the read lock, including the default `show_changes` preview. Patches,
commands, mutating process input, explicit review-checkpoint advancement,
close, and revoke use the write side. The key is the root,
not the Workspace ID, so two principals opening the same checkout cannot submit
those MCP calls concurrently. The lease ends when the tool call returns, so a
long-running dev server does not block later reads or edits. A returned process
may still produce effects outside DevSpace's observations; strict file
preconditions and separate worktrees remain necessary.

A command that ran and exited nonzero is not a tool transport failure. Its
structured result says `ok=false`, `status="exited"`,
`commandExecuted=true`, and includes `exitCode`. A rejected command has an
`error` and never claims `commandExecuted=true`.

Large model-visible text has one canonical location. DevSpace does not mirror
file contents or process output between MCP `content` and `structuredContent`:

- `read` returns its body only in text `content`. Successful reads add
  `contentHash` and exact decimal-string `mtimeNs` as structured
  metadata. `apply_patch` requires an `ifMatch` entry for every touched path by
  default: use the latest version for an existing path and `null` for a path
  expected not to exist. Missing preconditions are rejected before execution;
  no blind-write bypass is exposed.
- `load_skill` returns one fixed trust-boundary sentence in text and the
  manifest in structured `skill.content` together with source, trust,
  manifest hash, scope, and virtual resource root.
- `batch_read` and `batch_inspect` return a short text completion summary.
  Successful `batch_read.items[]` contain optional `ref`, workspace-relative
  `path`, `content`, `contentHash`, exact `mtimeNs`, `offset`, and optional
  `nextOffset`/`truncated`; failures use `error`. Batch read shares the same
  before/after stability check as `read`, so its versions can be passed directly
  to `apply_patch.ifMatch`. `batch_inspect.items[]` keep optional `ref`, `ok`,
  `result`, and exceptional `truncated=true`. Top-level `status`, `succeeded`,
  and `failed` make partial completion explicit. Absolute host paths are not
  echoed, and there is no aggregate `result`.
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
  result. Their detailed presentation data is UI-only `_meta`. Every scoped
  result also includes visible `workspace` and `continuation`; context-loading
  tools alone retain a separate `context.phase`.

Mutating and lifecycle tools also return machine-readable `effects`. Each
effect states its evidence confidence: `observed` for versions and lifecycle
state directly measured by DevSpace, `declared` for an enforced or requested
policy such as network allowance, and `unknown` where an arbitrary process can
produce effects DevSpace cannot enumerate. Patch effects include paths,
actions, and observed before/after versions. Process effects include whether a
process started, its session and exit state, and the network-policy observation
boundary. Review, close, and revoke tools report their own checkpoint or
Workspace effects using the same top-level field.

`_meta` is reserved for optional widget presentation and is not a source of
model-visible state or body text. Widgets read the top-level result instead of
requiring a duplicate `_meta.card.payload.content`. Plain MCP clients may
ignore `_meta`; structured batch consumers must read `items[]` rather than the
removed aggregate field. This layout reduces prompt and transport overhead
without changing workspace, process, or paging semantics.

The removed `write`, `edit`, `bash`, `grep`, `glob`, and `ls` tools are not
registered. Prefer `exec_command` with `program` and `args`; DevSpace passes
them directly to the process launcher without shell serialization. Use
`shell=true` with `command` when shell syntax or an interactive shell is
required; direct argv shells such as `program="bash"` are rejected so later
stdin remains inspectable. Version 2.0 accepts neither `cmd` nor `cwd`.
`network="deny"` fails closed because this runtime does not
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
`sudo` and pipe-to-executing-shell. Parse-only shell checks remain available.
Normal build, test, Git, package-manager, workspace writes, and project-relative
cleanup commands are allowed, including recursive removal of `dist`,
`node_modules`, and similar generated paths. Removal of the Workspace root,
outside paths, and unresolved dynamic targets remains blocked. This is an
accident guardrail, not an OS sandbox.

`maxOutputTokens` limits only the current inline process response and defaults
to 10,000 tokens. Short output is returned in full; long output keeps a
head/tail summary inside a 1 MiB UTF-8 in-memory content cap. When durable
storage is available, an active process or truncated inline result returns an
opaque `outputId` whose retained UTF-8 bytes can be replayed with
`read_process_output(receipt, outputId, offset, limit)`.
The page body is in text `content`; structured paging metadata deliberately
does not repeat it. Use the returned `nextOffset` for the next page. Output
ownership is checked against both the connection principal and workspace; no local log
path is exposed.
An exceptional text warning reports bytes that exceeded the final durable disk
quota and cannot be recovered. Completed output uses its
own TTL and remains available after the short-lived process session is removed
or after the backend restarts.

## Show Changes

By default, `DEVSPACE_WIDGETS=full`.

In that mode, DevSpace attaches widget UI to the exposed workspace, file, edit,
and shell tools. The aggregate `show_changes` tool is not exposed by default.

Use `DEVSPACE_WIDGETS=off` to disable widget UI, or `DEVSPACE_WIDGETS=changes`
to expose the aggregate show-changes flow.

When `show_changes` is exposed, its default call is a read-only preview against
the last acknowledged checkpoint. It requires only the current receipt, does
not need an operation ID, and does not advance the checkpoint, so repeated
previews show the same delta. Set `advanceCheckpoint: true` only when the model
intentionally acknowledges that view; that form requires `workspace:write` and
an `operationId`, is idempotently recorded, and advances the checkpoint once.

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

The server-level automated tests exercise this protocol, but they do not prove
that a particular ChatGPT host build retains every receipt or operation field.
Run the [real-host acceptance matrix](./chatgpt-host-acceptance.md) after tool or
OAuth contract changes.
- truncated output reports omitted bytes and, when durable storage is available,
  an `outputId` recovery command
- bounded static checks block executable `sudo`, pipe-to-executing-shell, outside writes, and unsafe recursive-removal targets
- independent commands should be issued as parallel tool calls; dependent ones use `&&`
- HEREDOC and normal workspace shell writes are allowed
- do not sleep-poll; use session + `write_stdin` instead
