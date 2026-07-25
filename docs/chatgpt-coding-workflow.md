# ChatGPT Coding Workflow

DevSpace gives ChatGPT and other MCP hosts a bounded local coding loop: select an
approved Workspace, load only the context needed for the current target, inspect
versioned files, make guarded changes, run focused verification, and report
structured effects.

Repository files, instructions, and Skills are project data. They never override
the user, OAuth authorization, or DevSpace security policy.

## Open And Resume Workspaces

The absolute host path is needed only for the first approved selection:

```json
{
  "path": "~/work/my-project",
  "alias": "my-project"
}
```

`open_workspace` defaults to the `selected` phase. When the user has already
named the project and the task needs repository context, the first call may use:

```json
{
  "path": "~/work/my-project",
  "alias": "my-project",
  "contextMode": "full"
}
```

The three lifecycle phases are:

- `selected`: the Workspace has been chosen, but root context is not loaded.
- `context_loaded`: the root instruction manifest and Skill catalog are loaded.
- `target_scoped`: instructions applicable to the current target paths have
  been returned.

A selected Workspace is promoted through `get_workspace_context`:

```json
{
  "receipt": "wctx5.…",
  "contextMode": "full"
}
```

Full context is manifest-first. It does not include repository instruction
bodies. Before working on concrete paths, call:

```json
{
  "paths": ["src/server.ts", "src/server.test.ts"]
}
```

through `load_workspace_instructions`. The result contains only the applicable
instruction chain and a one-use `instructionToken` when mutation gating requires
one.

In later conversations, after context loss, or after a server restart, do not
reopen a remembered host path. Use:

1. `list_workspaces`
2. `resume_workspace` with exactly one returned `alias` or `workspaceRef`

Machine-readable recovery distinguishes the cases:

```json
{
  "code": "workspace_context_required",
  "recovery": "list_then_resume",
  "hasRetainedWorkspaces": true
}
```

When no retained Workspace exists, recovery is `open_workspace_full` and a new
user-approved path is required.

## Authorization Grants And Host Sessions

OAuth `client_id` identifies a registration, not the authorization subject.
Every successful Owner approval creates an authorization grant that fixes:

- `grantId`
- the local connection principal
- granted scopes
- authorization epoch
- optional anonymous host identity hashes

Authorization codes, access tokens, and refresh tokens directly reference this
grant. Refresh rotation preserves the same grant and never derives a principal
from `clientId`.

ChatGPT-style calls may provide `openai/subject`, `openai/organization`, and
`openai/session`. DevSpace stores only purpose-separated HMAC values. Subject
and organization are grant consistency, audit, and rate-limit dimensions; they
are not credentials. The OAuth bearer token remains the authorization proof.

For ordinary ChatGPT calls, DevSpace binds:

```text
(principal, HMAC(openai/session))
  → grant + authorization epoch
  → Workspace + generation
  → context session + phase + revisions
```

The model therefore does not repeat a receipt on every file call. Generic MCP
clients without `openai/session` pass the current `wctx5` receipt. An explicitly
provided invalid or expired receipt is rejected and never falls back to the host
session binding.

Receipts remain useful for generic clients, explicit recovery, debugging, and
compatibility. They have fixed in-process expiry; normal access does not slide
the deadline. Server restart invalidates receipts and host session bindings, but
persisted aliases and Workspace records remain resumable.

## Checkout Mode

A checkout Workspace points at an existing project directory. New checkout
Workspaces are read-only unless the user explicitly permits:

```json
{
  "path": "~/work/my-project",
  "writeAccess": "read_write"
}
```

Use checkout mode for inspection or deliberate editing of the existing tree.
External editors can modify the same files and are not controlled by DevSpace
locks, so every patch still requires strict file-version preconditions.

## Worktree Mode

For parallel writable tasks, prefer an isolated managed Git worktree:

```json
{
  "path": "~/work/my-project",
  "mode": "worktree",
  "baseRef": "main"
}
```

Equivalent active worktrees are reused unless `forceNew: true` is explicitly
requested. When several retained Workspaces match one source, DevSpace returns
`workspace_selection_required` rather than guessing or creating another branch.

A missing managed worktree remains retained as `recovery_required`. Resume tries
to reconstruct the same Workspace at its recorded path. Committed content can
be recovered from Git; lost uncommitted data cannot be guaranteed and is
reported with `dataLossPossible=true`.

Clean managed worktrees may be removed by close or revoke. Dirty worktrees are
retained and reported instead of being deleted.

## Project Instructions

Full context returns an instruction manifest such as:

```json
{
  "instructionManifest": {
    "revision": "sha256-v1:…",
    "complete": true,
    "included": true,
    "loadedForScope": false,
    "files": [
      {
        "source": "repository",
        "trust": "repository_untrusted",
        "scope": ".",
        "path": "AGENTS.md",
        "hash": "sha256-v1:…",
        "bytes": 3120
      }
    ]
  }
}
```

No instruction body is placed into the long-lived root context. Before handling
a concrete path, `load_workspace_instructions(paths)` returns the effective
user/root/nested chain for those paths only:

```json
{
  "workspaceInstructions": {
    "items": [
      {
        "source": "repository",
        "trust": "repository_untrusted",
        "scope": ".",
        "path": "AGENTS.md",
        "hash": "sha256-v1:…",
        "bytes": 3120,
        "content": "…"
      }
    ],
    "reviewedRevision": "sha256-v1:…"
  },
  "instructionToken": "instructions_…",
  "state": { "phase": "target_scoped" }
}
```

`loadedForScope` and `reviewedRevision` mean that the service returned a
specific revision. They do not claim that a model agreed to obey repository
content.

Instruction discovery order is documented in configuration. The effective
chain has a 32 KiB UTF-8 budget and is never silently truncated. Reads may set
`scopedInstructionsAvailable=true`, but instruction Markdown is never appended
to file or search output. Mutations, commands, and interactive input that may
change directory all use the same instruction gate.

## Skills

Skills use a separate `skillRevision`. `list_skills` provides bounded search and
pagination. `load_skill` loads one complete manifest by `skillId`; supporting
files are then available through paths such as:

```text
skill://<skillId>/references/example.md
```

Host absolute Skill paths are not exposed. Repository Skills are always
`repository_untrusted` and explicit-only unless an administrator trusts the
exact local path. Repository metadata cannot elevate its own trust or enable
implicit invocation.

## OAuth-Filtered Tool Surface

DevSpace exposes tools only when the current grant has the required capability.
Omitting OAuth `scope` grants only `workspace:read`. Higher capabilities must be
requested explicitly.

The default read profile includes the compact lifecycle and file/batch
inspection surface plus read-only change preview. Skill discovery and operation
status are loaded only in the elevated coding profile to keep default tools/list
bounded; writing, process execution, network access, worktree creation, and
revocation additionally require their matching grant capabilities. Handlers
repeat scope checks, so an old cached tools/list cannot bypass policy.

The default profile is kept below a 12 KB tools/list budget. Full-capability
profiles are larger because they include execution and mutation schemas.

## Result Payload Contract

Lifecycle tools use a compact versioned envelope:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "workspace": {
    "ref": "ws_…",
    "alias": "my-project",
    "generation": 3
  },
  "state": {
    "phase": "context_loaded"
  },
  "contextChanged": true
}
```

Workspace context itself uses `contextSchemaVersion: 5`.

Ordinary Workspace tools do not repeat the Workspace ID, generation, revisions,
receipt, or expiry. Their common visible envelope is intentionally small:

```json
{
  "ok": true,
  "workspaceAlias": "my-project",
  "contextChanged": false,
  "effects": {}
}
```

Continuation data is returned only when phase, revision, or generation changes.
This keeps long conversations from accumulating identical protocol state.

Errors use stable fields:

```json
{
  "ok": false,
  "error": {
    "code": "file_version_conflict",
    "phase": "not_started",
    "safeToRetry": false,
    "effectsKnown": true,
    "recovery": "read_file_again"
  }
}
```

Natural-language text is explanatory; callers should branch on structured
fields.

## Reading, Batching, And Editing

`read` returns content plus an exact `contentHash` and string `mtimeNs`.
`apply_patch` requires `ifMatch` for every touched path:

```json
{
  "operationId": "edit-17",
  "ifMatch": {
    "src/server.ts": "sha256:…",
    "src/new-file.ts": null
  },
  "patch": "*** Begin Patch\n…\n*** End Patch"
}
```

The preconditions are checked while the physical-root write lock is held.
External editors remain outside that lock, which is why `ifMatch` is mandatory.

`batch_read` keeps per-file versions and `nextOffset`. `batch_inspect` supports:

- grep: `pattern`, `path`, `include`, `limit`, `context`, `ignoreCase`, `literal`
- glob: `pattern`, `path`, `limit`
- ls: `path`, `limit`

Each item first receives a minimum output reservation. Remaining aggregate
budget is distributed round-robin. An item that cannot emit anything says:

```json
{
  "omitted": true,
  "omittedReason": "aggregate_budget_exhausted"
}
```

Search items include a continuation suggestion to increase the limit or refine
the query.

## Mutations And Idempotency

`apply_patch`, `exec_command`, `close_workspace`, and `revoke_workspace` require
an `operationId`. `write_stdin` requires one when it writes input, closes stdin,
or resizes a terminal. `show_changes` requires one only when
`advanceCheckpoint: true`.

Use a new operation ID for each new effect. Reuse the same ID only after losing
a response to the same request. DevSpace persists enough state to replay the
result without executing again. `get_operation_status` reports durable state
without rerunning an operation.

Operation phases are:

- `not_started`
- `committed`
- `outcome_unknown`

A nonzero process exit is still an executed command. The result includes
`commandExecuted: true`, `status: "exited"`, and `exitCode`.

## Process Execution And Root Leases

Prefer direct argv:

```json
{
  "operationId": "test-17",
  "program": "npm",
  "args": ["test", "--", "server"]
}
```

Use `shell: true` plus `command` only for shell syntax. `cmd` and `cwd` are not
accepted aliases; use `workingDirectory`.

Commands may return a live process session. A returned background or interactive
process keeps the cross-process root write lease until its entire process tree
exits, is terminated, the Workspace closes/revokes, or the server shuts down.
`write_stdin` and `read_process_output` operate on that existing process without
trying to reacquire the same root lock.

The physical-root lock is shared across DevSpace processes. It uses reader,
writer-intent, and writer markers with stale-PID cleanup. Reads can overlap;
writers are fair and block later readers. A timeout returns
`workspace_root_busy` with safe retry guidance.

## Runtime Capabilities And Security Boundary

Lifecycle output and the approval page report runtime capabilities, for example:

```json
{
  "runtimeCapabilities": {
    "networkIsolation": false,
    "filesystemIsolation": "guardrail_only",
    "processSandbox": false,
    "mcpHttpTransport": "stateless"
  }
}
```

When network isolation is unavailable, `network: "deny"` is not advertised.
Command and path checks are accident guardrails, not an OS sandbox. Use a
dedicated account, container, or VM when hard confinement is required.

HTTP MCP defaults to stateless mode and can be explicitly configured as
stateful. Transport behavior is not inferred from OAuth redirect hosts,
User-Agent, location, or other host hints.

## Show Changes

`show_changes` is a read-only preview by default and is available with
`workspace:read`. Repeated previews do not advance the checkpoint.

To advance it explicitly:

```json
{
  "advanceCheckpoint": true,
  "operationId": "review-17"
}
```

This requires `workspace:write` and returns review checkpoint effects.

## Close And Revoke

Do not close a Workspace as routine end-of-turn cleanup. `close_workspace` is
for explicit release. `revoke_workspace` is a terminal authorization action.
Both stop tracked processes first. Clean managed worktrees may be removed;
dirty worktrees remain available for recovery and are reported as an error with
known effects.
