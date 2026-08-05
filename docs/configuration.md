# Configuration Reference

DevSpace is configured with `devspace init`, persisted files, the local admin
panel, and environment variables. It is designed for ChatGPT web and exposes
one fixed model-tool surface.

Examples below use the repository-local CLI:

```bash
node dist/cli.js
```

After an optional `npm link`, the equivalent `devspace` command also works.

## Files and precedence

Default locations:

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/
```

Use another configuration directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config node dist/cli.js serve
```

Environment variables override corresponding persisted settings for that
process. When an environment variable owns a setting, change the environment
and restart the service instead of editing the field in the admin panel.

`auth.json` contains authentication material. Do not commit, copy into support
logs, or expose it through the HTTPS tunnel.

## CLI commands

```bash
node dist/cli.js init
node dist/cli.js serve
node dist/cli.js admin
node dist/cli.js admin --no-open
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js config set publicBaseUrl https://devspace.example.com
node dist/cli.js audit --limit 100
```

`init` configures approved roots, the local port, public origin, and Owner
credential. `serve` starts the MCP/OAuth service. `admin` starts a separate
loopback-only management UI.

## Local admin panel

The admin panel is local-only. It must not be routed through the public tunnel
or reverse proxy.

Use it to review and update:

- approved Project roots;
- the public HTTPS origin;
- the optional user instruction file;
- Skills configuration;
- resource and process-output limits;
- logging and local diagnostics.

The panel reports when a change requires a restart. Tunnel checks are
read-only; DevSpace does not start or adopt the tunnel process.

## Core server settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Public-service bind address. Keep loopback unless the deployment explicitly requires another interface. |
| `PORT` | `7676` | Public MCP/OAuth service port. |
| `DEVSPACE_CONTROL_PORT` | `PORT+1` | Loopback-only diagnostics/control port. Never tunnel or proxy it. |
| `DEVSPACE_PUBLIC_BASE_URL` | none | Public HTTPS origin, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | derived | Optional Host-header allowlist override. |
| `DEVSPACE_ALLOWED_ROOTS` | configured by `init` | Comma-separated ceiling containing approved Projects. |
| `DEVSPACE_WIDGETS` | `full` | `full` enables the Project/context picker and change card; `changes` keeps only the change card; `off` disables both. |
| `DEVSPACE_STATE_DIR` | `~/.local/share/devspace` | SQLite state, retained output, review pages, and locks. |
| `DEVSPACE_USER_INSTRUCTIONS_PATH` | unset | Optional user-level instruction file. |
| `DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES` | unset | Optional comma-separated instruction fallback names. `CLAUDE.md` is loaded only when explicitly listed here. |

Choose narrow roots. A root is the maximum local boundary from which Projects
may be approved; it does not automatically authorize every OAuth connection to
use every Project.

After adding a root, approve a new OAuth grant and select the new Project.
Multiple accounts/connections may keep independent grants active at once,
including grants sharing one OAuth client ID. A new approval does not replace
another grant. Removing a root prevents new Project operations under that root.
Root removal does not delete checkout files.

## Public endpoint

If the configured origin is:

```text
https://devspace.example.com
```

the ChatGPT MCP endpoint is:

```text
https://devspace.example.com/mcp
```

Do not store `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

Useful probes:

```text
GET /healthz
GET /readyz
```

`/healthz` is liveness. `/readyz` is readiness and may return `503` while the
service cannot accept work.

When a temporary tunnel hostname changes:

1. set the new public origin;
2. restart DevSpace;
3. update the ChatGPT app endpoint;
4. authorize the app again.

## OAuth

DevSpace has one hidden local Owner and supports multiple concurrently active
OAuth grants. Each bearer is isolated by its exact client, grant,
authorization epoch, scopes, and approved Projects.

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password used to approve OAuth. Must be kept secret. |
| `DEVSPACE_MASTER_KEY` | Persistent key material for server-side identifiers and tokens. Prefer the auth-file value created by `init`. |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | Access-token lifetime. |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | Refresh-token lifetime. |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | Allowed OAuth redirect hosts. |

Public scopes are fixed to:

```text
project:read
project:write
process:execute
```

Their meanings are:

| Scope | Capability |
| --- | --- |
| `project:read` | List and select approved Projects; load instructions and Skills; read, inspect, and review changes. |
| `project:write` | Apply patches. |
| `process:execute` | Explicit high-trust opt-in for process input/output and, together with `project:write`, command creation. |

The approval page verifies the Owner password and selects Projects and
capabilities for that grant. Multiple grants may remain active concurrently,
including grants issued through the same OAuth client. Each bearer retains its
own exact grant, authorization epoch, scopes, and approved Projects.

ChatGPT discovers OAuth metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

## Project executions and saved Tasks

ChatGPT account and conversation metadata are not configuration inputs.
Authorization comes from the OAuth bearer grant.

`project_control(action=open)` creates a durable logical context on the approved
Project and selects it for the trusted `openai/session` and Actor. Its internal
identity is not model-visible. With one approved Project, `projectRef` may be
omitted; with multiple Projects, choose a reference returned by
`list_projects`. In `widgets=full` mode, that tool renders an interactive card
with a new-task action and bounded resumable Tasks for each Project. Card
actions ask the model to call `project_control` with `open` or `resume`, so the
model receives and acknowledges every root-instruction page.

Model-facing Project tools are called without an execution reference. DevSpace
resolves their current execution from the exact trusted session+Actor binding
and revalidates the current OAuth principal, client, grant, authorization epoch,
scopes, allowed roots, Project identity, and workspace on every call. A stable
host session can call `project_control(action=hydrate)` after transport reconnect,
service restart, or a conversation change that preserves the same host session
value. Different Actors and sessions cannot share the binding; concurrent
sessions may select different Projects.
Successful open or resume atomically replaces the current session+Actor
selection. Creation requires a caller-stable `operationId`, so retrying a lost
response returns the same execution instead of creating another context.

Reauthorizing creates a new grant and does not transfer an old execution. If the
session binding is missing or stale, call `project_control(action=open)` or call
`list_projects`, explicitly select a resumable `tasks[].taskRef`, and call
`project_control(action=resume)` with a new `operationId`. There is no latest- or
sole-Project fallback. No old execution workspace, process session, command
replay, or execution-private patch history is inherited.

`save_progress` records a bounded semantic Task for the Project. It does not
persist a chat transcript or ChatGPT account/session identity. A new task always
uses explicit `action=open`; recovery always uses explicit `action=resume` with
one selected `taskRef` (or a current private `threadRef`). DevSpace never
automatically continues the newest or sole Task. A grant that authorizes the
same Project can continue its saved Tasks, but continuation always creates a new
execution bound to that calling grant.

Task updates use a caller-stable `operationId` and the current integer
`ifMatch` version. Titles are limited to 256 UTF-8 bytes, progress to 8 KiB,
their JSON-serialized model text to 12,000 bytes, and each Project to 20
resumable Tasks plus the newest 80 completed records. `list_projects` returns
`tasks`, `taskTrust`, and `taskLimits`; use its Project-scoped form to avoid the
global listing limit. Resumed progress is historical, untrusted context and
must be validated against current Project files before use. `save_progress`
returns a `task` object containing its opaque `taskRef` and current version.
If an update reports a Task revision conflict, list and reconcile the current
Task, then retry with the same `operationId` and current `ifMatch`; do not mint a
new operation identifier for that rejected attempt.

Git is optional. Checkout mode uses the approved directory, so different
logical contexts see one another's file changes. For a Project root that is
exactly a Git top level, `checkoutKind:"worktree"` can explicitly create a
managed per-Task worktree. Keep
`DEVSPACE_STATE_DIR` private and persistent because it stores grant bindings,
saved Tasks, idempotency records, patch history, cursors, and retained
output.

## Project instructions

Open, resume, and hydrate return compact, bounded effective root instruction pages.
`read_files` and `inspect` return any newly applicable nested
`instructionsDelta` with the target result; a gated mutation or command can
return the delta with `instructions_required` before any effect starts.

By default the per-directory repository convention is `AGENTS.override.md`
then `AGENTS.md` (including supported case variants). `CLAUDE.md` is not an
implicit fallback. Add it explicitly through `projectDocFallbackFilenames` in
`config.json`, the local admin panel, or
`DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES`.

Configure an optional user-level instruction file with
`DEVSPACE_USER_INSTRUCTIONS_PATH`; it must be an absolute path or a supported
home-relative path.

Instructions are guidance, not authorization. They cannot expand approved
roots or OAuth capabilities.

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_AGENT_DIR` | Local agent directory; its `skills` child may be used as a Skill source. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional Skill directories. |
| `DEVSPACE_DISABLED_SKILL_PATHS` | Optional comma-separated Skill directories or manifests to disable. |
| `DEVSPACE_ADMIN_SKILLS_DIR` | Admin-managed Skill root. |

Project bootstrap does not inject the Skill catalog. The single `skills` tool uses
`action=search` for bounded discovery and `action=load` with
a returned `skillId` or exact unique name to load one selected manifest.
Repository Skills remain untrusted repository content and do not add OAuth
authority.

## Fixed tool surface

Raw `tools/list` contains these twelve names:

```text
list_projects
project_control
project_thread_control
save_progress
read_files
inspect
skills
apply_patch
show_changes
exec_command
write_stdin
read_process_output
```

`project_thread_control` is marked App-only and shows/manages Actor-private
Threads through resolve/list/status/activity/pause/archive/complete/close. It
does not manage the shared saved Tasks returned by `list_projects`; completing
one and releasing capacity requires `save_progress(status:"completed")` from
its active execution. The control is absent from model instructions, leaving 11
model-visible names. Model-visible `project_control` has only open, resume,
hydrate, and interrupt. There is no tool-profile configuration. OAuth
capabilities determine which tools remain available; `exec_command` requires
all three public scopes. After a schema change, rescan or rebuild the ChatGPT
App so its cached snapshot matches the server.

### `exec_command`

The advertised command fields are:

| Field | Purpose |
| --- | --- |
| `operationId` | Required fresh identifier for a new command effect. |
| `program` / `args` | Preferred direct argv command mode. |
| `shell` / `command` / `approvalReason` | Explicit shell mode for syntax that requires it. |
| `workingDirectory` | Working directory inside the Project selected for the trusted session+Actor. |
| `environment` | Explicit environment additions. |
| `yieldTimeMs` | Initial wait before returning a running-process handle. |
| `maxOutputTokens` | Output bound for the call. |
| `tty` | Allocate a pseudo-terminal. |

DevSpace does not expose command-policy or network-policy configuration.
`process:execute` must be explicitly approved. `workingDirectory` is checked for Project
containment, but the child process itself runs with the full file and network
authority of the DevSpace OS user.

`write_stdin` is mutation-only: it sends input, closes stdin, interrupts, or
resizes a terminal, and every call requires `operationId`. Use
`read_process_output` with `sessionId` for live polling or with `outputId` for
the first retained-output read.

Signed continuation cursors retain the initial query. A continuation call under
the same session+Actor selection passes the returned cursor instead of repeating
or changing the initial resource, query, offset, mode, or limit fields.

DevSpace can attempt shutdown or interrupt only for process groups it started
and still tracks. Termination is best effort; detached or otherwise untracked
descendants may survive.

## Shared Project and change-review lifecycle

DevSpace validates the Project path and grant binding whenever a logical
execution is used. Grant revocation or expiry retires that grant's logical
contexts, tracked processes, retained output, and temporary review state. It
does not delete Project files or run Git lifecycle commands.

`show_changes` requires an explicit source. `source:"repository"` reads the
current repository diff without writing Git state only when the Project root
exactly matches the Git top level. `source:"apply_patch_history"` is available
for every Project and is a bounded durable log of the exact successful DevSpace
`apply_patch` requests for the current logical execution, rather than a net filesystem diff; command writes,
external edits, and patches made through another execution are excluded. When
the journal is full, start a new logical context against the same shared
Project. The Admin panel and `devspace doctor` report execution diagnostics but
expose no worktree inventory or cleanup action. `doctor` also reports the full
path of the newest pre-migration database backup when one exists.

## Upgrading pre-v20 databases

The single-Owner migration preserves registered OAuth clients, shared Project
inventory, audit history, and compatible mutation history. It deliberately
drops pre-v20 grants and bearer/refresh tokens because their legacy scopes
cannot be translated to current capabilities without risking privilege
escalation. Each ChatGPT connection must authorize again after the upgrade;
one new authorization does not replace another.

Pre-v21 checkout sessions are retained as closed shared Projects. Legacy
managed worktrees are never opened or modified: they are recorded in the
read-only quarantine inventory, including historical owner/alias provenance.
Unexpired unresolved worktree mutations stop the migration. Expired unresolved
mutations are quarantined with an unknown-effects warning, while their full
source records remain in the automatic pre-migration database backup.

## Resource and output limits

Common process and request limits include:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DEVSPACE_RESOURCE_CLEANUP_INTERVAL_SECONDS` | `300` | Sweep interval for inactive resources. |
| `DEVSPACE_MAX_PROCESS_SESSIONS` | `32` | Maximum retained process sessions. |
| `DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES` | `67108864` | Maximum retained output for one process. |
| `DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES` | `1073741824` | Total retained process-output storage. |
| `DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS` | `86400` | Retention time for completed process output. |
| `DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS` | `21600` | Hard command runtime limit. |
| `DEVSPACE_PROCESS_SHUTDOWN_GRACE_SECONDS` | `5` | Grace period before forced process cleanup. |
| `DEVSPACE_MAX_REQUEST_BODY_BYTES` | `33554432` | Maximum inbound MCP JSON body. |

Read, inspection, diff, command, and retained-process results are bounded.
Large output should be narrowed rather than treated as permanent storage.

Per-root locks coordinate file writes and tracked commands. These locks apply to
cooperating DevSpace operations; external editors and unrelated local processes
remain outside that coordination.

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_AUDIT_EVENTS` | `1` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Use `DEVSPACE_LOG_FORMAT=pretty` for local development.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when command previews are safe to
retain. Logs and audits must never be treated as an appropriate place for Owner
passwords, OAuth tokens, tunnel credentials, source secrets, or sensitive
command output.

Boolean environment values accept `1,true,yes,on` and `0,false,no,off`
case-insensitively. Invalid values fail startup.

## Environment-only example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/code/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_STATE_DIR="$HOME/.local/share/devspace" \
node dist/cli.js serve
```

The assignments must be part of the same invocation or exported before
starting the service.

See [ChatGPT Tool Contract](./chatgpt-tool-contract.md) for the canonical
execution, scope, tool, mutation, and cursor behavior.
