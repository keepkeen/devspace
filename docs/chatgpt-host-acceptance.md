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
| Tool-result visibility canary | From a disposable probe, return three fresh, non-sensitive random canaries: one only in `content`, one only in `structuredContent`, and one only in result `_meta`; ask the model to report every visible canary and inspect both the conversation transcript and App component payload. | The model and transcript expose the `content` and `structuredContent` canaries but never the `_meta` canary; the component receives all fields. Record only pass/fail and field presence, never the canary values. This is a host-regression smoke test, not an authorization or secrecy prerequisite. |
| Explicit change source | Inspect and call `show_changes` with both sources and a continuation. | Exactly one first-page `source` is required; continuation accepts only the returned cursor and restores its signed source. `repository` works only at an exact Git top level, while `apply_patch_history` works for every Project and is execution-scoped. |
| Scope filtering | Compare read, read/write, read/process, and full grants. | Tools outside the grant are omitted; `exec_command` needs all three scopes. |
| Project discovery | Call `list_projects` globally and with `projectRef`. | Global entries expose only approved Project refs/labels and `resumableTaskCount`; unrelated Task titles/timestamps do not appear. The scoped result adds only bounded `taskRef`/title/version/`updatedAt` metadata under `taskTrust:"untrusted"`; no local paths or progress bodies leak. |
| Model bootstrap actions | Exercise model-visible `project_control`. | Only `open`, `resume`, `hydrate`, and `interrupt` are accepted. `interrupt(operationId)` targets only the trusted current session+Actor execution, rejects model-authored `threadRef`, requires `process:execute`, and returns no raw session IDs. |
| Implicit execution surface | Inspect every model-facing Project tool schema and bootstrap result. | File, process, patch, review, Skill, and progress tools omit execution references; bootstrap results expose no internal execution identity. |
| App Thread controls | Exercise `project_thread_control` from the Project App. | It displays Actor-private Threads and accepts only resolve/list/status/activity/pause/archive/complete/close. The model cannot see it, and these actions do not complete a shared saved Task. |
| No recency guess | Save several Tasks and omit selection during resume. | Model `resume` requires an explicit `taskRef`; it never accepts `threadRef` or selects by recency or sole-item inference. |
| Task recovery | Save under grant A, then list/resume under grant B authorized for the exact same Project. | B can select the Project-level `taskRef`, but receives a new B-bound execution and no A process, replay, instruction, or patch-history state. |
| Thread privacy | Query A's private Thread from B through the App control plane. | B cannot access A's private Thread metadata or checkpoint. Shared checkout files may still be visible if both grants approve the Project. |
| Session/Actor selection | Open different Projects under two sessions and two Actors, then call Project tools without references. | Each call uses only its exact trusted `openai/session`+Actor binding; no binding crosses an Actor or session boundary. |
| Actor-bound replay | Under one OAuth grant, use two different `openai/subject` values with the same open/resume operation ID and arguments, then attempt interrupt from the second Actor. | The second creation conflicts, cannot rebuild or rebind the first Actor's execution-to-Thread mapping, and remains unable to interrupt it. |
| Unknown legacy owner | Seed a grant-wide legacy Thread/execution, then list, inspect by signed Thread ref, and replay its operation ID from two current Actors under that same grant. | Neither Actor sees or claims the Thread; Thread reads fail as not found, creation replay conflicts, and persisted ownership remains unchanged. |
| Caller override rejected | Add a legacy execution-reference argument from another session to a model tool call. | Caller input cannot select or override the trusted session binding; the strict public schema rejects the extra field. |
| Missing/stale binding | Omit `openai/session`, call before open/resume, then invalidate an existing binding. | Each case fails closed with compact open/resume or hydrate/reselect recovery; there is no latest- or sole-Project fallback. |
| Open replay | Retry identical open with the same operation ID. | The same execution is returned; no second checkout or worktree is created. |
| Root paging | Use an oversized root `AGENTS.md`. | Every page remains bounded; other Project tools stay gated until the final page. |
| Lost cursor | Hydrate without a lost cursor. | Root paging restarts safely without creating another execution. |
| Bootstrap paging | Inspect open, resume, cursorless hydrate, and continuation results. | The first model page has Project/checkpoint/instructions without private Thread, schema/success/completion constants; Project includes checkout kind, and checkpoint separates `serverObserved` from `untrustedSummary`. Continuations have only instructions and optional `nextCursor`. Repository instructions use `trustClass:repository_untrusted`, root scope is omitted, and an instruction fragment exposes only `partial:true`. |
| Nested instructions | Read, inspect, patch, or command under nested instructions. | Newly applicable deltas are returned; guarded effects start only after acknowledgement. |
| Lazy Skill | Search and load one Skill; send an empty cursor, mixed fields, removed `action`/`name`, an unknown field, and a malformed Skill ID through raw HTTP. | `{query,limit?}`, non-empty `{cursor}`, and current-format `{skillId}` are mutually exclusive; malformed and unknown fields fail as `invalid_tool_input` before SDK stripping, only bounded metadata or the selected manifest appears, and authority does not expand. |
| Batch read | Read one to eight files, including partial/all failures and mixed repository/repository-Skill/user/admin/bundled/DevSpace/explicit Skill sources; submit legacy `ref` and arbitrary nested fields through raw HTTP. | Ordered items contain path plus content/error and directly reusable `version`; uniform provenance is hoisted once, mixed provenance is item-local and source-correct, repository Skills stay untrusted, trusted Skill sources remain explicit without expanding authority, nested unknown fields fail as `invalid_tool_input`, and all-failed results retain every item error plus `read_files_failed` safe retry semantics. |
| Batch inspect | Run one to eight mixed grep/glob/list operations, omitting the root path for `ls`, including partial/all failures, and submitting legacy `ref` or arbitrary nested fields through raw HTTP. | Ordered items contain operation/path plus result/error/omitted; repository provenance appears once, nested unknown fields fail as `invalid_tool_input`, `ref` plus aggregate counts/status are absent, and all-failed results retain every item error plus `inspect_failed` safe retry semantics. |
| File containment | Try absolute, parent, and escaping-symlink paths. | Access outside the bound checkout/worktree is rejected. |
| Patch preconditions | Patch with current (including a pre-epoch negative `mtimeNs`), missing, and stale `ifMatch`. | The `read_files.version` object is directly reusable; current succeeds and missing/stale fails before any write. |
| Ambiguous patch precondition | Submit a multi-path patch with scalar `ifMatch`, then replace it with the complete version map. | The first result is verified not started and explicitly allows correction with the same operation ID; the corrected retry succeeds. |
| Automatic patch checkpoint | Apply a successful patch, then read Thread status through the Project App. | A server-observed checkpoint records bounded file effects without file bodies. |
| Async command checkpoint | Let `exec_command` return running, then observe exit/timeout/interrupt and hydrate from a new transport. | The latest model checkpoint contains sanitized terminal and retained/lost-output recovery state for the exact Actor/Thread, without raw session/output/event IDs. |
| Task CAS | Save, update with current `task.version`, then update with a stale version. | Version increments; stale update receives a saved-Task revision conflict. After listing and reconciling, retrying with the same `operationId` and current `ifMatch` succeeds. |
| Task completion | Save a resumable Task, then call `save_progress(status:"completed")` from its active execution. | The Task leaves resumable listings and releases capacity; App Thread complete alone does neither. |
| Summary minimization | Save a distinctive summary and inspect results/logs/listing/bootstrap. | Save result and `list_projects` do not echo it; resume returns it once as `checkpoint.untrustedSummary`, separate from `checkpoint.serverObserved`. |
| Error envelope | Trigger read-only, verified-not-started mutation, replay/conflict, unknown-outcome, and unavailable-result failures. | Every result has one authoritative `error`; mutation association/recovery lives there with `operationId` only when relevant, no error also has top-level `operation`, `retryable` is absent, and read-only errors omit invariant phase/effects fields. |
| Operation-ID byte boundary | Exercise every mutation schema with ASCII and multibyte IDs at and beyond 128 UTF-8 bytes, plus NUL and lone UTF-16 surrogates. | Exact 128-byte well-formed IDs are accepted unchanged; larger, NUL-bearing, or malformed Unicode IDs fail as invalid input before execution/mutation reservation, process start, or an `outcome_unknown` state, and malformed surrogates cannot alias `U+FFFD`. |
| Persisted mutation recovery | Seed persisted outcome-unknown, verified-not-started, and result-unavailable operation rows, then retry exact and conflicting calls through MCP. | Exact calls preserve their conservative code/phase/effects/safe-retry/recovery contract; changed requests conflict; settled results replay; no error duplicates `operation`, `retryable`, or `ok`. |
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
| Shell command | Use `shell:true` with a pipeline. | The command runs only with the complete explicit shell form. |
| Invalid command mode | Mix direct and shell fields. | The command is rejected before process creation. |
| Compact process inputs | Inspect and call process tools, then submit removed wait/output/terminal-size tuning fields through raw HTTP. | The model supplies semantic command or interaction intent; server-owned tuning fields and unknown fields are rejected before execution. |
| Process polling | Start a live process, poll, write input, and await exit. | Polling is read-only; input uses a fresh operation ID. |
| Command checkpoint | Complete a foreground command, then read Thread status through the Project App. | A bounded server-observed checkpoint records mode, outcome, duration, and retained-output availability, not raw output. |
| Activity minimization | Read activity repeatedly through the Project App. | Responses contain bounded observable projection/events and omit repeated inventories of unavailable host internals. |
| Process authority disclosure | Run harmless OS-user/network checks. | Behavior follows the local OS user and inherited network; no sandbox claim is made. |
| Change review | Review Git and non-Git Projects with explicit sources. | `repository` is read-only and exact-Git-root-only; `apply_patch_history` is execution-scoped and works for every Project. |
| Cross-execution journal | Patch under execution A and review under B. | A's patch journal does not appear in B, even if checkout files are shared. |
| Revocation | Revoke A while B is active. | A's executions/processes are cleaned according to policy; B remains usable. |
| Removed root | Remove Project authorization and reuse an execution. | Access is rejected without deleting Project or worktree files. |
| Bounded output | Request large reads, inspection, diffs, and process output. | Results remain bounded; change and retained-process continuations use cursor-only calls, and process provenance is emitted once. |
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
