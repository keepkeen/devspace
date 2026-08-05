<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  Let ChatGPT web inspect, edit, and verify local projects that you explicitly approve—much like a local coding assistant.
</p>

<p align="center">
  <a href="https://github.com/keepkeen/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/keepkeen/devspace/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/keepkeen/devspace/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2f6f44?style=flat-square"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-3f6b45?style=flat-square&logo=node.js&logoColor=white">
  <img alt="MCP Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-343a40?style=flat-square">
</p>

> [!IMPORTANT]
> This is a community-enhanced fork of
> [Waishnav/devspace](https://github.com/Waishnav/devspace), based on upstream
> commit [`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5), and
> maintained independently at [keepkeen/devspace](https://github.com/keepkeen/devspace).

## DevSpace in one minute

ChatGPT runs in the cloud and normally cannot open projects on your computer.
DevSpace runs a local MCP/OAuth backend that connects explicitly approved
Projects to ChatGPT web through bounded tool calls. The model can inspect files,
apply patches, run tests, review changes, and resume saved work in a later chat.

The experience resembles a local coding assistant, but the architecture is
different: the model still runs in the ChatGPT cloud, and tool requests reach
your computer over public HTTPS. DevSpace is not a local model, repository sync,
or backup service. It does not upload a repository when you connect; ChatGPT
receives only content returned by actual tool calls.

```text
ChatGPT web
    │  MCP + OAuth
    ▼
Public HTTPS URL ──► DevSpace (local 127.0.0.1:7676) ──► approved Projects

Local browser ─────► loopback-only administration / control service
```

DevSpace currently supports ChatGPT web only. It does not provide compatibility
modes for other MCP hosts.

### What you can do

- Ask ChatGPT to understand a local codebase and trace relationships across files.
- Batch-read known files or batch-run grep, glob, and directory inspections.
- Apply patches with file-version preconditions and review paginated changes.
- Run builds, tests, and development commands, including long-running processes.
- Load `AGENTS.md` instructions and Skills on demand instead of flooding context.
- Save a compact task summary and explicitly resume it from a new chat or grant.

### How it differs from local Codex

| | Local coding agent | ChatGPT + DevSpace |
| --- | --- | --- |
| Where the model runs | Usually orchestrated directly by a local client | In the ChatGPT cloud |
| Local file access | Direct client access | On-demand access through DevSpace MCP tools |
| Project selection | Often determined by the current directory | Explicitly approved by an OAuth grant |
| Command authority | Depends on the client's sandbox or permission mode | Inherits the DevSpace OS user's authority; not sandboxed |
| Continuing work | Depends on the client's session model | Explicitly resumes a bounded Task summary; no full chat transcript is stored |

> [!WARNING]
> `exec_command` is not a sandbox. File tools and command working directories
> stay inside the current Project, but child processes still have the authority
> and network access of the local OS user running DevSpace. They may reach
> content outside the Project. Use a dedicated OS user, container, or VM for
> high-risk environments.

## 10-minute quick start

### Prerequisites

- A ChatGPT account or Workspace whose policy allows developer mode and custom
  MCP connections. Availability can depend on account and Workspace policy.
- Node.js `>=22.19 <27`, npm, Git, and Bash (Git Bash or WSL on Windows).
- A tool that exposes `127.0.0.1:7676` through public HTTPS, such as
  [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
- A narrow project directory for testing. Do not approve your home or disk root.

The installation path currently verified by this repository is a source build.
The repository does not provide an automatic system-service installer.

### 1. Install

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --version
```

Use the same Node installation for install, build, and long-running service
startup because `better-sqlite3` depends on the Node ABI. Run `npm link` from the
repository if you want a global `devspace` command.

### 2. Start an HTTPS tunnel

Keep this running in a second terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

Record the HTTPS origin it prints, such as
`https://random-name.trycloudflare.com`. Enter that origin during initialization
without appending `/mcp`. Temporary hostnames change; use a stable domain for a
long-running deployment.

### 3. Initialize and serve

```bash
cd ~/tools/devspace
node dist/cli.js init
node dist/cli.js serve
```

The initialization wizard asks for narrow Project roots, the local port, and
the public HTTPS origin. Save the Owner password shown the first time. The OAuth
approval page requires it, and DevSpace stores only a verifier—it cannot recover
the plaintext password.

By default, the service advertises only `project:read` and `project:write` to
OAuth clients; local command execution is not available. If you need ChatGPT to
run builds and tests, and you understand the non-sandboxed risk, start it with:

```bash
DEVSPACE_OAUTH_SCOPES=project:read,project:write,process:execute node dist/cli.js serve
```

For a read-only connection, use `DEVSPACE_OAUTH_SCOPES=project:read`. After
changing scopes, restart the service, Refresh the ChatGPT connection, and
authorize again. Existing grants are never silently expanded.

Keep both `serve` and the tunnel from the previous step running. Use a third
terminal for the health checks below, and leave the first two processes running
while you use ChatGPT.

Default configuration and state locations:

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/
```

### 4. Verify the local and public service

```bash
curl -fsS http://127.0.0.1:7676/healthz
curl -fsS http://127.0.0.1:7676/readyz
curl -fsS https://random-name.trycloudflare.com/readyz
node dist/cli.js doctor
```

Success means `healthz` reports `status:"alive"`, and both `readyz` requests
return HTTP 200 with `ok:true` and `status:"ready"`. `doctor` checks local
configuration and dependencies; it does not prove public reachability or a real
ChatGPT authorization flow.

### 5. Connect ChatGPT

Follow OpenAI's current
[developer-mode MCP connection flow](https://developers.openai.com/plugins/deploy/connect-chatgpt):

1. In ChatGPT, open **Settings → Security and login** and enable
   **Developer mode**.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins) and add an MCP connection.
3. Set the MCP URL to the public origin plus `/mcp`, for example
   `https://random-name.trycloudflare.com/mcp`.
4. Connect with OAuth. On the DevSpace approval page, enter the Owner password
   and choose which Project roots this grant may access. The page displays the
   requested scopes; it does not provide separate capability checkboxes.
5. Complete authorization, review the tools ChatGPT discovered, then add the
   connection from the tools menu in a new conversation.

ChatGPT UI labels may change, and developer mode can be restricted by Workspace
policy. Treat the linked OpenAI documentation as authoritative for the current
host UI.

### 6. Complete a first read-only task

After connecting, send a prompt like this:

> Use DevSpace to show my approved Projects. Open the Project I name, read only
> `README.md` and `package.json`, and summarize its purpose and main scripts in
> three bullets. Do not modify files or run commands.

A complete success means ChatGPT selects or opens the correct Project, loads its
root instructions, reads both files, and returns a summary grounded in their
contents. The model handles `list_projects → open/resume → hydrate`; other
Project tools remain gated until root instructions are complete.

Once the read-only path works, try a small reviewable edit:

> Read the target file before editing. Make only the change I request, show the
> resulting changes, and do not commit them to Git.

## Everyday workflow

1. **Select a Project.** A single Project can open directly; with several,
   list them and choose explicitly.
2. **Acquire only needed context.** Read target files, grep or glob as needed,
   and load applicable `AGENTS.md` instructions and Skills without scanning the
   whole repository.
3. **Edit and verify.** Apply version-protected patches and run the smallest
   relevant tests.
4. **Review changes.** Explicitly inspect either the Git working-tree diff or
   the current execution's patch journal.
5. **Continue long work.** Save compact progress, then explicitly resume a Task
   from the Project in a later chat.

The default checkout uses the original approved directory. Different chats that
select that directory see the same files. If the Project root is exactly a Git
top level and the grant has write access, you can explicitly request a managed
worktree. Worktrees are isolated per Thread, not per Task.

## Concepts that matter

| Concept | What it means to a user |
| --- | --- |
| Project | A local root explicitly approved by the current OAuth grant. The model sees only an opaque reference and label. |
| Task | A bounded Project-level progress summary that can be explicitly resumed in a new chat or grant; not a chat transcript or file snapshot. |
| Thread | The current Actor's private runtime and lifecycle record, managed in the DevSpace Project UI. |
| execution | A runtime environment bound server-side to the trusted host session and Actor. The model never passes an `executionRef`. |
| checkout | The default original directory. Runtime state is isolated, but files are shared. |
| managed worktree | An optional per-Thread Git worktree, available only when the Project root is the Git top level. |

A successful `open`, `resume`, or `hydrate` updates the server-held execution
binding for the current session + Actor. Later tools use that binding
automatically and neither accept nor reuse an execution reference. If the
binding is absent or stale, open the Project again or resume an explicit
`taskRef`; DevSpace does not guess from recency or a sole candidate.

## Tools and batching

With all three scopes enabled and granted, the model can see these 11 tools:

| Category | Tools | Purpose |
| --- | --- | --- |
| Project and continuity | `list_projects`, `project_control`, `save_progress` | Select a Project, open/resume work, hydrate root instructions, save progress |
| Reading and context | `read_files`, `inspect`, `skills` | Read files, search/list directories, load Skills on demand |
| Editing and review | `apply_patch`, `show_changes` | Apply version-protected patches, inspect Git diff or patch history |
| Commands and processes | `exec_command`, `write_stdin`, `read_process_output` | Start commands, interact/interrupt, read active or retained output |

Both `read_files` and `inspect` accept batches of 1–8 items. The server handles
them concurrently, preserves input order, and reports success or failure per
item. Per-item and aggregate output budgets still apply; batching is not an
unbounded whole-repository read.

The default read + write configuration exposes only the first eight tools. The
three command and process tools appear only when the grant includes
`process:execute`. The visible tool surface is always filtered by the current
grant's actual scopes.

The Project UI has one additional App-only tool, `project_thread_control`, for
Thread listings and lifecycle management. The model should not call it. See the
[ChatGPT tool contract](./docs/chatgpt-tool-contract.md) for exact actions,
fields, scopes, cursors, and recovery behavior.

Under ChatGPT's published tool-result contract, `content` and
`structuredContent` are visible to both the model and the App, while result
`_meta` is delivered only to the App and hidden from the model. DevSpace keeps
UI projection data in `_meta`; authorization, path containment, and server-side
validation never depend on that visibility boundary.

## Permissions and security boundary

| OAuth scope | Capability |
| --- | --- |
| `project:read` | Discover Projects/Tasks and read instructions, Skills, files, and changes. |
| `project:write` | Apply version-protected patches and explicitly create a managed worktree. |
| `process:execute` | Interact with processes; starting a command also requires read and write. |

Understand these boundaries before deployment:

- **Approve narrow directories.** Never approve a home directory, filesystem
  root, cloud-drive root, or a directory containing unrelated private data.
- **Data is returned on demand.** The repository is not uploaded in advance,
  but file content, command output, and diffs are sent to ChatGPT when a tool
  returns them.
- **Commands are not sandboxed.** Project path checks are not an OS isolation boundary.
- **The default directory is shared.** Session, authorization, and process state
  are isolated; files in the original directory are not automatically isolated.
- **Repository content is untrusted.** `AGENTS.md`, Skills, logs, and
  model-authored summaries cannot expand an OAuth grant or Project root.
- **Writes have concurrency guards.** `ifMatch`, `operationId`, signed cursors,
  and root locks coordinate DevSpace operations. They cannot stop an editor,
  Git hook, or other local process from changing files.

See the [security model](./docs/security.md) for the complete trust model.

## Common issues

### ChatGPT shows no new tools or keeps using old arguments

Open the connection at [ChatGPT Plugins](https://chatgpt.com/plugins), select
**Refresh**, verify that its tool metadata changed, then retest in a new
conversation. Old chats may keep a cached snapshot after a tool schema change.

### The temporary tunnel hostname changed

Start the service with the new origin:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" node dist/cli.js serve
```

Then update the MCP URL in ChatGPT and authorize again. Restarting only the
tunnel is insufficient because the OAuth issuer and redirect URLs depend on the
public origin.

### `doctor` passes but ChatGPT still cannot connect

Check, in order: service terminal output → local `/readyz` → public `/readyz` →
OAuth approval → ChatGPT connection metadata. `doctor` does not probe the
tunnel or ChatGPT.

### `better-sqlite3` reports an ABI error

Confirm that the runtime Node version matches the one used to install
dependencies, then run:

```bash
npm rebuild better-sqlite3
```

See [common gotchas](./docs/gotchas.md) and
[real ChatGPT host acceptance](./docs/chatgpt-host-acceptance.md) for deeper
troubleshooting.

## Local administration and long-running deployment

```bash
node dist/cli.js admin
node dist/cli.js admin --no-open
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js audit --limit 100
node dist/cli.js audit health --json
```

Administration and internal control services bind to loopback and must never be
exposed through the tunnel. Only allowed roots currently support hot reload;
other configuration changes usually require a backend restart.

The repository includes a
[one-shot deployment helper](./docs/macos-launchd-deployment.md) for an already
configured macOS user LaunchAgent, with locking, readiness checks, and rollback.
It is not a first-time service installation guide or a cross-platform
`devspace deploy` command.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

When changing the browser UI or package, also run:

```bash
npm run test:browser
npm run test:pack
```

Treat the scripts in [`package.json`](./package.json) as authoritative.

## Further documentation

- [Setup and connection](./docs/setup.md)
- [ChatGPT coding workflow](./docs/chatgpt-coding-workflow.md)
- [ChatGPT tool contract](./docs/chatgpt-tool-contract.md)
- [Configuration reference](./docs/configuration.md)
- [Security model](./docs/security.md)
- [Common gotchas](./docs/gotchas.md)
- [Real ChatGPT host acceptance](./docs/chatgpt-host-acceptance.md)
- [macOS LaunchAgent deployment](./docs/macos-launchd-deployment.md)

## License

[MIT](./LICENSE)
