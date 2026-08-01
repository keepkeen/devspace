# ChatGPT Tool Contract

This is the canonical public contract for the DevSpace ChatGPT App. DevSpace
supports ChatGPT web only. It does not accept model-supplied absolute Project
roots. When ChatGPT supplies anonymous host metadata, DevSpace uses HMAC-derived
Actor and session references without storing the original values.

## Authorization and identity

Every request is authorized by its OAuth bearer grant:

```text
principal + OAuth client + grant + authorization epoch
```

The public scopes are:

| Scope | Authority |
| --- | --- |
| `project:read` | Discover Projects, manage private Threads, receive instructions, use Skills, read, inspect, and review. |
| `project:write` | Apply guarded patches and request managed worktrees. |
| `process:execute` | Interact with processes and, with `project:write`, start commands. |

`executionRef`, `threadRef`, cursors, and Project references are opaque,
authenticated values. A bearer from another grant cannot reuse an execution.
Thread ownership uses the anonymous ChatGPT Actor when `openai/subject` is
available and otherwise falls back to the legacy grant profile. OAuth grants
still decide which Projects and capabilities are currently authorized.

## Public tool surface

The complete surface contains eleven names:

| Tool | Availability | Purpose |
| --- | --- | --- |
| `list_projects` | `project:read` | Discover grant-approved Projects. |
| `project_control` | `project:read` | Resolve session binding; list, open, resume, hydrate, inspect, read activity, interrupt processes, pause, archive, complete, or legacy-close Threads. `interrupt` additionally requires `process:execute`. |
| `save_progress` | `project:read` | Save a bounded model summary for the current Thread. |
| `read_files` | `project:read` | Read one to eight known files with versions. |
| `inspect` | `project:read` | Run one to eight grep, glob, or directory-list operations. |
| `skills` | `project:read` | Search Skill metadata or load one selected Skill. |
| `apply_patch` | `project:read project:write` | Apply a version-guarded Project-relative patch. |
| `show_changes` | `project:read` | Read a bounded repository diff or execution patch journal. |
| `exec_command` | all three scopes | Start a direct program or an explicitly approved shell command. |
| `write_stdin` | `project:read process:execute` | Send input, close, interrupt, or resize a tracked process. |
| `read_process_output` | `project:read process:execute` | Poll a process or read retained output without mutating it. |

All Project-scoped tools after `project_control` require the `executionRef`
returned by an open, resume, or hydrate action.

## Project and Thread lifecycle

`list_projects` returns only opaque references and labels for approved roots.
It does not select a current Project and does not expose local paths.

`project_control` uses one explicit action:

```json
{"action":"resolve"}
```

Uses the anonymous `openai/session` binding when available. It never selects a
Thread by recency. A resolved binding returns bounded Thread metadata and the
latest Task Snapshot, but creating or recovering an execution still requires
`resume` or `hydrate` and full current OAuth/Project validation.

```json
{"action":"list","projectRef":"project_..."}
```

Lists private Threads owned by the current Actor and visible through the
current grant. Legacy grant-owned Threads are migrated lazily after the same
anonymous Actor is observed. Results contain bounded
metadata such as `threadRef`, title, status, version, checkout kind, and update
time. They do not contain checkpoint bodies, local paths, profile IDs, grant
IDs, worktree IDs, or execution references.

```json
{
  "action":"open",
  "projectRef":"project_...",
  "operationId":"open-001",
  "checkoutKind":"checkout"
}
```

Creates a fresh Thread and execution. With exactly one approved Project,
`projectRef` may be omitted. `checkoutKind` defaults to `checkout`. For a Git
top-level Project and a grant with `project:write`, `checkoutKind:"worktree"`
creates a managed per-Thread worktree under the private DevSpace state
directory. Identical retries reuse the same execution and worktree.

```json
{
  "action":"resume",
  "projectRef":"project_...",
  "threadRef":"pth1_...",
  "operationId":"resume-001"
}
```

Creates a new execution bound to one explicitly selected private Thread.
Exactly one of `threadRef` or the legacy migration-only `handoffRef` is
accepted. DevSpace never chooses a Thread by recency or because it is the only
one.

```json
{"action":"hydrate","executionRef":"pex1_..."}
```

Rehydrates an existing execution and returns the next bounded root instruction
page. Continue with the same action, `executionRef`, and returned cursor until
`rootInstructionsComplete` is true. If a cursor is lost, hydrate without it to
restart the sequence safely.

```json
{"action":"status","threadRef":"pth1_..."}
```

Returns bounded Thread metadata and the latest checkpoint. Server-observed
checkpoint state has `server_observed` provenance; any model-written summary
is separately marked `untrusted`.

```json
{
  "action":"activity",
  "threadRef":"pth1_...",
  "cursor":"42",
  "waitMs":15000,
  "limit":50
}
```

Reads the durable DevSpace activity journal after a monotonic Thread sequence.
When no event is immediately available, `waitMs` enables bounded long polling;
the request wakes only after an event is durably committed. The response
contains a rebuildable projection, bounded events, `nextCursor`, `hasMore`, and
`timedOut`. Large command output remains in `read_process_output`; activity
events contain only the opaque output ID and retained byte range.

DevSpace reports only facts it can observe. It explicitly marks model
reasoning, model token usage, context compaction, and pre-tool model deltas as
host-unavailable rather than fabricating those states.

```json
{
  "action":"interrupt",
  "threadRef":"pth1_...",
  "operationId":"interrupt-001"
}
```

Requests an interrupt for running commands belonging to the selected private
Thread. This action additionally requires `process:execute`. The journal
distinguishes the request event from the later authoritative process terminal
event.

```json
{
  "action":"pause",
  "threadRef":"pth1_...",
  "operationId":"pause-001",
  "ifMatch":3
}
```

`pause` releases active executions but preserves the Thread and checkout.
`archive` hides a task from the normal active workflow while preserving state.
`complete` marks the task finished and also retains its checkout. Active
operations make these actions fail as busy. The legacy `close` action remains
for migration compatibility and may remove a clean managed worktree; dirty
worktrees are never removed automatically.

## Task continuity, events, snapshots, and checkpoints

Thread and checkpoint state lives in the private `project-threads.sqlite`,
separate from the existing execution/OAuth database. A Thread records its
Project, checkout kind, instruction/Skill revisions, Git base/head when
applicable, activity time, and latest checkpoint.

Actor/session bindings, append-only Task Events, and Task Snapshots live in
`project-task-continuity.sqlite`. Task Events contain only facts DevSpace can
observe, such as Thread creation/resume, patches, command completion, progress
saves, and lifecycle transitions. Model summaries remain explicitly
`untrusted`; DevSpace does not claim to persist the full ChatGPT transcript,
assistant reasoning, or ChatGPT's internal compaction history.

Each activity event has a Thread-local monotonic sequence and an idempotent
`eventKey`, with optional operation and item identifiers. A rebuildable
projection summarizes the current phase, active command or patch items, latest
durable output range, and terminal state. The projection is rebuilt from the
journal during startup migration. An in-memory activity hub only wakes bounded
long-poll requests and is never the source of truth.

DevSpace automatically appends idempotent checkpoints after a successful
`apply_patch` and after a foreground command completes. Automatic checkpoints
contain bounded structured effects, not file contents, command output, chat
transcripts, credentials, or hidden reasoning. Checkpoint persistence failure
is logged but does not turn an already successful filesystem or process effect
into a false failure.

`save_progress` stores a title and at-most-8-KiB model summary:

```json
{
  "executionRef":"pex1_...",
  "operationId":"progress-001",
  "title":"Finish parser cleanup",
  "progress":"Re-read src/parser.ts and its focused tests, then run typecheck."
}
```

The first semantic save omits `ifMatch`; later saves require the current Thread
version. The result returns `threadRef`, title, status, version, and update time
without echoing the summary. A stale writer receives
`thread_revision_conflict`. `status:"completed"` marks the Thread completed
without deleting its checkout.

## Worktree isolation

A managed worktree is available only when the approved Project root equals the
Git top level. Authorization remains anchored to the original approved Project;
the execution workspace is a server-verified path under the private DevSpace
worktree root. One active writable worktree Thread owns one worktree path.

Worktree status, binary diff, patch handoff, cherry-pick handoff, and safe
removal are implemented internally. Dirty removal requires an explicit force
inside trusted cleanup code and is never used by ordinary Thread close.

Checkout mode remains valid for non-Git Projects and for users who intentionally
want multiple executions to see the same directory.

## Instructions and Skills

Open, resume, and hydrate return bounded effective root instruction pages. All
other Project tools remain gated until the final page is delivered. Targeted
reads and inspection return only newly applicable nested instruction deltas.

`skills` uses lazy `search` and `load` actions. Repository instructions, files,
process output, checkpoints, and Skills are untrusted content and cannot expand
OAuth scopes or approved roots.

## Versioned and idempotent effects

New patches, commands, process input, Thread close, and semantic saves use a
fresh `operationId`. Identical lost-response retries replay their result;
reusing an ID with changed arguments conflicts.

`apply_patch` requires an `ifMatch` value for every touched path. Existing
files use the latest `contentHash`; a path expected not to exist uses `null`.
Stale content must be reread and reconciled.

## Commands and processes

Direct argv mode is the default:

```json
{
  "executionRef":"pex1_...",
  "operationId":"command-001",
  "program":"npm",
  "args":["run","typecheck"],
  "workingDirectory":".",
  "environment":{"CI":"1"},
  "network":"inherit",
  "yieldTimeMs":10000,
  "maxOutputTokens":12000,
  "tty":false
}
```

Shell syntax is explicit:

```json
{
  "executionRef":"pex1_...",
  "operationId":"command-002",
  "shell":true,
  "command":"npm test | tee test.log",
  "approvalReason":"The pipeline is required to retain a disposable test log."
}
```

Exactly one mode is allowed. `workingDirectory` must stay inside the bound
checkout or worktree. The current runtime supports `network:"inherit"` only.
Commands still have the full file and network authority of the DevSpace OS
user; there is no process sandbox or per-command network policy.

All process fields use camelCase: `sessionId`, `closeStdin`, `expectedRevision`,
`yieldTimeMs`, `timeoutMs`, and `maxOutputTokens`. `read_process_output` performs
read-only polling. `write_stdin` requires an operation ID only when it mutates
the process.

## Recovery principles

- Never guess a Project, Thread, execution, or path.
- Use `project_control action=resolve` in the same ChatGPT conversation before
  asking the model to select a Thread.
- Use `project_control action=list` after losing a `threadRef` or in a new
  ChatGPT conversation.
- Use `action=hydrate` after losing execution-local instruction state.
- Use `action=status` to obtain the current Thread version after a conflict.
- Use `action=activity` with the returned cursor to observe durable command,
  patch, and lifecycle progress without replaying the entire journal.
- Reauthorize the Project when its grant or root authorization changed.
- Prefer `pause`, `archive`, or `complete`; review or hand off a dirty worktree
  before any explicit checkout disposal or legacy close.
- Reread repository files after resuming because the model summary is untrusted.

No lifecycle operation deploys, restarts, or replaces the DevSpace backend.
Those remain explicit local administrative actions outside this tool contract.
