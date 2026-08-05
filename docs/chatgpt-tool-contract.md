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
| `project:read` | Discover Projects and saved Tasks, receive instructions, use Skills, read, inspect, and review. |
| `project:write` | Apply guarded patches and request managed worktrees. |
| `process:execute` | Interact with processes and, with `project:write`, start commands. |

`taskRef`, `threadRef`, cursors, and Project references are opaque, authenticated
values. Execution identity is server-held and never enters model tool schemas or
results. A successful open, resume, or hydrate binds it to exactly the trusted
`openai/session` and Actor. Every later Project call resolves that binding and
revalidates it against the current principal, OAuth client, grant, authorization
epoch, scopes, approved roots, Project fingerprint/path, and workspace identity.
Different Actors and different sessions cannot reuse one another's binding;
concurrent sessions may select different Projects. A host session that remains
stable across reconnects or conversations may continue by hydrating its binding.
Selection, hydration, and lifecycle requests for the same session+Actor are
serialized in request order so an older slow request cannot replace newer state.
Missing host session metadata or a missing/stale binding fails closed and
requires explicit open or resume selection. DevSpace never falls back to a
recent, sole, or caller-supplied execution. Old process, replay, workspace, and
execution-private change state do not transfer across reauthorization.

## Public tool surface

Raw `tools/list` contains twelve names. `project_thread_control` carries
`_meta.ui.visibility:["app"]`, so ChatGPT exposes eleven tools to the model and
reserves that one tool for the Project App:

| Tool | Availability | Purpose |
| --- | --- | --- |
| `list_projects` | `project:read` | Discover grant-approved Projects and bounded resumable Task metadata. |
| `project_control` | `project:read` | Model-visible bootstrap actions: open, resume, hydrate, or interrupt. `interrupt` additionally requires `process:execute`. |
| `project_thread_control` | `project:read`; App-only | Resolve/list Actor-private Threads, read status/activity, or pause/archive/complete/close from the Project App. It does not manage saved Tasks. |
| `save_progress` | `project:read` | Save a bounded Project Task and update the current private Thread projection. |
| `read_files` | `project:read` | Read one to eight known files with versions. |
| `inspect` | `project:read` | Run one to eight grep, glob, or directory-list operations. |
| `skills` | `project:read` | Search Skill metadata or load one selected Skill. |
| `apply_patch` | `project:read project:write` | Apply a version-guarded Project-relative patch. |
| `show_changes` | `project:read` | Read a bounded repository diff or execution patch journal selected by `source`. |
| `exec_command` | all three scopes | Start a direct program or an explicitly approved shell command. |
| `write_stdin` | `project:read process:execute` | Send input, close, interrupt, or resize a tracked process. |
| `read_process_output` | `project:read process:execute` | Poll a process or read retained output without mutating it. |

After `project_control` selects an execution, model-facing file, process, patch,
review, Skill, and progress tools are called without an execution reference.

## Project bootstrap and App task controls

`list_projects` returns only opaque references and labels for approved roots;
it never exposes local paths. Each Project entry includes a bounded `tasks`
array whose entries contain `taskRef`, title, timestamps, status, and version.
The top-level `taskTrust:"untrusted"` marks all saved labels as historical
model input, and `taskLimits` reports the per-Project and total listing bounds.
Passing `projectRef` requests the complete bounded Task list for that Project.

The model-facing `project_control` accepts exactly four actions:

```json
{
  "action":"open",
  "projectRef":"project_...",
  "operationId":"open-001",
  "checkoutKind":"checkout"
}
```

Creates a fresh Thread and execution and binds it only after bootstrap context
construction succeeds. With exactly one approved Project,
`projectRef` may be omitted. `checkoutKind` defaults to `checkout`. For a Git
top-level Project and a grant with `project:write`, `checkoutKind:"worktree"`
creates a managed per-Thread worktree under the private DevSpace state
directory. Identical retries reuse the same execution and worktree.

```json
{
  "action":"resume",
  "projectRef":"project_...",
  "taskRef":"task_...",
  "operationId":"resume-001"
}
```

Creates and binds a new execution from one explicitly selected saved Task after
bootstrap context construction succeeds. `resume` accepts exactly one `taskRef`
or current Actor-private `threadRef`; the public
cross-chat and reauthorization recovery flow uses `tasks[].taskRef`. DevSpace
never chooses a Task by recency or because it is the only one.

```json
{"action":"hydrate"}
```

Resolves the execution selected for this trusted session+Actor, revalidates it,
refreshes the binding after successful context construction, and returns the
next bounded root instruction page. Continue with the same action and returned
cursor until `rootInstructionsComplete` is true. If a cursor is lost, hydrate
without it to restart the sequence safely.

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

The separate `project_thread_control` is an App-only control-plane tool. Its
`resolve`, `list`, `status`, `activity`, `pause`, `archive`, `complete`, and
`close` actions use strict action-specific fields. They are not part of the
model's tool vocabulary and model instructions must not ask ChatGPT to call
them. The Project App can use session resolution and private Thread listings,
show status and durable activity, and apply lifecycle transitions. Activity
returns only the bounded projection and events it can observe; it does not
repeat an inventory of unavailable host internals.

Pause, archive, and complete preserve the Actor-private Thread and checkout.
Close checks active operations and may remove a clean managed worktree; dirty
worktrees are never removed automatically. These lifecycle actions do not
complete or release capacity for the shared `tasks[].taskRef` record. The model
does that from an active execution with `save_progress(status:"completed")`.

## Bootstrap context schema v8

Open, resume, and hydrate return `schemaVersion:8`, `project`, optional `thread`,
and `contextDelta`. No execution identity appears in the bootstrap object.
`thread.threadRef` is the only Thread reference there. If a checkpoint exists,
`observedStateTrust` is the scalar `"server_observed"`; an optional model summary
has the separate scalar
`modelSummaryTrust:"untrusted"`.

Each instruction contains only `source`, its matching trust value, `scope`,
`path`, and `content`. A page that cuts an instruction adds only
`fragment:{"partial":true}`. Internal range and paging metadata are
not model-visible. A resumed saved Task is projected once into
`thread.checkpoint.modelSummary`; bootstrap does not duplicate it in a second
Task object.

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

Only rows keyed by both trusted session and Actor can authorize implicit model
execution. Existing thread-only continuity rows remain available to the App for
private Thread UX but cannot select a model execution.

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

The MCP server instruction also asks write-enabled, non-trivial Project work to
write or update a concise Project-file handoff after each meaningful phase.
Use `.agent/handoffs/` unless the Project instructions specify another
location. Keep the objective, completed work, verification, blockers, and exact
next steps current. When the task is complete, update the same handoff with its
final status and verification. This file remains visible in the Project and is
distinct from DevSpace saved progress.

`save_progress` stores a title and at-most-8-KiB model summary:

```json
{
  "operationId":"progress-001",
  "title":"Finish parser cleanup",
  "progress":"Re-read src/parser.ts and its focused tests, then run typecheck."
}
```

The first semantic save omits `ifMatch`; later saves require the current saved
Task version. The result returns a `task` object containing `taskRef`, title,
status, version, and update time, plus optional private `thread` metadata when
that projection is available. It never echoes the saved summary. On a Task
revision conflict, call `list_projects(projectRef)`, reconcile the latest Task,
then retry with the same `operationId` and current `ifMatch`; the rejected
attempt did not start an effect. `status:"completed"` removes the Task from
resumable selection, releases resumable capacity, and does not delete Project
files.

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

New patches, commands, process input, App lifecycle changes, and semantic saves
start with a fresh `operationId`. Identical lost-response retries replay their
result; reusing an ID after an accepted or recorded operation with changed
arguments conflicts. A saved-Task revision rejection is the explicit exception:
after list/reconcile, retry that unstarted operation with the same ID and current
`ifMatch`.

`apply_patch` requires an `ifMatch` value for every touched path. Existing
files use the latest `contentHash`; a path expected not to exist uses `null`.
Stale content must be reread and reconciled.

## Commands and processes

Direct argv mode is the default:

```json
{
  "operationId":"command-001",
  "program":"npm",
  "args":["run","typecheck"],
  "workingDirectory":".",
  "environment":{"CI":"1"},
  "yieldTimeMs":10000,
  "maxOutputTokens":12000,
  "tty":false
}
```

Shell syntax is explicit:

```json
{
  "operationId":"command-002",
  "shell":true,
  "command":"npm test | tee test.log",
  "approvalReason":"The pipeline is required to retain a disposable test log."
}
```

Exactly one mode is allowed. `workingDirectory` must stay inside the bound
checkout or worktree. Commands have the full file and inherited network
authority of the DevSpace OS user; there is no process sandbox or per-command
network policy.

All process fields use camelCase: `sessionId`, `closeStdin`, `expectedRevision`,
`yieldTimeMs`, `timeoutMs`, and `maxOutputTokens`. `read_process_output` performs
read-only polling. `write_stdin` requires an operation ID only when it mutates
the process.

For long work, prefer one fixed foreground Project runner in direct argv mode.
Give it a short initial `yieldTimeMs`, then poll the returned session with
`read_process_output` across turns. Increase `yieldTimeMs` when the process is
expected to remain quiet for longer and a longer bounded wait is useful. Let
that runner own preflight, fan-out, PID/log verification, and completion instead
of constructing repeated shell, background, detach, or renamed launcher
wrappers merely to survive a host turn.

## Change review

`show_changes` requires one explicit source:

```json
{"source":"repository"}
```

- `repository` reads staged, unstaged, and untracked changes only when the
  Project root exactly equals its Git top level. Otherwise the tool returns
  `repository_review_unavailable` and recommends `apply_patch_history`.
- `apply_patch_history` is available for Git and non-Git Projects. It contains
  only successful DevSpace `apply_patch` requests from this execution, not
  command writes, external edits, or patches from another execution.

Continuation cursors are bound to the selected source. Keep the same `source`
when paging.

## Recovery principles

- Never guess a Project, Thread, or path.
- Use `list_projects(projectRef)` to select a saved `taskRef` in a new ChatGPT
  conversation or after reauthorization.
- Use `action=hydrate` after a reconnect while the trusted host session remains
  stable. If the binding is missing or stale, explicitly open or resume instead.
- Use `list_projects(projectRef)` to obtain the current saved Task version
  after a save conflict.
- Use the Project App—not model instructions—for Actor-private Thread listings,
  status, activity, and lifecycle transitions. Use
  `save_progress(status:"completed")` for the shared saved Task.
- Reauthorize the Project when its grant or root authorization changed.
- Review or hand off a dirty worktree before any explicit checkout disposal.
- Reread repository files after resuming because the model summary is untrusted.

No lifecycle operation deploys, restarts, or replaces the DevSpace backend.
Those remain explicit local administrative actions outside this tool contract.
