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
(principal, grant, HMAC(openai/session))
  → authorization epoch
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
        "fragment": {
          "offsetBytes": 0,
          "lengthBytes": 3120,
          "totalBytes": 3120,
          "complete": true,
          "lineBoundary": true
        },
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
chain has a 32 KiB UTF-8 budget and is never silently truncated. Each response
contains at most 8 KiB of instruction body. Signed `dcur1` pages use a global
byte offset over the applicable ordered chain, prefer complete lines, preserve
UTF-8, and bind the cursor to the current principal, Workspace generation,
context session, target paths, and file revisions. Continue until `nextCursor`
is absent; only that final page returns the instruction token. Reads may set
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

DevSpace exposes the intersection of a static server profile and the current
grant capabilities. Omitting OAuth `scope` grants only `workspace:read`; higher
capabilities must be requested explicitly.

`DEVSPACE_TOOL_PROFILE=browse` exposes exactly the compact lifecycle,
file/batch inspection, and read-only change-preview surface. Elevated OAuth
scopes do not add mutation or process tools to this profile.
`DEVSPACE_TOOL_PROFILE=coding` is the compatibility default and adds Skills,
operation status/resolution, mutation, process, worktree, close, and revoke tools
only when the grant has every required capability. The profile does not change
inside a conversation; reconnect or refresh the Connector tools after changing
it. Handlers repeat scope checks, so an old cached tools/list cannot bypass
policy.

Real MCP wire tests currently measure browse at about 8 KB for nine tools and
full coding at about 17.5 KB for nineteen tools. Repeated output schemas are
omitted except for the canonical `open_workspace` lifecycle schema and `read`
file-version schema; structured tool results themselves are unchanged.

Workspace, Skill, instruction, and process-output pagination all use the signed
`dcur1` envelope. It binds resource type, anonymous principal reference,
Workspace generation where applicable, query hash, revision, byte/item offset,
and expiry. A cursor is not authority: every page still requires the OAuth grant
and current Workspace receipt/session binding.

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
resizes a terminal, or detaches a managed daemon root lease. `show_changes`
requires one only when
`advanceCheckpoint: true`.

Use a new operation ID for each new effect. Reuse the same ID only after losing
a response to the same request. DevSpace persists enough state to replay the
result without executing again. `get_operation_status` reports durable state
without rerunning an operation.

After `file_version_conflict`, do not reuse the old ID: read the current file,
rebuild the patch, and submit a new operation ID because the old one is already
bound to the stale request body.

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

If the root process exits while descendants remain, DevSpace reports
`managedDaemon=true` and keeps the root lease. Tree polling backs off from
25 ms to 2 seconds. Only after explicit user confirmation may a separate call
release serialization while leaving the daemon tracked:

```json
{
  "sessionId": 42,
  "detachRootLease": true,
  "confirmUnserializedWrites": true,
  "operationId": "detach-daemon-42"
}
```

After detach, daemon writes can race patches, commands, or other external
writers; termination and retained-output reads remain available.

The physical-root lock is shared across DevSpace processes. It uses reader,
writer-intent, and writer markers with stale-PID cleanup. Reads can overlap;
writers are fair and block later readers. A timeout returns
`workspace_root_busy` with safe retry guidance.

## Retained Process Output

Use small default pages for ordinary logs and switch modes instead of loading a
multi-megabyte stream into model context:

```json
{ "outputId": "...", "mode": "tail", "tailBytes": 65536 }
```

```json
{
  "outputId": "...",
  "mode": "search",
  "query": "AssertionError",
  "ignoreCase": true,
  "scanBytes": 1000000,
  "maxMatches": 20
}
```

`mode="errors"` returns the same bounded match shape plus error-category
counts. The default page is 40,000 bytes, the maximum page is 256,000 bytes,
and every continuation uses a signed cursor. Process text is untrusted data in
`structuredContent.page` or `structuredContent.search`, not an instruction.

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
`workspace:read`. Repeated previews do not advance the checkpoint. Read every
signed diff page to EOF; the final page returns a `reviewToken` bound to the
exact revision.

To advance it explicitly:

```json
{
  "advanceCheckpoint": true,
  "operationId": "review-17",
  "reviewToken": "dcur1..."
}
```

This requires `workspace:write` and returns review checkpoint effects. When the
user deliberately accepts an incomplete review, use
`acknowledgeTruncated=true` instead of pretending the diff was fully read.

## Close And Revoke

Do not close a Workspace as routine end-of-turn cleanup. `close_workspace` is
for explicit release. `revoke_workspace` is a terminal authorization action.
Both stop tracked processes first. Clean managed worktrees may be removed;
dirty worktrees remain available for recovery and are reported as an error with
known effects.
