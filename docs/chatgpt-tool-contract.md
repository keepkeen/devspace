# ChatGPT Tool Contract

This is the canonical public contract for the DevSpace ChatGPT App. DevSpace
supports ChatGPT web only. It does not accept model-supplied absolute Project
roots. When ChatGPT supplies anonymous host metadata, DevSpace uses HMAC-derived
Actor and session references without storing the original values.

## Tool-result visibility

The published ChatGPT contract exposes result `content` and
`structuredContent` to both the model and the App component and includes them in
the conversation transcript. Result `_meta` is delivered only to the component
and is hidden from the model. DevSpace uses `_meta` for UI-only projection data;
model decisions and recovery state remain in `content` or
`structuredContent`. Model-hidden does not mean trusted: `_meta` never grants
authority and is not a substitute for OAuth checks, secure storage, Project
containment, or server-side validation.

Reference: https://developers.openai.com/plugins/reference#tool-results

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
| `write_stdin` | `project:read process:execute` | Send input, close, or interrupt a tracked process. |
| `read_process_output` | `project:read process:execute` | Poll a process or read retained output without mutating it. |

After `project_control` selects an execution, model-facing file, process, patch,
review, Skill, and progress tools are called without an execution reference.

## Project bootstrap and App task controls

Global `list_projects` returns only opaque references, labels, and exact
`resumableTaskCount` values for approved roots; it never exposes local paths or
Task titles/timestamps for unselected Projects. Passing `projectRef` requests
that Project's bounded `tasks` array. Each Task contains only `taskRef`, title,
version, and `updatedAt`, and top-level `taskTrust:"untrusted"` marks the saved
labels as historical model input. `truncated` reports a bounded Project or
scoped Task listing; fixed listing limits are not model-visible.

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
Project mutation operation IDs are opaque, well-formed, non-empty Unicode
strings without NUL and are limited to 128 UTF-8 bytes. DevSpace preserves the
exact submitted value;
it does not trim or normalize before hashing or persistence. The same shared
validation runs at the public tool boundary and every durable store entry, so an
invalid ID fails before reservation, process start, or another mutation effect.
Creation identity is also
bound to the trusted Actor derived from host subject/organization metadata, so
two Actors sharing one OAuth grant cannot replay or rebind each other's
execution by choosing the same operation ID. Grant-wide legacy Thread owners
are never reassigned by list, hydrate, replay, activity, interrupt, or lifecycle
calls; an ownership record that cannot be verified for the current Actor fails
closed.

```json
{
  "action":"resume",
  "projectRef":"project_...",
  "taskRef":"task_...",
  "operationId":"resume-001"
}
```

Creates and binds a new execution from one explicitly selected saved Task after
bootstrap context construction succeeds. Model-side `resume` requires exactly
one `taskRef`; private Thread discovery and lifecycle remain App-only. DevSpace
never chooses a Task by recency or because it is the only one.

```json
{"action":"hydrate"}
```

Resolves the execution selected for this trusted session+Actor, revalidates it,
refreshes the binding after successful context construction, and returns the
next bounded root instruction page. Continue with the same action and returned
`nextCursor` until no cursor remains. If a cursor is lost, hydrate without it to
restart the sequence safely.

```json
{
  "action":"interrupt",
  "operationId":"interrupt-001"
}
```

Requests an interrupt only for running commands in the execution bound to the
trusted current session+Actor. Model input cannot select a private Thread or a
different execution. A missing binding returns open/resume recovery. This action
additionally requires `process:execute`. The private journal
distinguishes the request event from the later authoritative process terminal
event; the model result contains only the interrupted count, not raw session IDs.

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

## Bootstrap context

The first open, resume, or cursorless hydrate page returns `project`, optional
`checkpoint`, `instructions`, and optional `nextCursor`/diagnostics. `project`
contains only its ref, write access, and checkout kind. No private Thread,
execution identity, success constant, schema version, or redundant completion
boolean appears in the model bootstrap object. Cursor continuation pages contain only new
`instructions` and an optional `nextCursor`; absence of the cursor means root
hydration is complete. Private Thread identity and presentation fields remain in
model-hidden `_meta` or the App-only control plane. If a checkpoint exists, its
trusted facts are nested under `serverObserved`; an optional historical model
summary is separately named `untrustedSummary`.

Each instruction contains `trustClass`, `path`, and `content`. Repository
instructions use `repository_untrusted`. A nested instruction also contains its
non-root `scope`; the redundant root scope is omitted. A page that cuts an instruction adds only
`fragment:{"partial":true}`. Internal range and paging metadata are
not model-visible. A resumed saved Task is projected once into
`checkpoint.untrustedSummary`; bootstrap does not duplicate it in a Thread or
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
Task version. The model result returns only a `task` object containing
`taskRef`, status, and version, plus the mutation recovery envelope. Optional
private Thread projection data is App-only metadata. The result never echoes
the saved title or summary. On a Task
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

`skills` infers the operation from one of three mutually exclusive shapes:
search with `{query,limit?}`, continue with `{cursor}`, or load with `{skillId}`.
The cursor is non-empty, the Skill ID uses the advertised `skill_` plus SHA-256
form, and removed or unknown fields are rejected before handler dispatch.
Repository instructions, files, and repository Skills are untrusted. User,
admin, bundled, DevSpace, and explicitly configured Skills retain their explicit
trusted provenance. All Skill content remains guidance only: regardless of
trust, it cannot expand OAuth scopes, approved roots, or tool authority. Process
output and model-authored checkpoint summaries also remain untrusted content.

## Versioned and idempotent effects

New patches, commands, process input, App lifecycle changes, and semantic saves
start with a fresh `operationId`. Identical lost-response retries replay their
result; reusing an ID after an accepted or recorded operation with changed
arguments conflicts. A saved-Task revision rejection is the explicit exception:
after list/reconcile, retry that unstarted operation with the same ID and current
`ifMatch`.

`apply_patch` requires an `ifMatch` value for every touched path. Existing
files can reuse the latest `read_files` item `version` object directly; a path
expected not to exist uses `null`.
Stale content must be reread and reconciled.
For a patch touching multiple paths, scalar `ifMatch` is a verified-not-started
preflight rejection. Replace it with the complete path-to-version map and retry
the same `operationId`.
On success, each touched path has one compact semantic effect containing its
operation and post-write version; move remains one move effect, deletion uses a
null post-version, and fuzzy-match evidence appears only when it was used.

`read_files` hoists provenance only when every item has the same source and
trust. Mixed repository/Skill reads carry provenance per item, using the actual
Skill source. If every `read_files` or `inspect` item fails, the result keeps all
item errors and adds a tool-specific read-only error envelope with safe
correct-and-retry guidance.

An error result has one authoritative `error` object. Mutation errors carry
`operationId` when the failure must be associated with a retry/idempotency
decision, plus `phase`, `effectsKnown`, `safeToRetry`, `recovery`, and bounded
corrective details. They never duplicate that state in a top-level `operation`
object, and the obsolete `retryable` alias is absent. Read-only errors omit the
invariant mutation fields `phase:not_started` and `effectsKnown:true` while
retaining useful safe-retry and recovery guidance. Successful mutations keep
their compact `operation` identity envelope.

## Commands and processes

Direct argv mode is the default:

```json
{
  "operationId":"command-001",
  "program":"npm",
  "args":["run","typecheck"],
  "workingDirectory":".",
  "environment":{"CI":"1"},
  "tty":false
}
```

Shell syntax is explicit:

```json
{
  "operationId":"command-002",
  "shell":true,
  "command":"npm test | tee test.log"
}
```

Exactly one mode is allowed. `workingDirectory` must stay inside the bound
checkout or worktree. Commands have the full file and inherited network
authority of the DevSpace OS user; there is no process sandbox or per-command
network policy.

All process fields use camelCase. `exec_command` accepts semantic command intent,
working directory, environment, timeout, initial stdin, and TTY choice; output
and wait budgets are server-owned. `read_process_output` performs read-only
polling. `write_stdin` always requires an operation ID because it mutates the
process.
If `expectedRevision` conflicts before input is written, poll
`read_process_output(sessionId)` for the current `inputRevision`, then retry the
corrected interaction with the same `operationId`; the rejected preflight has
known zero effects.

If a command initially returns `running`, its later exit, signal, timeout, or
interrupt writes a sanitized server-observed terminal checkpoint to the exact
Actor-owned Thread captured at process start. A later hydrate can distinguish
the terminal outcome and whether output was retained, partially lost, or
unavailable without exposing raw session, event, output, execution, or Thread
identifiers in the model checkpoint.

For long work, prefer one fixed foreground Project runner in direct argv mode,
then poll the returned session with `read_process_output` across turns. Let that
runner own preflight, fan-out, PID/log verification, and completion instead
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

The first call supplies exactly one `source`. A continuation call supplies only
the returned non-empty `cursor`; the signed cursor restores the source and
rejects repeated or changed first-page fields. The model receives only a compact
summary, patch, provenance, and optional next cursor; file/page details are
App-only metadata.

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
