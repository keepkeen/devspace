<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  Let ChatGPT read, edit, run, and continuously maintain local projects within boundaries you explicitly approve.
</p>

<p align="center">
  <a href="https://github.com/keepkeen/devspace/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2f6f44?style=flat-square"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-3f6b45?style=flat-square&logo=node.js&logoColor=white">
  <img alt="MCP Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-343a40?style=flat-square">
</p>

> [!IMPORTANT]
> This is a community-enhanced fork of
> [Waishnav/devspace](https://github.com/Waishnav/devspace), based on upstream
> commit [`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5), and
> maintained independently at [keepkeen/devspace](https://github.com/keepkeen/devspace).

## What DevSpace is

ChatGPT runs in the cloud and cannot directly open your local projects. DevSpace
runs on your computer as the local MCP backend for a ChatGPT App, exposing only
Projects you approve to ChatGPT web through tool calls.

```text
ChatGPT web
    │
    ▼
Public HTTPS tunnel ──► MCP / OAuth service (127.0.0.1:7676) ──► approved Projects

Local browser ────────► loopback-only administration / control service
```

DevSpace does not upload an entire repository in advance and is not a second,
hidden coding model. ChatGPT receives only bounded content returned by actual
tool calls. The current implementation supports ChatGPT web only and does not
provide compatibility modes for other MCP hosts.

Core capabilities include:

- Project-centric persistent executions constrained by OAuth grants;
- concurrent accounts and grants, with authorization state, Threads, processes, and cursors isolated;
- version-preconditioned reads and patches, paginated diffs, idempotent operations, and cross-process root locks;
- resumable Threads, compact progress summaries, activity logs, and retained process output;
- on-demand discovery and loading of AGENTS instructions and Skills;
- the original approved directory by default, with optional managed worktrees for Git top-level Projects.

## Security boundary

Approve narrow project roots. Do not approve your home directory, filesystem
root, cloud-drive root, or a directory containing unrelated private data.

DevSpace constrains Project selection, tool paths, and command working
directories. It uses server-held session bindings, signed cursors,
`operationId`, `ifMatch`, persistent tombstones, and root locks to address
unauthorized access, replay, stale writes, and concurrent races. Repository
files, instructions, Skills, logs, and model-authored summaries remain
untrusted input and cannot expand an OAuth grant.

When ChatGPT supplies opaque `openai/subject` or `openai/session` metadata,
DevSpace stores only HMAC-derived references for Actor ownership and same-chat
Thread resolution. It does not store the raw identifiers and cannot access the
full chat transcript, hidden reasoning, token usage, or ChatGPT compaction
history.

> [!WARNING]
> `exec_command` is not a sandbox. Child processes have the authority of the
> local OS user running DevSpace and inherit network access, so they may reach
> content outside approved Projects. DevSpace does not provide a command
> allowlist, child-process filesystem isolation, or per-command network control.
> Use a dedicated OS user, container, or VM for high-risk environments.

## Quick start

See the [setup and connection guide](./docs/setup.md) for complete instructions.
The commands below use the repository-local CLI; after `npm link`, you may use
`devspace` instead of `node dist/cli.js`.

### 1. Install

You need Node.js `>=22.19 <27`, npm, Git, Bash (Git Bash or WSL on Windows), and
a tool that exposes the local service through public HTTPS, such as
[cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --help
```

Use the same Node installation for install, build, and long-running service
startup because `better-sqlite3` depends on the Node ABI.

### 2. Start an HTTPS tunnel

For temporary testing, keep this command running in a second terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

Record the HTTPS origin it prints, for example
`https://random-name.trycloudflare.com`. Enter the origin during initialization;
do not append `/mcp` there.

### 3. Initialize and serve

```bash
cd ~/tools/devspace
node dist/cli.js init
node dist/cli.js serve
```

Initialization asks for narrow Project roots, the local port, and the public
HTTPS origin. Save the Owner password shown by the wizard. The OAuth approval
page requires it, and the stored verifier cannot recover the plaintext value.

Default configuration and state locations:

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/
```

### 4. Check the service

```bash
curl http://127.0.0.1:7676/healthz
curl http://127.0.0.1:7676/readyz
curl https://random-name.trycloudflare.com/readyz
node dist/cli.js doctor
```

`healthz` means the process is alive; `readyz` means the service is ready to
accept requests.

### 5. Connect ChatGPT

Enable developer mode in ChatGPT and create a custom MCP App:

1. Set Endpoint to the public origin plus `/mcp`, for example
   `https://random-name.trycloudflare.com/mcp`.
2. Select OAuth and enter the Owner password on the DevSpace approval page.
3. Select the Projects and capabilities this grant may access.
4. Complete authorization, scan the tools, and enable the App in a chat.

Multiple OAuth grants may remain valid concurrently. A new account or
reauthorization does not replace other grants. Each bearer resolves only to its
own capabilities, approved Projects, and executions. ChatGPT may retain an old
snapshot after a tool schema change; rescan the tools or recreate the App.

If a temporary tunnel URL changes, override only that service launch:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" node dist/cli.js serve
```

Use a stable domain for long-running deployments. The tunnel must forward only
the MCP/OAuth service port, never the administration or internal control ports.

## Projects, Tasks, Threads, and executions

| Concept | Meaning |
| --- | --- |
| Project | A local root explicitly approved by the current OAuth grant. The model sees only an opaque reference and label. |
| Task | A shared bounded Project-level summary resumable across chats and reauthorization; `list_projects` lists it. |
| Thread | The current Actor's private runtime record; the model receives its `threadRef` and checkpoint only in bootstrap context. |
| execution | An active environment selected server-side for the trusted `openai/session` and Actor; its identity is never exposed to the model. |
| checkout | The default mode, using the original approved directory directly; logical state is isolated, but the filesystem is shared. |
| managed worktree | An explicit optional per-Task Git branch/worktree, available only for a Git top-level Project. |

Recommended chat workflow:

1. A single Project can use `project_control(action=open)` directly. With
   multiple Projects or when resuming work, call `list_projects` for an explicit
   `projectRef` and `tasks[].taskRef`.
2. Use `open` for a new task, or `resume` with an explicit `taskRef` for saved
   work. DevSpace does not guess by recency. The Project App shows Actor-private
   Thread listings and lifecycle controls.
3. Successful `open` or `resume` selects the execution for the trusted
   `openai/session` and Actor. If root instructions are long, continue `hydrate`
   with each returned cursor until `rootInstructionsComplete` is `true`.
   Thereafter call Project tools directly, without an execution reference.
4. Use `read_files`, `inspect`, and `skills` to acquire only needed context. If
   new nested instructions appear, read the returned instruction delta before
   retrying a change.
5. Finish work with `apply_patch`, `show_changes` with required `source`, and
   the smallest relevant verification commands. Use `save_progress` for compact
   long-task summaries and `read_process_output` for process output.
6. Use the Project App for Actor-private Thread pause, archive, complete, or
   close instead of asking the model to call lifecycle actions. Complete a
   shared saved Task and release capacity with in-execution
   `save_progress(status:"completed")`.

`open` and `resume` use `operationId` for safe retries and atomically replace the
current session+Actor selection. Selection, hydrate, and lifecycle operations
for one session+Actor are serialized in request order, so a slower older request
cannot overwrite a newer selection. A host session that remains stable across a
transport reconnect, service restart, or conversation change can call `hydrate`;
the server resolves and revalidates the bound execution under the current OAuth
principal, client, grant, authorization epoch, scopes, approved roots, and
Project identity. Concurrent
sessions may select different Projects, and neither a different Actor nor a
different session can reuse another binding. If the binding is missing or stale,
call `project_control(action=open)` or explicitly select a `tasks[].taskRef` and
call `resume`; never guess a recent or sole Project. Reauthorization creates a
fresh execution with no inherited process, command-replay, or
execution-private change state.

### Checkout modes

The default `checkoutKind:"checkout"` creates no branch or worktree. Two
executions bound to the same original Project directory see the same files; Git
management and concurrency coordination remain the responsibility of the user
and tools.

For a Project whose root is exactly the Git top level, a grant with
`project:write` may explicitly request `checkoutKind:"worktree"`. DevSpace
creates a managed branch/worktree under its private state directory, and
idempotent retries do not create duplicates. Project App Thread pause, archive,
and complete retain it; an ordinary close will not automatically delete a dirty
worktree. These actions do not complete the shared saved Task.

## Instructions, Skills, and context

- Root AGENTS instructions are returned in pages; other Project tools remain gated until the final page is acknowledged.
- Nested AGENTS instructions are discovered on demand for target paths rather than injecting the entire directory tree.
- `project_control` does not inject the complete Skill catalog. The model calls `skills(action=search)` for a small matching set, then `skills(action=load)` for one Skill's `SKILL.md`; its `skill://` resources remain lazy-loaded.
- User, administrator, and DevSpace Skills may be implicitly invoked. Repository Skills always remain untrusted repository content and cannot grant themselves implicit model invocation or broader authorization.
- Bootstrap context uses schema v8: execution identity stays server-side; `thread.threadRef` identifies the private Thread; scalar trust fields distinguish server-observed checkpoint state from an untrusted model summary; a truncated instruction has only `fragment.partial:true`.
- `save_progress` stores a bounded Project-level model summary, not the full chat. A later grant for the same Project can explicitly select that Task. Resumed progress appears only in `thread.checkpoint`, not as a duplicate Task object.

## OAuth capabilities and tools

| Scope | Capability |
| --- | --- |
| `project:read` | Discover Projects and Tasks, read instructions and Skills, and inspect files and changes. |
| `project:write` | Apply version-protected patches and explicitly request a managed worktree. |
| `process:execute` | Interact with processes; starting a command also requires `project:write`. |

Raw `tools/list` contains 12 tools. `project_thread_control` is marked Project
App-only, leaving exactly 11 model-visible tools; grant scopes further filter
that model-visible subset:

| Tool | Required scope | Purpose |
| --- | --- | --- |
| `list_projects` | read | Return approved Projects plus bounded `tasks`, `taskTrust`, and `taskLimits`. |
| `project_control` | read | Model bootstrap: open/resume/hydrate/interrupt; interrupt additionally requires execute. |
| `project_thread_control` | read; App-only | Manage Actor-private Thread resolve/list/status/activity/pause/archive/complete/close; it does not manage saved Tasks. |
| `save_progress` | read | Store a bounded Project-level Task and return `task.taskRef`; `status:"completed"` completes it and releases capacity. |
| `read_files` | read | Batch-read known files and their versions. |
| `inspect` | read | Batch grep, glob, or list directories. |
| `skills` | read | Search Skill metadata or load one Skill. |
| `apply_patch` | read + write | Apply patches with per-path version preconditions. |
| `show_changes` | read | Read a paginated Git diff or execution patch journal from an explicit `source`. |
| `exec_command` | read + write + execute | Start a direct argv command or a shell command with an explicit reason. |
| `write_stdin` | read + execute | Write, close, interrupt, or resize a tracked process. |
| `read_process_output` | read + execute | Poll an active process, or page, tail, and search retained output. |

For exact actions, fields, limits, cursors, and recovery rules, see the
[ChatGPT tool contract](./docs/chatgpt-tool-contract.md), which is normative.

## Files, changes, and processes

`read_files` returns file versions. `apply_patch` requires `ifMatch` for every
touched path and uses `operationId` to prevent duplicate side effects.
`show_changes` requires an explicit source. `source:"repository"` reads the
working-tree diff only when the Project root is itself a Git top level.
`source:"apply_patch_history"` is available for every Project and returns the
bounded, persistent journal of successful `apply_patch` operations for the
current execution; it does not pretend to record command-driven or external edits.

`exec_command` has two mutually exclusive forms: direct `program` + `args`, or
`shell:true` + `command` + `approvalReason` when pipes, redirection, or other
shell syntax is truly required. Its working directory must remain inside the
current checkout, but the child process still has the OS user's authority.

A long-running command retains the Project root lease, so other file or command
operations may return `project_busy`. `read_process_output` bypasses that root
lock and can continue reading stdout/stderr for an existing session. It does not
automatically read logs redirected to other files or produced by workers on a
remote machine.

## Local administration and deployment

```bash
node dist/cli.js admin
node dist/cli.js admin --no-open
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js config set widgets full
node dist/cli.js audit --limit 100
node dist/cli.js audit health --json
node dist/cli.js --version
```

The administration UI binds to loopback only and enforces capability,
Host/Origin, CSRF, and ETag checks. Currently, only allowed roots support hot
reload. User instructions, fallback filenames, widgets, resource limits, and
other settings require a backend restart.

The administration restart action controls only an explicitly registered macOS
user LaunchAgent and refuses to restart while processes are active. The
repository also contains a one-shot
[macOS deployment helper](./docs/macos-launchd-deployment.md) with locking,
readiness verification, rollback, and recovery planning. It is not a
cross-platform `devspace deploy` command.

## Development

```bash
npm ci
npm run build
npm test
npm run typecheck
```

When working on the browser UI or packaging, also run:

```bash
npm run test:browser
npm run test:pack
```

Treat the scripts in [`package.json`](./package.json) as authoritative.

## Documentation

- [Setup and connection](./docs/setup.md)
- [ChatGPT coding workflow](./docs/chatgpt-coding-workflow.md)
- [ChatGPT tool contract](./docs/chatgpt-tool-contract.md)
- [Configuration reference](./docs/configuration.md)
- [Security model](./docs/security.md)
- [Common gotchas](./docs/gotchas.md)
- [Real ChatGPT host acceptance](./docs/chatgpt-host-acceptance.md)
- [macOS LaunchAgent deployment](./docs/macos-launchd-deployment.md)
