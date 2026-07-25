# Configuration Reference

DevSpace can be configured through `devspace init`, persisted config files, or
environment variables.

This fork is currently run from a source checkout. The examples use
`node dist/cli.js`; after `npm link`, the equivalent `devspace` command also
works.

The default files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

Use another config directory with:

```bash
DEVSPACE_CONFIG_DIR=/path/to/config node dist/cli.js serve
```

## Commands

```bash
node dist/cli.js init
node dist/cli.js serve
node dist/cli.js admin
node dist/cli.js admin --no-open
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js config set publicBaseUrl https://devspace.example.com
```

## Local Admin Panel

`devspace admin` starts a separate loopback-only management server on an
available port and opens its one-time capability URL. It is not mounted on the
public MCP listener and is not reachable through the configured tunnel.

The control panel provides:

- a refreshable overview of the local MCP service and public `/readyz` route
- allowed workspace roots
- an optional explicit user-level instruction file
- project-instruction fallback filenames
- widget mode (`full`, `changes`, or `off`)
- MCP, process, persisted-output, command-runtime, resident-workspace, and worktree limits
- per-OAuth-client MCP, process, and active-workspace quotas
- active resource counts, quota usage, recent sanitized failures, and a redacted diagnostic bundle
- one-click revocation of every registered OAuth client and access/refresh token
- inline validation, environment-override sources, discard/reset, and unsaved-change protection

Configuration documents use `schemaVersion: 1`. Legacy documents are migrated
with a versioned backup, and failed writes roll back. Admin reads return a
revision/ETag and saves use compare-and-swap, so a CLI or second panel cannot
silently overwrite newer changes. Saving reports whether a DevSpace restart is
required. Allowed-root changes are the exception: the backend applies them
immediately, and also watches atomic config-file replacements made by the CLI.
Removing a root invalidates affected workspace sessions and terminates their
running commands. When the enrolled user launchd service
is loaded, the panel also offers an explicitly confirmed **Save and restart**
action. The operation uses a one-time confirmation token and fixed `launchctl`
arguments. Success requires a new launchd PID, a changed `/readyz` generation,
and restored readiness; a successful `kickstart` exit alone is insufficient.

Set `DEVSPACE_LAUNCHD_SERVICE_LABEL` to explicitly enroll a user service, for
example `com.waishnav.devspace`. When it is unset or empty, runtime control is
disabled. Manual, system-owned, non-macOS, and unloaded services remain
status-only.

Tunnel checks are deliberately read-only. The panel probes the configured
public `/readyz` URL without credentials, redirects, or tunnel secrets, but it
does not start, stop, or adopt `cloudflared` processes.

## Core Environment Variables

| Variable | Purpose |
| --- | --- |
| `HOST` | Local bind host. Defaults to `127.0.0.1`. |
| `PORT` | Local port. Defaults to `7676`. |
| `DEVSPACE_ALLOWED_ROOTS` | Comma-separated local roots that workspaces may open. |
| `DEVSPACE_PUBLIC_BASE_URL` | Public origin for the server, without `/mcp`. |
| `DEVSPACE_ALLOWED_HOSTS` | Optional Host header allowlist override. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Owner password for OAuth approval. Must be at least 16 characters. |
| `DEVSPACE_WORKTREE_ROOT` | Directory for managed Git worktrees. Defaults to `~/.devspace/worktrees`. |
| `DEVSPACE_STATE_DIR` | Directory for SQLite state. Defaults to `~/.local/share/devspace`. |
| `DEVSPACE_USER_INSTRUCTIONS_PATH` | Optional user-level instruction file loaded before project instructions. Supports `~` or an absolute path; unset by default. |
| `DEVSPACE_LAUNCHD_SERVICE_LABEL` | Explicitly enrolled user launchd service that the local panel may restart; unset/empty disables control. |
| `DEVSPACE_MCP_HTTP_TRANSPORT` | `stateless` (default) or explicit `stateful`; never inferred from redirect hosts. |

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `workspace:read,workspace:write,process:execute,network:access,worktree:create,workspace:revoke` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

OAuth `client_id` identifies a dynamic registration. Authorization belongs to
a durable grant that records the connection principal, granted scopes, and
authorization epoch. Authorization codes and access/refresh tokens reference the
grant directly; refresh rotation preserves it and does not derive a principal
from `clientId`.

The first successful Owner approval normally creates a new grant and principal.
Use `devspace auth principals` and
`devspace auth reconnect-code <principal-id>` to deliberately attach a fresh
grant to an earlier principal. The one-time code is consumed once, and tokens
issued before a relink are revoked. A new grant remains isolated by default.

Tool-call metadata may contain `openai/subject`, `openai/organization`, and
`openai/session`. DevSpace persists only purpose-separated HMAC values. Subject
and organization are consistency, anonymous audit, and rate-limit dimensions;
they are not credentials. Session HMAC participates in the server-side Workspace
binding used by ChatGPT-style hosts.

A Workspace alias remains the durable project key. In a new conversation or
after restart, call `list_workspaces`, then `resume_workspace` by one alias or
`workspaceRef`. Do not reopen a remembered path merely because a receipt or
transport session disappeared. `projectFingerprint` distinguishes projects
without exposing absolute paths.

Managed Workspace records remain active when their worktree directory is
missing. `list_workspaces` reports `recovery_required`, and
`resume_workspace` with either the alias or workspaceRef and
`contextMode="full"` attempts to recreate the original
path under the same Workspace ID. DevSpace prefers the latest commit retained
in Git's worktree metadata, falling back to the saved base commit. If the
physical directory and its uncommitted files were lost, recovery reports
`dataLossPossible=true` rather than pretending those files were restored.

If an authorization request omits `scope`, DevSpace grants only `workspace:read`.
Elevated capabilities must be explicitly requested. tools/list is filtered by the
current grant and handlers repeat scope checks.

The granular scopes mean:

| Scope | Authority |
| --- | --- |
| `workspace:read` | Open/read approved workspaces, context, instructions, Skills, and metadata. |
| `workspace:write` | Modify files and review checkpoints; request writable checkout access. |
| `process:execute` | Start, poll, and interact with local processes. |
| `network:access` | Permit executed processes to inherit host network access. |
| `worktree:create` | Create managed Git worktrees. |
| `workspace:revoke` | Close or revoke Workspace authority. |

The OAuth approval page displays the requested capabilities, and every tool
checks its required combination immediately before execution.

Failed Owner-password attempts are limited by persistent SQLite token buckets
for the exact authorization session, dynamic client registration, source IP,
and a global fallback. Backoff grows after repeated exhaustion. A successful
authorization clears only its exact session key. When `DEVSPACE_TRUST_PROXY=1`,
forwarded client IPs are used only when the direct peer is loopback; otherwise
forwarding headers are ignored.
Changing the Owner password and restarting DevSpace revokes all access and refresh
tokens, but preserves public OAuth client registrations so ChatGPT and other MCP
clients can reauthorize without recreating their connector. The local Admin panel's
"revoke all" action deliberately removes both clients and tokens when a complete
reset is required. Before revocation, new tool calls are blocked and in-flight
calls are drained. Active Workspace cleanup is persisted as durable jobs, so
process/output/review cleanup resumes after a crash or restart. Clean managed
worktrees are removed; dirty worktrees are retained as auditable artifacts
instead of being deleted. Removed OAuth clients therefore cannot leave active
orphan Workspace authority.

## Resource Lifecycle and Limits

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS` | `1800` | Close inactive transports when `DEVSPACE_MCP_HTTP_TRANSPORT=stateful`; stateless is the default. |
| `DEVSPACE_MCP_SESSION_CLOSE_TIMEOUT_SECONDS` | `5` | Maximum wait for one transport to close. |
| `DEVSPACE_RESOURCE_CLEANUP_INTERVAL_SECONDS` | `300` | Sweep interval for idle resources. |
| `DEVSPACE_MAX_MCP_SESSIONS` | `64` | Combined cap for live stateful transports and concurrent stateless ChatGPT requests. |
| `DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT` | `8` | Per-connection-principal cap for that same combined MCP concurrency. |
| `DEVSPACE_MAX_PROCESS_SESSIONS` | `32` | Maximum retained process sessions. |
| `DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT` | `16` | Maximum retained process sessions owned by one connection principal. |
| `DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE` | `8` | Per-workspace process limit. |
| `DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES` | `67108864` | Maximum durable output for one process (64 MiB; capped at 1 GiB). |
| `DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES` | `1073741824` | Total durable process-output storage (1 GiB; capped at 10 GiB). |
| `DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS` | `86400` | Retain completed process output for 24 hours. |
| `DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS` | `3600` | Hard upper runtime for every command. |
| `DEVSPACE_PROCESS_SHUTDOWN_GRACE_SECONDS` | `5` | SIGTERM grace period before SIGKILL. |
| `DEVSPACE_HTTP_DRAIN_TIMEOUT_SECONDS` | `30` | Drain deadline before remaining HTTP sockets are closed. |
| `DEVSPACE_WORKSPACE_IDLE_TTL_SECONDS` | `604800` | Close inactive checkout sessions and clean managed worktrees. Dirty managed worktrees are retained. |
| `DEVSPACE_MAX_RESIDENT_WORKSPACES` | `256` | Maximum workspaces retained in memory. |
| `DEVSPACE_MAX_ACTIVE_WORKSPACES_PER_CLIENT` | `32` | Maximum active persisted workspaces owned by one connection principal. |
| `DEVSPACE_MAX_MANAGED_WORKTREES` | `64` | Maximum managed worktrees retained on disk. |

Stateless request capacity is released through one idempotent path when the
request is aborted, the HTTP response closes, or normal request cleanup runs.
Releasing the capacity slot does not cancel a tool handler that already began:
active-request barriers, process tracking, and mutation-operation records keep
tracking its real outcome. Protected internal diagnostics report current
stateless lease ages and occupancy grouped by anonymous `connectionRef` and
`oauthClientRef`, without exposing principal IDs or OAuth client IDs.

Clients must not call `close_workspace` as routine turn or conversation cleanup.
Call it only after the user explicitly asks to close or release that workspace.
It terminates running processes and closes the logical session. A clean managed
worktree is removed; a dirty managed worktree is retained and the workspace
stays open so its changes remain manageable.

Equivalent managed worktree opens are reused by default for the same connection
principal, source repository, and base commit. `forceNew: true` explicitly creates
a separate worktree and remains subject to the configured quotas. Missing
managed directories are reconciled out of active session listings and quota
counts.

## Project Instructions

An optional user-level file can be configured as `userInstructionsPath` in
`~/.devspace/config.json`, in the Admin panel, or through
`DEVSPACE_USER_INSTRUCTIONS_PATH`. The path supports `~`, must resolve to a
readable file, and is loaded before project instructions. It is disabled by
default: DevSpace does not implicitly read `~/.codex/AGENTS.md`, and
`DEVSPACE_AGENT_DIR` remains a Skill compatibility root only. A changed saved
path takes effect after a backend restart.

Within each project directory, DevSpace loads at most one instruction file in
this order: `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, then configured
fallback filenames. Uppercase `.MD` compatibility names are also recognized.
Whitespace-only candidates are skipped. The effective user, root, and nested
instruction chain has a combined 32 KiB UTF-8 budget and is never silently
truncated. Blank candidates are scanned with a 1 MiB hard limit so a huge file
cannot consume unbounded memory while being classified as empty.

Full Workspace context computes stable instruction and Skill revisions, but it
is manifest-first. `instructionManifest.files[]` contains source, trust, scope,
relative path, hash, and UTF-8 byte count, not instruction bodies.
`open_workspace` returns `selected` by default; explicit full mode or
`get_workspace_context(full)` advances to `context_loaded`. Retained mode is
valid only while refreshing the exact context whose revisions remain available.

Before handling concrete target paths, call
`load_workspace_instructions(paths)`. It returns only the applicable chain, a
`reviewedRevision`, and a one-use token when mutation gating requires one. The
context advances to `target_scoped`. `loadedForScope` means that the server
returned that revision; it is not a claim that a model agreed to obey it.
Read/search output never includes instruction Markdown and only advertises
`scopedInstructionsAvailable=true` when another scope must be loaded.

Configure fallbacks in `~/.devspace/config.json`:

```json
{
  "projectDocFallbackFilenames": ["TEAM_GUIDE.md", ".agents.md"]
}
```

Or set `DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES` to a comma-separated list.
Fallback entries must be plain filenames without path separators. They can also
be added and removed from the local Admin panel unless the environment
variable overrides the setting.

Before a shell command runs, literal `cd` and `pushd` destinations are checked
for nested instructions. Destinations must already exist, inherited `CDPATH`
is removed, and dynamic or opaque cwd-changing syntax is rejected. Prefer the
tool's `workingDirectory` field; split directory creation and execution across
two calls when necessary.

`exec_command` uses the global command runtime limit by default. Its optional
`timeoutMs` can set a shorter per-command hard limit, but cannot exceed the
global limit. `yieldTimeMs` only controls how long the tool waits before
returning a process session.

## Fixed Tool Surface

DevSpace exposes a stable surface filtered by the current OAuth grant. A default
read-only authorization receives the compact lifecycle and file/batch
inspection profile plus read-only change preview. Skills and operation status are
loaded only in the elevated coding profile to keep default tools/list bounded;
mutation, process, network, worktree, and revocation tools additionally require
matching capabilities. A cached old tools/list cannot bypass handler scope checks.

ChatGPT-style hosts normally use the server-side binding for
`(principal, HMAC(openai/session))`. Generic MCP clients pass a `wctx5`
receipt. Workspace IDs and generations are identifiers, not authority handles.
Explicitly supplying an invalid receipt never falls back to host state.

Lifecycle tools share a versioned result envelope with `schemaVersion: 1`,
Workspace identity, the three-phase state, `contextChanged`, and structured
errors. Workspace context uses `contextSchemaVersion: 5`. Ordinary tools return
only a compact `workspaceAlias`/`contextChanged: false` envelope plus their
result; they do not echo receipt, expiry, revisions, ID, or generation. A new
continuation is returned only when context phase, revision, or generation changes.
Receipts are bounded, fixed-expiry, in-process compatibility handles.

Commands run without a PTY by default. Prefer `program` plus `args`; use
`shell: true` plus `command` only for shell syntax. `cmd` and `cwd` are not
aliases. `stdin` is bounded and closes by default unless
`closeStdin: false` is set.

Runtime capabilities are reported in lifecycle output and on the OAuth approval
page. The default runtime has no process sandbox or per-process network isolation
and uses guardrail-only filesystem confinement. Consequently, unsupported
`network: "deny"` is removed from the advertised schema rather than offered as
a parameter that always fails. HTTP transport defaults to stateless and may be
explicitly configured as stateful; redirect URI, User-Agent, location, and other
host hints do not select authorization or transport behavior.

### Command policy

Shell commands are split at control operators (`&&`, `||`, `|`, `;`,
subshells) and inspected through bounded static nesting, including shell
payloads, heredocs, substitutions, `find -exec`, and `xargs`. Executable
`sudo` and piping content into an executing shell are blocked; parse-only shell
checks such as `bash -n` remain available. Normal shell writes, redirection,
build/test/package commands, and project-relative cleanup such as
`rm -rf dist` or `rm -rf node_modules` are allowed. Forced or recursive removal
is rejected when its target is outside the Workspace, is the Workspace root,
or cannot be resolved as a safe project-relative path. Literal targets for
common direct writes are canonicalized and rejected when they leave the
workspace, including through a symlink.

This is an accident-prevention guardrail, not an operating-system sandbox.
Dynamic targets and opaque scripts run with the DevSpace OS user's permissions
and cannot be fully confined by shell parsing.
OAuth and the roots allowlist constrain MCP identity and dedicated file tools,
but permitted shell commands run with the DevSpace OS user's permissions. If
hard shell filesystem confinement is required, run DevSpace under a dedicated
OS account or container with only the approved roots mounted.

New checkout workspaces default to `writeAccess: "read_only"`. File reads and
inspection remain available, but shell execution and mutation tools are
blocked because command parsing is not a read-only OS sandbox. Use a managed
worktree for the recommended writable flow, or explicitly request
`writeAccess: "read_write"` when modifying the user's current checkout is
intended. Existing persisted checkout sessions retain their previous writable
authority during migration.

`apply_patch`, `exec_command`, `close_workspace`, and `revoke_workspace`
require an `operationId` of at most 128 characters. `show_changes` is a
read-only preview by default and does not move its checkpoint; only
`advanceCheckpoint: true` requires `workspace:write` and an `operationId`. A
`write_stdin` call also requires one whenever it sends input, closes stdin, or
resizes a process; polling alone does not. The ID is unique within the current
connection principal, and its record stores the Workspace, generation, and
tool. Retrying an identical request with the same ID replays its stored result;
changing the request conflicts, and an uncertain post-crash outcome is never
executed automatically. Structured errors expose `code`, `retryable`,
`safeToRetry`, `recovery`, `phase`, and `effectsKnown`. Nonzero command exits
instead report `commandExecuted: true`, `status: "exited"`, and the exit code.
`get_operation_status` returns state and result availability without returning
the stored body. Expired replay bodies are cleared while their operation-ID
tombstones remain until Workspace deletion, so an old ID cannot execute again.
Reads expose `contentHash` and decimal-string `mtimeNs`. `batch_read` uses the
same before/after stability check and returns those versions with each file's
content, offset, and optional next offset/truncation marker;
`apply_patch` defaults to strict preconditions and requires an `ifMatch` entry
for every touched path before its first write. Use the latest read version for
an existing path and explicit `null` for a path expected not to exist. Missing
preconditions are rejected before the patch starts; there is no blind-write
bypass.

Workspace operations first use a fair process-local read/write queue keyed by
the canonical physical root and then coordinate through a cross-process lock in
a per-user lock directory. Reads and inspections may share the read side;
`show_changes` preview also uses it and is available to every `workspace:read`
grant.
`apply_patch`, `exec_command`, mutating `write_stdin`, explicit checkpoint
advancement, close, and revoke use the write side even when different principals
or different DevSpace state directories opened the same checkout. A live
background or interactive process retains the write lease until its complete
process tree exits. External editors are outside this protocol, so strict
`ifMatch` file versions remain required.

## Widgets

`DEVSPACE_WIDGETS` controls only ChatGPT Apps iframe usage. It does not add or
remove model-callable tools; OAuth scopes determine the tool surface.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to all eligible exposed tools, including `show_changes`. |
| `changes` | Limits widget UI to `open_workspace` and `show_changes`; the tool remains exposed independently of this setting. |
| `off` | Disables widget resources and descriptor metadata. Tools, including `show_changes`, remain available according to OAuth scopes. |

Widget `_meta` is presentation-only. DevSpace does not duplicate heavy body
text in `_meta.card.payload.content`; widgets consume the top-level tool result.
Hosts that do not render ChatGPT Apps may ignore `_meta` without losing the
model-visible result or any state required for a later tool call.

## Skills

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_SKILLS` | Set to `0` to hide skills. Enabled by default. |
| `DEVSPACE_SUBAGENTS` | Set to `1` to expose configured agent profiles as Subagents. Experimental and disabled by default. |
| `DEVSPACE_AGENT_DIR` | Defaults to `~/.codex`; only its `skills` child is loaded for compatibility. It is not an instruction source. |
| `DEVSPACE_SKILL_PATHS` | Optional comma-separated additional skill directories. |
| `DEVSPACE_DISABLED_SKILL_PATHS` | Optional comma-separated Skill directories or `SKILL.md` paths to disable. Relative paths resolve from the opened workspace. |
| `DEVSPACE_ADMIN_SKILLS_DIR` | Admin-managed Skill root. Defaults to `/etc/codex/skills`. |

DevSpace discovers standard Agent Skills from, in order:

- repository-ancestor `.agents/skills` directories, from the most specific approved root/repository boundary to the opened workspace
- `~/.agents/skills`
- `DEVSPACE_ADMIN_SKILLS_DIR`
- the Skill directory bundled with DevSpace

It also keeps compatibility with:

- `~/.devspace/skills`
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When Subagents are enabled, DevSpace discovers agent profiles
from:

- `~/.devspace/agents/*.md`
- project `.devspace/agents/*.md`

Full context from `get_workspace_context` or `resume_workspace` returns a
compact catalog containing profile names,
descriptions, providers, and optional models/thinking levels so the host model can choose an
agent without reading provider-specific launch details. `devspace agents ls`
lists existing subagent sessions for the current workspace, scoped by the
workspace environment injected into shell commands. The `subagent-delegation`
skill teaches the model to use only the minimal `devspace agents ls`,
`devspace agents run`, and `devspace agents show` workflow.

Starter profile templates are available under `examples/agents/`. Copy or adapt
them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

Each manifest requires non-empty string `name` and `description` frontmatter.
Duplicate names are retained and distinguished by stable ID, path, source, and
scope. Repository Skills are always marked `repository_untrusted` and require
explicit loading; repository `agents/openai.yaml` cannot grant them implicit
invocation. User/admin/bundled and explicitly configured local Skill roots may
use their local `agents/openai.yaml` policy. To locally allowlist one repository
Skill, add its exact directory or `SKILL.md` path to `DEVSPACE_SKILL_PATHS`;
explicit local sources take precedence over automatic repository discovery and
the same manifest is still loaded only once.
Explicit-only Skills are excluded from automatic full context and remain
discoverable through an explicit `list_skills` query. The implicit-invocation
full-context Skill catalog is limited to 8,000 serialized UTF-8 bytes.
Catalog descriptions are single-line, control/HTML/code-block sanitized, and
bounded before serialization. ChatGPT web loads a selected manifest of at most
64 KiB with `load_skill`; the result separates fixed server text from
structured source/trust metadata and `skill.content`. Only a complete,
successful load opens access to that Skill's support files.

Example:

```bash
DEVSPACE_SKILL_PATHS="$HOME/.claude/skills,$HOME/company/skills" \
node dist/cli.js serve
```

## Logging

| Variable | Default |
| --- | --- |
| `DEVSPACE_LOG_LEVEL` | `info` |
| `DEVSPACE_LOG_FORMAT` | `json` |
| `DEVSPACE_LOG_REQUESTS` | `1` |
| `DEVSPACE_LOG_ASSETS` | `0` |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `0` |
| `DEVSPACE_TRUST_PROXY` | `0` |

Set `DEVSPACE_LOG_FORMAT=pretty` for local debugging.

Boolean environment variables accept `1,true,yes,on` and
`0,false,no,off` (case-insensitive). Other values fail startup instead of
silently disabling a feature.

`exec_command` uses a minimal inherited child-process environment rather than
copying the DevSpace server's complete environment. Basic path, home/user,
temporary-directory, locale, and operating-system variables are retained.
Additional command-specific values must be supplied explicitly through the
tool's `environment` input; server OAuth credentials, CI tokens, proxy secrets,
SSH-agent sockets, and `NODE_OPTIONS` are not inherited automatically.

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

`GET /healthz` is a liveness check. `GET /readyz` returns `503` while shutting
down or when either SQLite store cannot answer a readiness probe.

Structured request and tool logs use four correlation levels:

- `requestId` identifies one HTTP/MCP request.
- `oauthClientRef` (`oauth_…`) identifies one dynamic OAuth client registration.
- `connectionRef` (`conn_…`) identifies the local connection principal across
  token refreshes and any explicitly approved connector relink.
- `workspaceActivityRef` (`act_…`) identifies one principal + `workspaceId`
  activity, so conversations working on different projects can be separated.

None of these references is a verified
ChatGPT account or conversation ID: ChatGPT's
remote MCP contract does not provide those claims to DevSpace. A removed and
re-added connector receives a new `oauthClientRef`; it also receives a new
`connectionRef` unless the owner explicitly uses a reconnect code. Two
conversations using the same principal and same reused workspace remain
intentionally indistinguishable. Logs never contain reconnect codes, access
tokens, Authorization headers, or full OAuth client identifiers.

## Env-Only Example

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="$HOME/personal,$HOME/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="$HOME/.devspace/worktrees" \
DEVSPACE_WIDGETS="full" \
node dist/cli.js serve
```

The environment assignments must be part of the same command invocation, or
exported first.
