# Model-facing I/O optimization target (contract v9)

## Objective

Reduce context pollution and schema-generation errors by exposing only data the
model needs to make its next decision. Move presentation, audit, lifecycle, and
mechanical protocol state out of the model-facing contract where the current
server can do so without weakening authorization, idempotency, concurrency, or
recovery guarantees.

This is an intentional breaking cleanup of the ChatGPT-only public tool
contract. Do not add compatibility paths for the removed v8 fields.

## Baseline

- MCP root instructions: about 521 UTF-8 bytes.
- Raw `tools/list`: 12 tools; model-visible surface: 11 tools.
- Measured `tools/list` response: 15,118 UTF-8 bytes, with a 16 KiB test ceiling.
- `read_files` and `inspect`: bounded batches of 1–8 items.
- Initial Project listing: up to 100 Projects, 20 resumable Tasks per Project,
  and 100 Tasks globally.

## Non-negotiable invariants

The optimization must preserve:

- OAuth scope filtering and approved-Project path containment;
- server-held session + Actor execution binding;
- explicit Project selection when more than one Project is available;
- `taskRef`-based cross-chat and cross-reauthorization recovery;
- optimistic concurrency (`ifMatch`, post-write versions, input revisions);
- mutation idempotency and unknown-outcome safety;
- signed, caller-bound continuation cursors while cursors remain model-managed;
- instruction, Skill, checkpoint, repository, and process-output trust boundaries;
- explicit first-page `show_changes.source` selection;
- process addressing and terminal state (`sessionId`, `outputId`, exit, signal,
  timeout, truncation, and unrecoverable dropped output);
- structured recovery semantics (`phase`, `effectsKnown`, `safeToRetry`).

## Stage-by-stage target

| Stage | Remove or move out of model input | Remove or compress in model output | Keep model-visible |
| --- | --- | --- | --- |
| Connect / `tools/list` | Presentation knobs such as terminal dimensions and output-token budgets; flat optional fields that hide action requirements | App-only lifecycle vocabulary | OAuth/security annotations and concise tool-selection guidance |
| Project discovery | `defaultProjectRef`; fixed task limits | Eager Task metadata, constant `resumable` status, creation timestamps, duplicate prose/counts | Project ref, label, truncation, Task count/trust |
| Task discovery | Tasks for unselected Projects | UI timestamps and constant status | Selected Project's `taskRef`, title, version, updated order |
| `open` | Infrastructure fields only when a stable host replacement exists | Repeated operation echo on success | Project choice and checkout choice |
| `resume` | Model-side private `threadRef` selection | Full private Thread projection | `taskRef` and bounded untrusted checkpoint summary |
| `hydrate` | No removal of cursor until host/server owns continuation | Repeated schema, success, Project, Thread, and completion fields | Instruction delta, trust, next cursor |
| Instructions | Deterministic duplicate source/trust fields | Constant root scope | Content, path, partial state, one trust/source classification |
| Skills | Flat `action`; name-based load when stable `skillId` exists | Success/action echoes, duplicate source, manifest hash, load-time scope | Search metadata, cursor, `skillId`, trust, content, resource root |
| `read_files` | Batch `ref`; explicit defaults | Aggregate success counts, per-item constant provenance, default offset, duplicate truncation | Path, content/error, continuation, directly reusable version, instruction delta |
| `inspect` | Batch `ref`; required root path for `ls` | Aggregate counts, per-item provenance, duplicate error text and truncation notices | Operation/path correlation, bounded result/error, instruction delta |
| `apply_patch` | Nothing that weakens operation idempotency or `ifMatch` | Constant precondition/confidence fields, observation timestamp, redundant before state | Patch intent, operation identity, post-write versions, fuzzy-match evidence, recovery state |
| `show_changes` | Repeated source on cursor continuation | Revision and byte offsets/counts, duplicate source/provenance, detailed file stats | First-page source, patch, compact summary/trust, next cursor |
| `exec_command` | Model-authored `approvalReason`; terminal columns/rows; output-token and yield tuning | Constant stream/coverage/executed fields, approximate token counts, duplicate output ID | Direct vs explicit shell intent, cwd, timeout/TTY when needed, process/output refs and terminal state |
| `write_stdin` | Terminal dimensions from the model | Full repeated process envelope | Session, action, operation idempotency, expected/input revision |
| Process output | Model-selected token budget/yield timing | Repeated offsets/eof/byte counters and constant provenance | Session/output ref, text/search matches, status, next cursor, dropped/truncated state, input revision |
| `save_progress` | No semantic fields removed | Echoed title/time and private Thread projection | Task ref, version, status |
| Checkpoint | UI timeline fields | Timestamps and full internal observed state | Clearly separated server-observed state and untrusted model summary |
| Errors | Audit-only metadata | Duplicate `error` and `operation` recovery envelopes; read-only mutation constants | One authoritative code/recovery/phase/effects/safe-retry envelope plus corrective details |
| Thread lifecycle/activity | All model access except current-session execution needs | Raw event/session IDs, lifecycle projections | Project App/control plane only |

## Implementation batches

### Batch A: Project discovery and bootstrap

- Make global `list_projects` return Projects plus resumable Task counts, not
  Task details for every Project.
- Use a Project-scoped request to load resumable Tasks lazily.
- Remove `defaultProjectRef`, fixed `taskLimits`, constant Task status, and
  duplicate natural-language counts.
- Make public `project_control` constraints match handler behavior as far as the
  current MCP SDK schema surface permits; produce explicit validation errors for
  any remaining conditional constraints.
- Remove model-side `threadRef` resume. Thread discovery/lifecycle stays App-only.
- Keep the first bootstrap page complete with Project/checkpoint/instructions;
  keep private Thread projection model-hidden and return instruction-only deltas
  on continuation pages.
- Remove `schemaVersion`, `ok:true`, and redundant completion booleans from the
  model-facing page when the cursor already expresses continuation.

### Batch B: Instructions, Skills, and read tools

- Collapse deterministic instruction source/trust duplication to one explicit
  classification without weakening repository-content distrust.
- Simplify Skills calls to search `{query, limit?}`, continue `{cursor}`, or load
  `{skillId}`; remove name-based load and redundant load metadata.
- Remove batch `ref` from `read_files` and `inspect`.
- Return a directly reusable version object from `read_files`.
- Hoist provenance once only for a uniform source/trust batch; mixed
  repository/Skill reads carry actual provenance per item.
- Remove aggregate counts/status fields and duplicate prose/error/truncation
  representations while preserving per-item partial failure. All-failed
  read-only batches keep tool-specific safe-retry error semantics until the
  Batch D envelope consolidation.

### Batch C: Changes, commands, processes, and progress

- Compress `apply_patch` effects to path/operation/post-version/fuzzy-match and
  required recovery information.
- Require `show_changes.source` only on the first call; cursor continuation is
  cursor-only. Remove revision and byte-range statistics from model output.
- Remove `approvalReason`, terminal dimensions, model output-token budgets, and
  yield-time tuning from process tools. Keep explicit shell intent.
- Return one process/output reference and a compact terminal/output envelope.
- Keep byte/token details in audit/UI metadata unless they express irreversible
  truncation or loss.
- Return only Task ref/version/status from `save_progress`; keep private Thread
  projection in the Project App.

### Batch D: Recovery and UI/control-plane separation

- Use one authoritative mutation recovery envelope rather than duplicating the
  same state under `error` and `operation`.
- Remove read-only error fields whose values are invariant (`phase:not_started`,
  `effectsKnown:true`) unless a caller needs them for a shared parser.
- Keep private Thread listings, activity, timestamps, lifecycle mutations, and
  raw process/session event details App-only.
- Keep audit-only error categories, durations, byte counters, command metadata,
  and correlation refs out of model results.
- Resolve model `interrupt(operationId)` only from the trusted current
  session+Actor execution binding. Reject model-authored `threadRef`, keep raw
  process session IDs App/audit-only, and fail a missing binding with explicit
  open/resume recovery.
- Keep bootstrap Project output to ref/write access/checkout kind, and separate
  checkpoint facts as `serverObserved` plus optional `untrustedSummary` without
  timestamps or duplicate trust scalars.

Implementation status: Batches A-D are complete for every non-deferred target.
The host/protocol-dependent questions below remain research items and were not
implemented by assumption.

Independent Batch D review follow-ups are also complete: Project creation/replay
is Actor-bound with legacy replay allowed only when the existing Thread mapping
belongs to that Actor; execution-to-Thread mappings cannot be rebound; interrupt
validates the binding's exact execution/Thread pair; async command terminal
states update a sanitized Actor/Thread checkpoint; multi-path scalar `ifMatch`
supports corrected same-ID retry; mutation operation IDs use one exact-value
contract (well-formed Unicode, non-empty, no NUL, at most 128 UTF-8 bytes) at
every public and durable entry; unknown grant-wide legacy Thread owners fail
closed without opportunistic Actor reassignment; and persisted
unknown/not-started/result-unavailable states
have real MCP envelope/replay/conflict coverage.

## Confirmed host contract

OpenAI's published ChatGPT tool-result contract confirms that `content` and
`structuredContent` are visible to both the model and the component and appear
in the conversation transcript, while result `_meta` is delivered only to the
component and is hidden from the model. DevSpace may therefore keep UI-only
projection data in `_meta`, but `_meta` must never replace authorization,
secure storage, or server-side trust checks. Real-host acceptance retains one
non-sensitive canary smoke test as regression evidence; product correctness no
longer depends on discovering this visibility boundary experimentally.

Reference: https://developers.openai.com/plugins/reference#tool-results

## Deferred host/protocol research

These are explicitly out of the implementation batches until measured or
supported by the ChatGPT host/protocol:

1. Replace model-generated `operationId` with a stable host tool-call/idempotency
   key that survives lost-response retries. Server-generated per-request IDs are
   not a safe substitute.
2. Remove model-managed cursors by having the host or server automatically drive
   multi-page continuation without hiding instruction pages from the model.
3. Determine whether model-facing output schemas reduce generation errors or
   merely move the same token cost into `tools/list`.
4. Verify whether the ChatGPT host always supplies a stable Actor subject. The
   existing subjectless-host path keeps its grant-wide legacy identity fallback
   but cannot claim or migrate a subject-owned Thread; removing that fallback
   requires a measured host identity guarantee and an explicit migration policy.

## Acceptance criteria

- All non-deferred stage targets are implemented in code, tests, and normative
  documentation.
- Model-visible `tools/list` is materially below the current 15,118-byte baseline
  and the context-budget test records the new ceiling.
- A global Project listing contains no unrelated Task titles or timestamps.
- Hydrate continuation pages contain only new instruction material and a
  continuation signal.
- Batch read/search results preserve item order, partial failure, versions,
  instruction deltas, and bounded output with fewer repeated fields.
- Mutation tests still prove idempotent replay, stale-write rejection, and
  conservative unknown-outcome recovery.
- Same-grant different-Actor tests prove creation replay, Thread rebinding, and
  interrupt cannot cross Actor boundaries.
- Legacy grant-wide ownership tests prove list/read/replay never migrates or
  leaks an unknown-owner Thread to either current Actor.
- Every mutation schema and durable operation entry accepts exact 128-byte ASCII
  and multibyte IDs, rejects larger, NUL-bearing, or non-well-formed Unicode IDs
  before reservation or effects, and preserves the original untrimmed identity
  for hashing/storage without aliasing malformed surrogates to `U+FFFD`.
- Process tests still prove direct/shell separation, async output recovery,
  concurrent process addressing, interruption, timeout, and terminal logging.
- A command that returns running must later expose its sanitized terminal and
  retained/lost-output recovery state through the correct resumable checkpoint.
- Security tests prove repository/Skill/checkpoint trust remains explicit and
  model-hidden/UI/audit data does not leak back into model results.
- Normative documentation relies on the published ChatGPT result-visibility
  contract; one non-sensitive real-host canary remains only as a regression
  smoke test and never as an authorization or secure-storage control.
- `npm run typecheck`, all affected context-budget/E2E/protocol tests, full
  `npm test`, and `git diff --check` pass.
