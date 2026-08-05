# Security Model

DevSpace is a single-owner bridge between ChatGPT web and approved local
Projects. Its primary controls are narrow Project approval, OAuth capabilities,
grant-validated session bindings, path and version validation, effect replay
protection, bounded saved Tasks, bounded output, and root locking.

It is not an operating-system security boundary.

## Trust model

The trusted operator is the person who:

- runs DevSpace under a local OS account;
- chooses the approved Project roots;
- controls the Owner password and persistent state;
- reviews and approves the ChatGPT OAuth grant;
- decides which commands ChatGPT may run.

Repository files, `AGENTS.md`, Skills, build scripts, command output, saved
Task text, and model text are untrusted input. They cannot grant capabilities
or expand an approved root.

## Approved roots and Projects

Configure the narrowest roots that contain the checkouts ChatGPT needs. Avoid
approving:

- `/` or a full home directory;
- a cloud-drive root;
- a secrets directory;
- a parent containing unrelated work and personal data.

`list_projects` exposes only Projects selected for the active OAuth grant and
does not reveal absolute local paths. `project_control(action=open)` validates
the returned Project reference, binds a logical context to that approved
directory, and selects it for the trusted ChatGPT session and Actor. The internal
execution identity is not returned to the model. Git is not required.

File tools resolve Project-relative paths and verify that canonical targets
remain inside the approved root. Command `workingDirectory` receives the same containment
check. These checks prevent accidental or model-supplied path traversal through
the DevSpace tool arguments.

They do not constrain what an already-started local process can access.

## Project execution binding

The OAuth bearer grant is the authorization identity. When ChatGPT supplies
anonymous host metadata, DevSpace stores only HMAC-derived Actor/session
references; those assist private Thread ownership and session resolution but do
not grant Project or tool authority.

Creating an execution requires a caller-chosen `operationId` and, when more than
one Project is approved, a `projectRef`. Successful open, resume, and hydrate
bind it to exactly the HMAC-derived trusted `openai/session` and Actor. Model tool
schemas and results never expose the internal execution identity. Before every
Project tool handler runs, DevSpace resolves that binding and verifies the
execution still belongs to the active principal, OAuth client, grant,
authorization epoch, current scopes, approved root, Project fingerprint/path,
and expected workspace.

A stable host session can hydrate its binding across MCP reconnects, service
restarts, and conversation changes for which the host preserves that same
session value. Different Actors and different sessions cannot reuse it,
including sessions under the same OAuth client or grant; concurrent sessions may
select different Projects. Missing session metadata or a missing/stale binding
fails closed and requires explicit open or resume selection. Removing the source
Project from authorization closes the execution before a new effect can start.
Selection, hydration, and lifecycle operations for one session+Actor are FIFO;
a slower earlier request cannot overwrite or release the result of a later one.

Each new operation creates a different logical context on the same approved
directory. Retrying the identical `project_control(action=open)` request replays
the same execution, which makes a lost response safe without creating another
context. Project creation identity includes the HMAC-derived Actor, and an
execution-to-Thread mapping cannot be overwritten; sharing a grant and guessing
another Actor's operation ID therefore cannot replay, rebind, or interrupt that
Actor's execution. Older grant-wide Thread ownership records are not migrated or
claimed during reads, hydration, replay, interrupt, activity, or lifecycle
operations. Unless a Thread is already verifiably owned by the current Actor,
legacy ownership remains unknown and access fails closed.

Mutation operation IDs are validated as exact opaque strings before any
reservation or effect: they must be well-formed Unicode, non-empty, contain no
NUL, and occupy at most 128 UTF-8 bytes. DevSpace does not trim or normalize
them, and applies the same rule at the HTTP/MCP boundary and mutation,
execution, Thread, and continuity stores.
DevSpace never selects an execution by recency, a sole candidate, caller input,
or process-global “current Project.”

Logical contexts isolate references, instruction state, idempotency records,
process handles, patch journals, and grant authorization—not files. Any two
contexts or grants approved for the same Project see the same filesystem and
can observe one another's writes. DevSpace root locks coordinate tracked
DevSpace writers, but cannot serialize external programs or edits outside
DevSpace.

## Saved Project Tasks

A saved Task is a bounded semantic progress snapshot for continuing work
in a later ChatGPT conversation. It is not a ChatGPT account/session record,
chat transcript, command log, diff, file snapshot, or source of authorization.

Tasks are keyed by the approved Project's stable fingerprint rather than by
an OAuth grant. Any active grant that currently authorizes that same Project
may list and continue its resumable Tasks. Continuing one always creates a
new execution bound to the calling grant; it never transfers or reuses another
grant's execution, process handles, instruction acknowledgement, mutation replay
records, or apply-patch history. Knowing a `taskRef` alone cannot
bypass Project authorization.

Each Task has a title of at most 256 UTF-8 bytes and progress text of at most
8 KiB. Their JSON-serialized model text must also fit 12,000 bytes. A Project
may have at most 20 resumable Tasks and retains at most the newest 80
completed records; selection output is also bounded. `save_progress` uses a
caller-stable `operationId` and an integer `ifMatch` revision for replay-safe,
optimistic updates. Save responses and Project lists omit the progress body to
avoid duplicating it in model context.

Saved Tasks are distinct from Actor-private Threads. The Project App may list a
caller's private Threads and apply Thread lifecycle controls through the
App-only `project_thread_control`, but those actions do not complete or release
capacity for a shared saved Task. Only
`save_progress(status:"completed")` from the Task's active execution does that.

Do not place secrets, credentials, hidden reasoning, complete file contents,
full diffs, transcripts, or raw logs in a Task. Task text is durable state and
should be treated as sensitive. On resume, DevSpace returns it once as
`checkpoint.untrustedSummary`, separately from `checkpoint.serverObserved`; the
model must reread relevant files and Git state before acting on it. A completed
Task is removed from resume selection but
its bounded record remains until it ages out of the per-Project completed
retention set. Pruning replaces obsolete execution links with a terminal marker
so those executions cannot create a new Task; it removes metadata only,
never Project files.

## Owner and OAuth

DevSpace has one hidden local Owner. The Owner password gates the OAuth approval
page and is stored as a verifier rather than recoverable plaintext. Keep the
password and `auth.json` out of repositories, chats, screenshots, and logs.

Multiple OAuth grants may remain active concurrently, including grants sharing
the same OAuth client ID. Each access token resolves an exact
principal/client/grant/authorization-epoch boundary with its own scopes and
approved Projects. Issuing a new grant does not invalidate another grant's
tokens, executions, transports, or Project selection.

Revoking or expiring one grant affects only that grant. Its tracked executions
and processes are closed through the durable cleanup path, retained process
output and review state are retired, and Project files and Git state are left
untouched. Refresh-token replay revokes only the replayed grant.
Owner-password rotation and the authenticated `revokeAll` operation remain
intentional global emergency actions.

DevSpace does not claim to identify a ChatGPT account: it stores no ChatGPT
account or conversation key. Independent OAuth grants are the multi-user
security boundaries, even when the host reuses one OAuth client ID.
Executions and processes remain grant-local. Saved Tasks are the deliberate
exception: they are shared only among grants that currently authorize the same
Project, as described above.

The public OAuth scopes are fixed:

| Scope | Authority |
| --- | --- |
| `project:read` | Select approved Projects; load and save Tasks; load instructions and Skills; read, inspect, and review changes. |
| `project:write` | Apply file patches. |
| `process:execute` | Explicit high-trust opt-in for process I/O and, together with `project:write`, command creation. |

Every tool call rechecks the active grant and the capability required by that
tool. A `projectRef` is a selector, not a credential.

Access and refresh tokens are bearer credentials. Protect them in transit with
HTTPS, never log them, and do not place them in shell history or repository
content.

## Public and local listeners

`DEVSPACE_PUBLIC_BASE_URL` is the public HTTPS origin, without `/mcp`. The MCP
endpoint is that origin plus `/mcp`.

The public listener serves the MCP and OAuth routes plus health endpoints.
Administrative and internal control routes remain on loopback-only listeners.
Tunnel or reverse-proxy only the public DevSpace service port. Never expose the
admin/control listener.

Host-header and OAuth redirect-host validation reduce endpoint confusion and
redirect abuse. They are configuration checks, not a replacement for TLS or
OAuth.

Temporary tunnel URLs change. When one changes, update the public origin,
restart the server, update the ChatGPT app endpoint, and authorize again.

## File mutation safety

DevSpace file writes preserve several invariants:

- Project-relative and canonical-path containment;
- `ifMatch` file-version preconditions;
- `operationId` replay protection where required by the tool contract;
- per-root coordination for conflicting writes;
- bounded request, response, and diff data.

An `ifMatch` failure means the file changed after it was read. The caller must
reread and reconcile the edit.

Reusing the same operation identifier for the same request after a lost
response replays the stored result rather than repeating the effect. A
different intended effect requires a new identifier.

Root locks coordinate DevSpace writers that target the same checkout. A running
process may retain its root lease until the tracked process tree exits or is
cleaned up. Locks prevent cooperating DevSpace operations from racing; they do
not stop unrelated local programs from editing the same files.
`save_progress` updates only DevSpace metadata and does not acquire the Project
root lock, so a checkpoint can be recorded while a tracked command still holds
the filesystem lease.

Signed continuation cursors bind the grant, authorization epoch, execution,
resource, revision, query, and paging parameters. Continue with the cursor under
the same trusted session+Actor selection and omit the initial paging fields. A
cursor is not Project authority and cannot be transferred to another session,
grant, or execution.

## Command execution

`exec_command` is intentionally a full local command facility. It accepts:

Direct mode accepts `program` and `args`; shell mode instead requires
`shell:true` and `command`. Both modes use camelCase common fields such as
`operationId`, `workingDirectory`, `environment`, `timeoutMs`, and `tty`.
Wait and output budgets are server-owned rather than model-authored.

DevSpace validates that `workingDirectory` is inside the Project bound to the execution and bounds
returned output. `write_stdin` is mutation-only and requires `operationId` to
send input, close stdin, or interrupt.
`read_process_output` performs live polling and retained-output reads without
mutating process input. Process count, retention, and cleanup limits prevent
unbounded server-side accumulation.
The process session captures trusted execution/Thread/Actor identity at start.
When a running command later reaches a terminal state, DevSpace writes only a
sanitized outcome and retained/lost-output recovery state to that exact Thread's
server-observed checkpoint; raw process, output, event, and private identity
references are excluded from the model checkpoint.

After process creation, the OS is the enforcement boundary. The command runs
with the privileges of the OS user running DevSpace and can:

- access any file that OS user can access, including paths outside the Project;
- use the network according to the host OS and environment;
- spawn subprocesses and execute repository-provided scripts;
- make changes that DevSpace file-version checks cannot observe in advance.

DevSpace provides no process sandbox, command allow/deny list, risk
classification, child-process protected-path policy, or network egress policy.
Project and `workingDirectory` validation must not be described as process isolation.

Shutdown and interrupt cover only process groups that DevSpace started and
still tracks, and termination is best effort. Detached, daemonized,
re-parented, or otherwise untracked descendants may outlive DevSpace.

For stronger isolation, run DevSpace with a dedicated low-privilege OS user or
inside a suitably configured container or VM. Treat `process:execute` as
high-trust authority.

## Instructions and Skills

Project open, resume, and hydrate return compact bounded root instruction pages without an eager
Skill catalog. `read_files` and `inspect` return newly applicable nested
`instructionsDelta` only when target paths require it. The `skills` tool
searches bounded metadata and lazily loads one selected Skill.

Default repository instruction discovery uses `AGENTS.override.md` and
`AGENTS.md` (including supported case variants). `CLAUDE.md` is not loaded
unless the operator explicitly configures it as a fallback filename.

These sources may describe how to work, but they cannot:

- alter OAuth capabilities or approved roots;
- authorize another local path;
- disable file-version or replay checks;
- disclose server credentials that were not already present in accessible
  content.

Review repository-provided instructions and Skills with the same care as build
scripts.

## Shared Project directories and change review

Checkout mode uses the approved Project root as the mutable execution directory.
For a Project whose root exactly equals its Git top level, an authorized caller
may explicitly request a managed worktree during open. Authorization remains
anchored to the source Project. Users may also ask the model to manage Git
through ordinary commands, subject to the full command-security boundary above.

With `source:"repository"`, `show_changes` reads the current staged, unstaged,
and untracked diff only when the approved Project root is exactly the Git top
level, without writing the index, objects, or refs. A nested or non-Git Project
rejects that source so review cannot expose paths above the approved root.
This includes repositories with no first commit. DevSpace disables Git
fsmonitor for review and rejects executable clean/process filters that apply to
Project files, because a `project:read` tool must not run repository-configured
programs.
The explicitly selected `source:"apply_patch_history"` is available in Git and
non-Git Projects. It is a bounded durable journal containing the exact successful
DevSpace `apply_patch` requests for the current logical execution. It is not a
filesystem monitor or net diff: command writes, external edits, failed or
unknown-outcome patches, and patches from another execution are excluded. A
full journal requires starting a new logical context; shared files are not
reset or copied.

Closing or revoking an authorization retires its logical and retained runtime
state without deleting Project files or changing Git state. There is no
worktree inventory or cleanup API.

## Output and process retention

Read results, diffs, command output, and retained process output are bounded.
Truncation is expected for large data; callers should narrow their request.

Running and completed process records are subject to configured limits and
cleanup. Do not use retained output as permanent storage.
Saved Tasks are also bounded but intentionally durable; they are continuity
metadata, not a backup of Project files or chat history.

## Logs and secrets

Keep the following out of logs and repositories:

- Owner passwords and OAuth tokens;
- `auth.json` and master-key material;
- internal control tokens;
- tunnel credentials;
- command text or output that contains secrets.

Use `DEVSPACE_LOG_SHELL_COMMANDS=1` only when command previews are intentionally
acceptable. Audit and diagnostic output should remain bounded and sanitized,
but operators must still review it before sharing.

`GET /healthz` is a liveness check. `GET /readyz` is a readiness check and
should not expose credentials or local file contents.

The canonical public surface and examples are in
[ChatGPT Tool Contract](./chatgpt-tool-contract.md).
