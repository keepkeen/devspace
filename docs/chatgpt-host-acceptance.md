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
| Exact surface | Inspect `tools/list` with all scopes. | The names are `list_projects`, `project_control`, `save_progress`, `read_files`, `inspect`, `skills`, `apply_patch`, `show_changes`, `exec_command`, `write_stdin`, and `read_process_output`. |
| Scope filtering | Compare read, read/write, read/process, and full grants. | Tools outside the grant are omitted; `exec_command` needs all three scopes. |
| Project discovery | Call `list_projects`. | Only approved opaque Project references and labels appear; no local paths leak. |
| Explicit lifecycle | Exercise every `project_control` action. | `list`, `open`, `resume`, `hydrate`, `status`, and `close` accept only their documented fields. |
| No recency guess | Open several Threads and omit selection during resume. | DevSpace requires an explicit `threadRef`; it never selects the newest or sole Thread implicitly. |
| Thread privacy | Save under grant A, list/resume under grant B for the same Project. | B cannot see or resume A's Thread. Shared checkout files may still be visible if both grants approve the Project. |
| Execution isolation | Try A's `executionRef` under B. | The reference is rejected across the grant boundary. |
| Open replay | Retry identical open with the same operation ID. | The same execution is returned; no second checkout or worktree is created. |
| Root paging | Use an oversized root `AGENTS.md`. | Every page remains bounded; other Project tools stay gated until the final page. |
| Lost cursor | Hydrate without a lost cursor. | Root paging restarts safely without creating another execution. |
| Nested instructions | Read, inspect, patch, or command under nested instructions. | Newly applicable deltas are returned; guarded effects start only after acknowledgement. |
| Lazy Skill | Search and load one Skill. | Only bounded metadata or the selected manifest appears; authority does not expand. |
| Batch read | Read one to eight files. | Per-item versions and bounded continuations are returned in input order. |
| Batch inspect | Run one to eight mixed grep/glob/list operations. | Items run as a bounded batch with per-item status, `ref`, and aggregate truncation. |
| File containment | Try absolute, parent, and escaping-symlink paths. | Access outside the bound checkout/worktree is rejected. |
| Patch preconditions | Patch with current, missing, and stale `ifMatch`. | Current succeeds; missing/stale fails before any write. |
| Automatic patch checkpoint | Apply a successful patch, then read Thread status. | A server-observed checkpoint records bounded file effects without file bodies. |
| Thread CAS | Save, update with current version, then update with a stale version. | Version increments; stale update receives `thread_revision_conflict`. |
| Summary minimization | Save a distinctive summary and inspect results/logs/listing. | Save result and Thread listing do not echo the summary; status/resume returns it as untrusted checkpoint context. |
| Grant-private checkpoint | Read another grant's Thread status. | The request returns `project_thread_not_found`. |
| Checkout mode | Open two checkout Threads for one Project. | They use distinct executions over the intentionally shared approved directory. |
| Worktree eligibility | Request worktree mode for a non-Git or nested Project. | Open fails before workspace activation with a clear recovery path. |
| Worktree isolation | Open two writable worktree Threads. | Each has a separate managed root and branch; writes do not appear in the other worktree. |
| Worktree replay | Retry the same worktree open. | The original managed Thread/worktree is reused. |
| Worktree authorization | Inspect retained state and tool results. | Authorization remains anchored to the approved source Project; managed roots stay under the private state directory and are never model-visible. |
| Dirty close | Modify a managed worktree and close its Thread. | Close returns `project_worktree_dirty`; files, branch, and Thread remain recoverable. |
| Clean close | Close a clean managed worktree Thread. | Active operations are checked, the clean worktree/managed branch are removed, and the Thread becomes closed. |
| Busy close | Hold a tracked process and close its Thread. | Close returns busy and does not terminate the task. |
| Direct command | Run a harmless program with `program` and `args`. | No shell is involved; working directory and environment are applied. |
| Shell command | Use `shell:true` with a pipeline and `approvalReason`. | The command runs only with the complete explicit shell form. |
| Invalid command mode | Mix direct and shell fields or omit the reason. | The command is rejected before process creation. |
| CamelCase process fields | Inspect and call process tools. | Only `sessionId`, `closeStdin`, `expectedRevision`, `yieldTimeMs`, `timeoutMs`, and `maxOutputTokens` are accepted. |
| Process polling | Start a live process, poll, write input, and await exit. | Polling is read-only; input uses a fresh operation ID. |
| Command checkpoint | Complete a foreground command, then read Thread status. | A bounded server-observed checkpoint records mode, outcome, duration, and retained-output availability, not raw output. |
| Process authority disclosure | Run harmless OS-user/network checks. | Behavior follows the local OS user and inherited network; no sandbox claim is made. |
| Change review | Review Git and non-Git Projects. | Git top-level review is read-only; non-Git review uses the execution patch journal. |
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
