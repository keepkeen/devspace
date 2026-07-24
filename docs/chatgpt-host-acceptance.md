# Real ChatGPT Host Acceptance Matrix

The automated MCP tests exercise DevSpace's server contract. They deliberately
use an SDK client that can retain and inject receipts, operation IDs, and other
structured fields. That does **not** prove that a particular ChatGPT host build
preserves the same state across conversations, connector replacement, or a
lost HTTP response.

Run this matrix after changing the OAuth contract, receipt schema, mutation
envelope, or tool descriptions. Record the exact ChatGPT build/date, DevSpace
commit, operating system, tunnel, and result. Do not restart the backend during
a row unless the row explicitly requires it.

## Preconditions

1. Use a disposable Git repository under an approved root.
2. Put a recognizable root instruction in `AGENTS.md` and a different nested
   instruction in `nested/AGENTS.md`.
3. Keep one clean checkout plus two managed worktrees available.
4. In a terminal, record `devspace auth principals` before and after connector
   changes.
5. Use unique `operationId` values and retain the structured result for every
   mutation.

## Matrix

| Scenario | Procedure | Required result | Evidence to record |
| --- | --- | --- | --- |
| First load | Open the disposable checkout without an explicit context mode. Attempt a read with the returned metadata receipt, then load full context. | Metadata read is rejected with `workspace_context_incomplete`; full context returns v3 instructions, Skills, a private context session, and a refreshed receipt. | Tool transcript and receipt phase only; never record the receipt value. |
| Same conversation | Read, inspect, patch a new file with `ifMatch: null`, run a test command, and review changes. | Each call retains the current receipt. Mutations include the submitted `operationId`, `phase=committed`, `safeToRetry=false`, and known effects. | Structured envelopes and final file contents. |
| Root instruction acknowledgement | After full context, perform the first root-scoped mutation without calling `load_workspace_instructions`. | Root instructions are not resent; the mutation proceeds because full context acknowledged them for this context session. | Calls made before the mutation. |
| Nested instruction gate | Mutate a file under `nested/` before loading its instruction, then load and acknowledge it. | First mutation is rejected before execution. Retrying with the one-time token succeeds. | Error phase, token-consuming retry, resulting file. |
| Same principal, new conversation | Start a new ChatGPT conversation using the same installed connector. Call `list_workspaces`, then resume by alias with full context. | Alias is visible; no host path is needed; a fresh receipt is returned. The old conversation's instruction acknowledgement state remains independent. | Alias list and both conversations' later successful calls. |
| Same principal, two project conversations | Open project A under alias A in one conversation and project B under alias B in another. Return to each conversation on a later day or after a platform transport closure. | Both aliases remain listed. Each conversation resumes its own alias and reads its own prior state without opening a replacement worktree. | Two aliases, stable Workspace IDs, and project-specific files from both resumed conversations. |
| Missing managed worktree path | Commit a recognizable file in a managed worktree, remove only the worktree directory while retaining the Workspace record and Git metadata, then reconnect and list/resume its alias. | Alias remains `recovery_required`; resume recreates the same Workspace ID/path, restores the committed file, and reports `dataLossPossible=true`. It does not create another branch. | Alias status, original/recovered Workspace ID, commit/file, recovery envelope. |
| Multiple worktrees for one source | Keep two active worktrees for one source repository, advance the source branch, then call `open_workspace(mode="worktree")` without alias or `forceNew`. | DevSpace returns `workspace_selection_required` with both aliases and creates no new worktree. | Alias list, worktree count before/after, structured error. |
| Delete and re-add connector, default | Delete the connector/app, add it again, authorize without a reconnect code, then list Workspaces. | Dynamic registration alone creates no principal. The first successful approval creates a new local principal; old aliases are not visible. | `devspace auth principals` before registration, after registration, and after approval. |
| Explicit connector recovery | Generate `devspace auth reconnect-code <old-principal>`, reauthorize the fresh registration with the code, then list Workspaces. | The code is consumed once; the connector sees the old aliases. Reusing the code fails. Tokens issued before relinking no longer work. | Principal list, alias list, second-use error. |
| Different registrations | Authorize two connectors without reconnecting them. Open the same checkout in both. | Workspace, process, output, and operation IDs are not interchangeable. This demonstrates connection-level isolation only; it is not proof of different ChatGPT accounts. | Cross-principal rejected calls and local principal list. |
| Concurrent same-root writes | From two conversations/principals, start two mutations against the same checkout root while the first call is held long enough to overlap. | Reads may overlap, but write-side MCP calls complete serially. Strict `ifMatch` rejects a stale second patch instead of silently overwriting. | Start/finish ordering and `file_version_conflict`. |
| Separate worktrees | Open two managed worktrees and modify them concurrently. | Each has an independent physical root and may proceed without the same-root queue. | Workspace modes/refs and separate Git worktree paths observed locally, not sent to the model. |
| Lost mutation response | Cause the client to lose the response after submitting a harmless mutation, then retry the identical request with the same `operationId`. | DevSpace replays the stored result and does not apply the effect twice. A different request with the same ID is rejected. | File content, replay envelope, conflict error. |
| Lifecycle replay | Close or revoke a Workspace, then repeat the identical call with the same `operationId`. | The stored result is replayed even though the Workspace generation/state changed; processes or worktrees are not cleaned twice. | Operation envelope and lifecycle effect counts. |
| OAuth reauthorization | Reauthorize the same registered connector. | Existing principal and aliases remain, active Workspace generations advance, and old receipts fail until resume/full context. | Principal list, stale-receipt error, resumed generation. |
| Owner-password rotation | Rotate the Owner password using the supported local procedure, then restart only for this row. | Existing dynamic registrations remain, old access/refresh tokens fail, and a fresh authorization is required. | Authorization outcomes and unchanged registration count. |
| Backend restart | Restart only for this row, keeping the same state directory. | Old receipts fail because process generation changed; aliases survive; resume/full context hydrates a newer generation. | Old-receipt error and resumed context. |
| Receipt expiry | Keep a receipt beyond its configured lifetime or use a test clock/build. | The receipt fails before the tool handler starts; resume/full context recovers. | `workspace_context_required` and recovery call. |
| Workspace revoke | Revoke a clean Workspace and try to resume it. Repeat with a dirty managed worktree. | Clean Workspace authority is terminal. Dirty worktree is retained and reported rather than deleted. | Revoke effects, alias visibility, local worktree existence. |
| Granular scope denial | Authorize a read-only scope set and attempt write, process, network, worktree, and revoke operations. | Each denied tool returns `insufficient_scope` before effects. Legacy `devspace` and a complete granular grant retain compatibility. | Requested scopes and structured errors. |
| Authorization abuse isolation | Submit repeated bad Owner passwords for one authorization session, then authorize a different client/session. | The attacked session is throttled with `Retry-After`; an unrelated client/session is not globally locked out. State survives a backend restart. | HTTP status sequence and sanitized audit events. |
| Normal project command | Run representative build, test, Git, package-manager, and project cleanup commands such as deleting `dist` or `node_modules` inside the Workspace. | Commands run without unnecessary policy rejection. `sudo`, remote-content pipe-to-shell, protected DevSpace state, workspace-root deletion, dynamic secret paths, and writes outside the Workspace remain blocked. | Structured process results plus denied-boundary examples. |

## Pass Criteria

A release passes only when every applicable row has recorded evidence and no
row depends on the model inferring execution from prose. The structured result
must decide whether an operation started, committed, is safe to retry, or has an
unknown outcome.

When a ChatGPT host fails to retain a receipt or operation field, record it as a
host interoperability defect. Do not weaken server ownership, context, scope,
or idempotency checks to make an implicit host behavior appear successful.
