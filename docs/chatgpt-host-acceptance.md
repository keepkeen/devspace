# Real ChatGPT Host Acceptance

Run these checks only against disposable Projects. Backend restart, service
replacement, publication, and process termination require a separate explicit
user command and are not part of ordinary acceptance.

## Preconditions

1. Use a disposable OAuth client and narrowly approved test Projects.
2. Keep admin/control listeners off the public tunnel.
3. Include one non-Git Project and one Git top-level Project.
4. Ensure all commands and worktrees are disposable.
5. Rescan the ChatGPT App after schema changes before collecting evidence.

## Acceptance matrix

| Area | Exercise | Expected result |
| --- | --- | --- |
| OAuth identity | Call tools under two concurrent grants. | Each bearer sees only its scopes, approved Projects, executions, private Threads, and processes. |
| Raw surface | Inspect raw `tools/list` with all scopes. | It contains 12 names: `list_projects`, `project_control`, `project_thread_control`, `save_progress`, `read_files`, `inspect`, `skills`, `apply_patch`, `show_changes`, `exec_command`, `write_stdin`, and `read_process_output`. |
| Model visibility | Inspect ChatGPT's model-visible surface and tool metadata. | `project_thread_control` has `_meta.ui.visibility:["app"]`; the model sees the other 11 tools and is never instructed to call the App-only tool. |
| Explicit change source | Inspect and call `show_changes` with both sources. | `source` is required; `repository` works only at an exact Git top level, while `apply_patch_history` works for every Project and is execution-scoped. |
| Scope filtering | Compare read, read/write, read/process, and full grants. | Tools outside the grant are omitted; `exec_command` needs all three scopes. |
| Project discovery | Call `list_projects` globally and with `projectRef`. | Only approved opaque Project references and labels appear; each entry has bounded `tasks`, and the top level has `taskTrust:"untrusted"` and `taskLimits`; no local paths or progress bodies leak. |
| Model bootstrap actions | Exercise model-visible `project_control`. | Only `open`, `resume`, `hydrate`, and `interrupt` are accepted by its schema, with strict action-specific validation in the handler. |
| Implicit execution surface | Inspect every model-facing Project tool schema and bootstrap result. | File, process, patch, review, Skill, and progress tools omit execution references; bootstrap results expose no internal execution identity. |
| App Thread controls | Exercise `project_thread_control` from the Project App. | It displays Actor-private Threads and accepts only resolve/list/status/activity/pause/archive/complete/close. The model cannot see it, and these actions do not complete a shared saved Task. |
| No recency guess | Save several Tasks and omit selection during resume. | DevSpace requires an explicit `taskRef` (or explicit current private `threadRef`); it never selects by recency or sole-item inference. |
| Task recovery | Save under grant A, then list/resume under grant B authorized for the exact same Project. | B can select the Project-level `taskRef`, but receives a new B-bound execution and no A process, replay, instruction, or patch-history state. |
| Thread privacy | Query A's private Thread from B through the App control plane. | B cannot access A's private Thread metadata or checkpoint. Shared checkout files may still be visible if both grants approve the Project. |
| Session/Actor selection | Open different Projects under two sessions and two Actors, then call Project tools without references. | Each call uses only its exact trusted `openai/session`+Actor binding; no binding crosses an Actor or session boundary. |
| Caller override rejected | Add a legacy execution-reference argument from another session to a model tool call. | Caller input cannot select or override the trusted session binding; the strict public schema rejects the extra field. |
| Missing/stale binding | Omit `openai/session`, call before open/resume, then invalidate an existing binding. | Each case fails closed with compact open/resume or hydrate/reselect recovery; there is no latest- or sole-Project fallback. |
| Open replay | Retry identical open with the same operation ID. | The same execution is returned; no second checkout or worktree is created. |
| Root paging | Use an oversized root `AGENTS.md`. | Every page remains bounded; other Project tools stay gated until the final page. |
| Lost cursor | Hydrate without a lost cursor. | Root paging restarts safely without creating another execution. |
| Context schema v8 | Inspect open, resume, and hydrate results. | `schemaVersion` is 8; no execution identity is exposed; Thread data uses `thread.threadRef`; checkpoint trust is carried by scalar `observedStateTrust`/`modelSummaryTrust`; an instruction fragment exposes only `partial:true`, with no internal range metadata. |
| Nested instructions | Read, inspect, patch, or command under nested instructions. | Newly applicable deltas are returned; guarded effects start only after acknowledgement. |
| Lazy Skill | Search and load one Skill. | Only bounded metadata or the selected manifest appears; authority does not expand. |
| Batch read | Read one to eight files. | Per-item versions and bounded continuations are returned in input order. |
| Batch inspect | Run one to eight mixed grep/glob/list operations. | Items run as a bounded batch with per-item status, `ref`, and aggregate truncation. |
| File containment | Try absolute, parent, and escaping-symlink paths. | Access outside the bound checkout/worktree is rejected. |
| Patch preconditions | Patch with current, missing, and stale `ifMatch`. | Current succeeds; missing/stale fails before any write. |
| Automatic patch checkpoint | Apply a successful patch, then read Thread status through the Project App. | A server-observed checkpoint records bounded file effects without file bodies. |
| Task CAS | Save, update with current `task.version`, then update with a stale version. | Version increments; stale update receives a saved-Task revision conflict. After listing and reconciling, retrying with the same `operationId` and current `ifMatch` succeeds. |
| Task completion | Save a resumable Task, then call `save_progress(status:"completed")` from its active execution. | The Task leaves resumable listings and releases capacity; App Thread complete alone does neither. |
| Summary minimization | Save a distinctive summary and inspect results/logs/listing/bootstrap. | Save result and `list_projects` do not echo it; resume returns it once as `thread.checkpoint.modelSummary` with `modelSummaryTrust:"untrusted"`. |
| Grant-private checkpoint | Read another grant's Thread status through the App control plane. | The request returns `project_thread_not_found`. |
| Checkout mode | Open two checkout Threads for one Project. | They use distinct executions over the intentionally shared approved directory. |
| Worktree eligibility | Request worktree mode for a non-Git or nested Project. | Open fails before workspace activation with a clear recovery path. |
| Worktree isolation | Open two writable worktree Threads. | Each has a separate managed root and branch; writes do not appear in the other worktree. |
| Worktree replay | Retry the same worktree open. | The original managed Thread/worktree is reused. |
| Worktree authorization | Inspect retained state and tool results. | Authorization remains anchored to the approved source Project; managed roots stay under the private state directory and are never model-visible. |
| Dirty close | Modify a managed worktree and close its Thread from the Project App. | Close returns `project_worktree_dirty`; files, branch, and Thread remain recoverable. |
| Clean close | Close a clean managed worktree Thread from the Project App. | Active operations are checked, the clean worktree/managed branch are removed, and the Thread becomes closed. |
| Busy close | Hold a tracked process and close its Thread from the Project App. | Close returns busy and does not terminate the task. |
| Direct command | Run a harmless program with `program` and `args`. | No shell is involved; working directory and environment are applied. |
| Shell command | Use `shell:true` with a pipeline and `approvalReason`. | The command runs only with the complete explicit shell form. |
| Invalid command mode | Mix direct and shell fields or omit the reason. | The command is rejected before process creation. |
| CamelCase process fields | Inspect and call process tools. | Only `sessionId`, `closeStdin`, `expectedRevision`, `yieldTimeMs`, `timeoutMs`, and `maxOutputTokens` are accepted. |
| Process polling | Start a live process, poll, write input, and await exit. | Polling is read-only; input uses a fresh operation ID. |
| Command checkpoint | Complete a foreground command, then read Thread status through the Project App. | A bounded server-observed checkpoint records mode, outcome, duration, and retained-output availability, not raw output. |
| Activity minimization | Read activity repeatedly through the Project App. | Responses contain bounded observable projection/events and omit repeated inventories of unavailable host internals. |
| Process authority disclosure | Run harmless OS-user/network checks. | Behavior follows the local OS user and inherited network; no sandbox claim is made. |
| Change review | Review Git and non-Git Projects with explicit sources. | `repository` is read-only and exact-Git-root-only; `apply_patch_history` is execution-scoped and works for every Project. |
| Cross-execution journal | Patch under execution A and review under B. | A's patch journal does not appear in B, even if checkout files are shared. |
| Revocation | Revoke A while B is active. | A's executions/processes are cleaned according to policy; B remains usable. |
| Removed root | Remove Project authorization and reuse an execution. | Access is rejected without deleting Project or worktree files. |
| Bounded output | Request large reads, inspection, diffs, and process output. | Results remain bounded and expose safe continuation/narrowing. |
| Public/local split | Request a local management route through the public origin. | It is unavailable publicly. |

## Pass criteria

Acceptance passes only when applicable rows have real-host evidence, the public
surface matches this document, guarded effects fail before starting, Thread and
grant boundaries are preserved, dirty worktrees survive, and no secret or
unrelated local path appears in evidence.

Unit, integration, context-budget, and typecheck validation remain required in
addition to this host matrix.

See [ChatGPT Tool Contract](./chatgpt-tool-contract.md) for the normative
contract.
