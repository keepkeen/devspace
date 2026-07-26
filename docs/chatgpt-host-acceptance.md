# Real ChatGPT Host Acceptance Matrix

Automated SDK tests verify the server contract. A real-host acceptance run is
still required after changing OAuth grants, host metadata, Workspace context,
tool schemas, or result envelopes.

`src/host-conversation-simulation.test.ts` covers the server-side journey with
stable `openai/subject` and `openai/session` metadata. It intentionally does not
auto-convert `workspaceId` into receipt authority.

Record the ChatGPT build/date, DevSpace commit, operating system, tunnel, OAuth
scope set, and structured results. Never record bearer tokens, host identity
claims, receipt values, Owner passwords, or absolute paths outside the disposable
fixture.

## Preconditions

1. Use a disposable Git project under an approved root.
2. Add distinct root and nested instruction files.
3. Keep one checkout and at least one managed worktree available.
4. Record `devspace auth principals` before connector changes.
5. Use unique `operationId` values for new effects.
6. Refresh the ChatGPT app tools after schema changes.

## Matrix

| Scenario | Procedure | Required result |
| --- | --- | --- |
| First selection | Ask only to select a project and call `open_workspace` without a context mode, then attempt a read. | Open returns `state.phase=selected`; read is rejected with `workspace_context_incomplete` before file access. |
| One-call first load | Ask for immediate analysis/editing and open the user-named project with `contextMode="full"`. | The call succeeds in `context_loaded` and returns a v5 instruction manifest without instruction or Skill bodies. |
| Manifest-first instructions | Inspect full context, then call `load_workspace_instructions` for target paths. | Full context contains only manifest metadata; scoped load returns applicable bodies and a reviewed revision. Long files/chains use signed UTF-8-safe byte fragments of at most 8 KiB, reassemble without gaps or duplicates, and return an acknowledgement token only on the final page. |
| Unified cursor binding | Page Workspace, Skill, instruction, and process-output results; tamper with one cursor and reuse another under a different query/session. | Every continuation uses `dcur1`; tampered, expired, cross-principal, stale-generation, changed-query, and changed-revision cursors fail closed without effects. |
| Session-bound ordinary tools | In one ChatGPT conversation, read several files without sending receipt arguments. | Tools resolve the server-side `openai/session` binding and return only `workspaceAlias` plus `contextChanged=false`, not repeated continuation data. |
| Long conversation continuity | Keep the same authorized `openai/session` active beyond the old six-hour boundary. | The binding remains valid; only grant/epoch changes, Workspace lifecycle, LRU eviction, revocation, or server restart invalidate it. |
| Generic receipt mode | Use a client without `openai/session` and pass the current `wctx5` receipt. | The same Workspace is authorized. Missing/expired receipt is rejected before the handler. |
| Explicit invalid receipt | Supply an invalid receipt while a valid host session binding exists. | The call is rejected; DevSpace never falls back to host state after explicit invalid authority. |
| New conversation recovery | Start a different `openai/session`, call `list_workspaces`, then resume by alias and by `workspaceRef`. | Both recovery paths work without resending the host path and establish a new session binding. |
| Backend restart | Restart only for this row and keep the state directory. | Old in-process receipt/session bindings fail; retained aliases survive; `list_workspaces → resume_workspace` recovers. |
| Structured recovery | Trigger a context-required error with and without retained Workspaces. | Results distinguish `list_then_resume`/`hasRetainedWorkspaces=true` from `open_workspace_full`/false. |
| Grant refresh | Refresh an access token. | New tokens retain the original `grantId`, principal, scopes, and authorization epoch. |
| New isolated authorization | After Owner verification choose **new local connection** for the same client. | A new grant/principal is isolated from old Workspace state and old receipts. |
| Explicit principal reuse | Reauthorize the same client, choose an existing principal locally, and select roots. | Old client tokens/grants are revoked, the selected principal's aliases remain visible, Workspace generations advance, and old receipts fail safely. |
| Explicit reconnect | Authorize a fresh grant with a valid one-time reconnect code. | The grant joins the selected old principal; the code cannot be reused. |
| Per-grant roots | Give account A only root A and account B only root B, with identical capability scopes. | Each account can open/list/resume only its own roots; guessing the other path or alias is rejected. |
| Host subject consistency | Bind a grant using `openai/subject`, then send a different subject. | The later tool call is rejected. Logs and state contain only HMAC identifiers. |
| Host organization consistency | Repeat with `openai/organization`. | A conflicting organization is rejected; omission is handled according to the established grant binding. |
| Least-privilege default | Authorize without a `scope` parameter. | The grant receives only `workspace:read`; its lifecycle/read/inspection tools/list remains below 12 KB. |
| Static browse profile | Start with `DEVSPACE_TOOL_PROFILE=browse` and authorize every capability. | tools/list contains only the nine lifecycle/read/inspection tools, remains below 12 KB, and cached calls to mutation/process tools are unavailable. |
| Static coding profile | Start with `DEVSPACE_TOOL_PROFILE=coding` and authorize every capability. | The full 19-tool surface remains below 19 KB and is stable for the connection lifetime. |
| Scope-filtered change review | Inspect tools/list under a default read-only grant, then under an elevated read/write grant. | Read-only `show_changes` may preview without advancing; checkpoint advancement requires write scope plus an operation ID. |
| Scope-filtered process tools | Use a grant with `process:execute` but no network capability. | `write_stdin`/`read_process_output` remain available for an owned process; `exec_command` is not advertised. |
| Runtime capability schema | Inspect lifecycle output and `exec_command` schema. | Capabilities accurately report no process/network sandbox; unsupported `network="deny"` is absent. |
| Same-root cross-process writes | Run two DevSpace processes against the same checkout and overlap writes. | Reads may overlap; writer intent blocks later readers; writes serialize; stale `ifMatch` fails. |
| Background process lease | Start a background process and attempt a second same-root write from another process. | The second write waits or returns `workspace_root_busy` until the complete process tree exits. |
| Server crash with surviving child | Start a detached same-root process, kill the DevSpace server without cleanup, then start a replacement server. | The child PID/process-group marker keeps the physical-root write lease; the replacement cannot write until the orphan process tree exits. PID start/boot identity prevents reuse from preserving a stale lease. |
| External editor race | Read a file, modify it outside DevSpace, then apply the old version. | `file_version_conflict` prevents overwrite despite any OS lock state. |
| Batch fairness | Run several large batch items with a small aggregate budget. | Every item receives a fair reservation; omitted items say `aggregate_budget_exhausted`; reads retain `nextOffset`. |
| Lost mutation response | Drop a response, then retry the identical request with the same `operationId`. | The result replays once without executing again. Ordinary replay remains compact and does not attach stale continuation state. |
| Lifecycle replay | Repeat close/revoke with the same operation ID. | Cleanup effects are not repeated and the stored operation envelope is returned. |
| Unknown outcome resolution | Produce or seed an `outcome_unknown`, verify external evidence, then call `resolve_operation`. | The durable state becomes `verified_committed`, `verified_not_started`, or `acknowledged_unknown`; method/evidence/operator metadata is retained and the old ID remains a tombstone. |
| Self-management denial | Attempt to kill the current PID or restart the enrolled DevSpace service through `exec_command`. | The command is rejected before effects with recovery pointing to local Admin runtime control. |
| Persistent audit correlation | Trigger a tool failure, query `devspace audit`, and inspect runtime diagnostics. | Both show request/tool and anonymous connection/Workspace activity correlation plus error code/fingerprint, without paths, command text, host claims, tokens, or stacks. Human output uses China time. |
| Dirty worktree close/revoke | Modify a managed worktree and close/revoke it. | Tracked processes stop, the dirty worktree is retained, and structured effects describe what committed. |
| Transport configuration | Test default stateless and explicit stateful modes with identical OAuth registrations. | Behavior follows server configuration, not redirect host, User-Agent, location, or host hints. |
| Partial v1 Owner migration | Seed issued access/refresh tokens, a schema-v2 `auth.json` using `legacy-direct`, and a still-legacy SQLite scrypt verifier, then restart an isolated server. | Startup requires the legacy key to match both old scrypt and new Argon2id verifiers, upgrades SQLite in place, emits `oauth_owner_credential_upgraded`, preserves token counts, rejects the old process receipt, and permits `list_workspaces → resume_workspace` with the old access token. |
| Owner-password rotation | Rotate only the Owner password and restart only for this row. | Existing clients remain registered, old access/refresh tokens are unusable, and fresh authorization is required; root IDs, project fingerprints, aliases, and other master-key-derived continuity remain stable. |
| Master-key rotation | Stop the backend, replace only the persistent master key, then restart and reauthorize. | All purpose-derived HMAC identities, internal tokens, receipts, and cursors change; old grants/cursors fail safely and retained local state requires deliberate global recovery. |

## Pass Criteria

A release passes only when every applicable row has structured evidence and no
row relies on prose to infer whether an effect occurred. The server contract must
remain safe when the host loses a response, opens a new transport, starts a new
conversation, or presents stale cached tool definitions.

A host interoperability issue is not a reason to weaken grant ownership,
subject consistency, Workspace phase, scope checks, file versions, root locks,
or operation idempotency.
