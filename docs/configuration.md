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

## OAuth

DevSpace uses a single-user OAuth approval flow.

| Variable | Default |
| --- | --- |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` |
| `DEVSPACE_OAUTH_SCOPES` | `devspace` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `chatgpt.com,localhost,127.0.0.1` |

MCP clients discover metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

Workspace and MCP resources are owned by the OAuth `clientId`. Reauthorizing the
same registered client preserves access; a separately registered client cannot
reuse another client's MCP session, workspace, or process identifiers.
Changing the Owner password and restarting DevSpace revokes all access and refresh
tokens, but preserves public OAuth client registrations so ChatGPT and other MCP
clients can reauthorize without recreating their connector. The local Admin panel's
"revoke all" action deliberately removes both clients and tokens when a complete
reset is required.

## Resource Lifecycle and Limits

| Variable | Default | Purpose |
| --- | ---: | --- |
| `DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS` | `1800` | Close inactive stateful MCP transports. ChatGPT OAuth clients use stateless POST requests; workspace state is unaffected. |
| `DEVSPACE_MCP_SESSION_CLOSE_TIMEOUT_SECONDS` | `5` | Maximum wait for one transport to close. |
| `DEVSPACE_RESOURCE_CLEANUP_INTERVAL_SECONDS` | `300` | Sweep interval for idle resources. |
| `DEVSPACE_MAX_MCP_SESSIONS` | `64` | Combined cap for live stateful transports and concurrent stateless ChatGPT requests. |
| `DEVSPACE_MAX_MCP_SESSIONS_PER_CLIENT` | `8` | Per-client cap for that same combined MCP concurrency. |
| `DEVSPACE_MAX_PROCESS_SESSIONS` | `32` | Maximum retained process sessions. |
| `DEVSPACE_MAX_PROCESS_SESSIONS_PER_CLIENT` | `16` | Maximum retained process sessions owned by one OAuth client. |
| `DEVSPACE_MAX_PROCESS_SESSIONS_PER_WORKSPACE` | `8` | Per-workspace process limit. |
| `DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES` | `67108864` | Maximum durable output for one process (64 MiB; capped at 1 GiB). |
| `DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES` | `1073741824` | Total durable process-output storage (1 GiB; capped at 10 GiB). |
| `DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS` | `86400` | Retain completed process output for 24 hours. |
| `DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS` | `3600` | Hard upper runtime for every command. |
| `DEVSPACE_PROCESS_SHUTDOWN_GRACE_SECONDS` | `5` | SIGTERM grace period before SIGKILL. |
| `DEVSPACE_HTTP_DRAIN_TIMEOUT_SECONDS` | `30` | Drain deadline before remaining HTTP sockets are closed. |
| `DEVSPACE_WORKSPACE_IDLE_TTL_SECONDS` | `604800` | Close inactive non-worktree workspace sessions during lifecycle cleanup. |
| `DEVSPACE_MAX_RESIDENT_WORKSPACES` | `256` | Maximum workspaces retained in memory. |
| `DEVSPACE_MAX_ACTIVE_WORKSPACES_PER_CLIENT` | `32` | Maximum active persisted workspaces owned by one OAuth client. |
| `DEVSPACE_MAX_MANAGED_WORKTREES` | `64` | Maximum managed worktrees retained on disk. |

Clients must not call `close_workspace` as routine turn or conversation cleanup.
Call it only after the user explicitly asks to close or release that workspace.
It terminates running processes and closes the logical session. A clean managed
worktree is removed; a dirty managed worktree is retained and the workspace
stays open so its changes remain manageable.

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

`open_workspace` computes a stable `sha256-v1:` `instructionRevision` from the
ordered initial instruction paths and contents. A client can use it to detect
an unchanged initial chain and avoid retaining duplicate instruction bodies.

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

## Legacy Instruction Scan Settings

| Variable | Default |
| --- | ---: |
| `DEVSPACE_INSTRUCTION_SCAN_MAX_DEPTH` | `32` |
| `DEVSPACE_INSTRUCTION_SCAN_MAX_ENTRIES` | `100000` |
| `DEVSPACE_INSTRUCTION_SCAN_DEADLINE_MS` | `5000` |

These variables remain accepted for configuration compatibility but are no
longer used for a recursive workspace scan. `open_workspace` now returns
`instructionScan.lazy=true`, loads only explicit user/root instructions, and discovers
cached nested instructions when later tools enter their directory scope.

## Fixed Tool Surface

DevSpace exposes one Codex-style surface: `open_workspace`, `close_workspace`,
`read`, `batch_read`, `batch_inspect`, optional `load_skill`, `apply_patch`,
`exec_command`, `write_stdin`, and `read_process_output`. The legacy
`toolMode`, `DEVSPACE_TOOL_MODE`, and `DEVSPACE_MINIMAL_TOOLS` settings are
ignored so an old configuration file can still start without changing the
model-facing protocol.

Commands run without a PTY by default. Set `tty: true` on
`exec_command` for interactive terminal programs. PTY support uses the optional
`node-pty` dependency; `write_stdin` can send input, poll output, and resize PTY
sessions.

`exec_command` accepts a bounded `stdin` string for multiline Python, SQL, SSH,
and similar payloads. Supplying `stdin` closes the pipe by default so
programs waiting for EOF can finish; set `closeStdin: false` when additional
`write_stdin` calls will follow. `write_stdin` can later set `closeStdin: true`.
PTY input must remain open because DevSpace does not emulate EOF with Ctrl-D.

### Command policy

Shell commands are split at control operators (`&&`, `||`, `|`, `;`,
subshells) and inspected through bounded static nesting, including shell
payloads, heredocs, substitutions, `find -exec`, and `xargs`. Executable
`sudo`, forced or recursive `rm`, and piping content into an executing shell
are blocked; parse-only shell checks such as `bash -n` remain available. Normal
shell writes, redirection, and commands such as `mkdir`, `touch`, `cp`, and
`mv` are allowed. Literal targets for common direct writes are canonicalized
and rejected when they leave the workspace, including through a symlink.

This is an accident-prevention guardrail, not an operating-system sandbox.
Dynamic targets and opaque scripts run with the DevSpace OS user's permissions
and cannot be fully confined by shell parsing.
OAuth and the roots allowlist constrain MCP identity and dedicated file tools,
but permitted shell commands run with the DevSpace OS user's permissions. If
hard shell filesystem confinement is required, run DevSpace under a dedicated
OS account or container with only the approved roots mounted.

## Widgets

`DEVSPACE_WIDGETS` controls ChatGPT Apps iframe usage.

| Value | Behavior |
| --- | --- |
| `full` | Default. Widget UI is attached to exposed workspace, file, edit, and shell tools. |
| `changes` | Enables the aggregate `show_changes` tool and attaches widget UI to `open_workspace` and `show_changes`. |
| `off` | Disables widget UI. |

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

`open_workspace` returns a compact catalog containing profile names,
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
scope. Optional `agents/openai.yaml` is supported; set
`policy.allow_implicit_invocation: false` to require an explicit user request.
The `open_workspace` Skill catalog is limited to 8,000 serialized characters.
ChatGPT web loads a selected manifest of at most 64 KiB with `load_skill`; only
a complete, successful load opens access to that Skill's support files.

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

Set `DEVSPACE_LOG_SHELL_COMMANDS=1` only when you intentionally want command
previews in logs.

`GET /healthz` is a liveness check. `GET /readyz` returns `503` while shutting
down or when either SQLite store cannot answer a readiness probe. Structured
request and tool logs include request IDs and short OAuth client identifier hashes, but
never access tokens or full client identifiers.

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
