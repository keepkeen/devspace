<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  Let ChatGPT read, edit, and test local projects that you approve.
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

## What DevSpace does

ChatGPT runs in the cloud and cannot directly open a local checkout. DevSpace
runs on your computer and exposes approved Projects to ChatGPT web through a
local MCP server and a public HTTPS endpoint.

```text
ChatGPT web → HTTPS tunnel → DevSpace on 127.0.0.1:7676 → approved Projects
                                  └→ local-only admin panel
```

DevSpace does not upload an entire repository in advance and is not a second
coding model. ChatGPT receives only content returned by the tools it calls.

DevSpace is designed for ChatGPT web. It does not provide compatibility modes
for other MCP hosts.

## Security boundary

Approve narrow project roots. Do not approve your home directory, filesystem
root, cloud-drive root, or a directory containing unrelated private data.

DevSpace validates Project selection, file paths, and command working
directories against the configured roots. File writes also preserve
`ifMatch`, `operationId`, and root-lock invariants.

This boundary is not operating-system isolation. `exec_command` starts a local
process with the authority of the OS user running DevSpace. That process may
read or modify anything that user can access and may use the network. DevSpace
does not provide a process sandbox, a command allow/deny policy, protected-path
enforcement for child processes, or per-command network controls. Run DevSpace
as a dedicated OS user, in a container, or in a VM if stronger isolation is
required.

## Quick start

The examples use the repository-local CLI. After an optional `npm link`, you
may replace `node dist/cli.js` with `devspace`.

### 1. Install

You need Node.js `>=22.19 <27`, npm, Git, and a way to expose an HTTPS endpoint,
such as
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --help
```

Use the same Node installation for install, build, and serving because
`better-sqlite3` is tied to the Node ABI.

### 2. Start an HTTPS tunnel

For a temporary test, keep this running in a second terminal:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

Copy the HTTPS origin it prints, for example
`https://random-name.trycloudflare.com`. Do not append `/mcp` when entering the
origin during initialization.

### 3. Initialize and serve

```bash
cd ~/tools/devspace
node dist/cli.js init
node dist/cli.js serve
```

The initializer asks for:

- narrow roots containing the Projects you want to approve;
- the local port, normally `7676`;
- the public HTTPS origin, without `/mcp`.

Save the Owner password shown by the initializer. It is required to approve a
ChatGPT OAuth connection and cannot be recovered from the stored verifier.

Default configuration and state locations are:

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/
```

### 4. Check readiness

```bash
curl http://127.0.0.1:7676/readyz
curl https://random-name.trycloudflare.com/readyz
node dist/cli.js doctor
```

Both readiness requests should return HTTP `200` while the service is ready.

### 5. Connect ChatGPT web

Enable Developer mode in ChatGPT and create a custom MCP app:

1. Use the public origin plus `/mcp`, for example
   `https://random-name.trycloudflare.com/mcp`.
2. Choose OAuth and review the requested capabilities.
3. Enter the Owner password and choose the Projects this connection may use.
4. Complete authorization, scan the tools, and select the app in a conversation.

The public OAuth scopes are:

- `project:read` for Project discovery, instructions, Skills, reads,
  inspection, and change review;
- `project:write` for patches;
- `process:execute` for local command and process interaction.

DevSpace has one hidden local Owner, but multiple OAuth grants may remain active
at the same time, including multiple grants for one OAuth client. Each bearer
resolves only its own grant, scopes, and approved Projects. A new authorization
does not replace grants belonging to other accounts or connections.

If a temporary tunnel URL changes, update the public origin and restart the
service:

```bash
node dist/cli.js config set publicBaseUrl https://new-random-name.trycloudflare.com
node dist/cli.js serve
```

Then update the ChatGPT app endpoint and authorize again. Use a stable hostname
for regular use. Tunnel only the DevSpace service port, never the local admin
or control listener.

ChatGPT may cache a tool snapshot. Rescan or rebuild the app after DevSpace
tool definitions change.

## Conversation workflow

Calls depend only on the OAuth bearer grant carried by that request. DevSpace neither reads nor
stores ChatGPT account, conversation, `openai/subject`, or `openai/session`
identity.

1. With one approved Project, call
   `project_control({"action":"open","operationId":"..."})` directly; do not call `list_projects`
   first.
2. With multiple Projects, call `list_projects`. The default full card groups
   Projects with actions to start fresh or continue a resumable Project task.
   A click sends the intent to the
   model, which calls `project_control`. Use `action=list` for private resumable
   Threads and `action=resume` with an explicit `threadRef`; no recency guess is made.
   when cards are disabled or limited to changes.
3. Keep the returned `executionRef` and pass it explicitly to every subsequent
   Project tool.
4. Read the compact root instruction delta; use `read_files` or `inspect` for
   target content and newly applicable nested instructions.
5. Lazily load one Skill when relevant, make a small patch, review it with
   `show_changes`, and run the smallest relevant check. For a long task or
   before moving to a new conversation, save one compact snapshot with
   `save_progress`.

`project_control(action=open, projectRef, operationId)` uses the approved
Project directory by default. For a Project whose root is the Git top level,
`checkoutKind:"worktree"` explicitly creates a managed per-Thread worktree.
An active worktree Thread owns one writable directory; dirty worktrees are not
removed by `action=close`. Non-Git Projects continue to use checkout mode, and
an identical retry never creates a second worktree.

An `executionRef` is not owned by a ChatGPT conversation. It remains usable
across transport reconnects and service restarts, and
`project_control({"action":"hydrate","executionRef":"..."})` explicitly resumes it. Only the original
grant can use it; another account or connection cannot cross that boundary even
if it learns the reference. Revoking or expiring the original grant, Project
deauthorization, or an unavailable Project path rejects the execution.
Grant revocation also terminates processes still tracked for that execution and
cleans up retained process output and review state. It does not delete Project
files or alter Git branches, commits, or worktrees.

`save_progress` persists an at-most-8-KiB model summary for the current private Thread, not the full
chat transcript. Its title/progress JSON must also fit 12,000 serialized bytes,
so escape-heavy text cannot make recovery exceed the context budget. Each
Omit `ifMatch` on the first save; updates require the current Thread `version`.
Use `project_control(action=list)` to discover Threads visible to the active
grant and `action=resume` with an explicit `threadRef`. Continuing creates a new
execution for that grant. Different grants do not see each other's Threads or
checkpoints by default, even when both approve the same Project. Server-observed
checkpoint fields are labeled accordingly; the model summary remains untrusted
and relevant files must be reread.

`show_changes` reads the current Git working-tree diff only when the Project
root is itself the repository top level, and it never writes the index, objects,
or refs. A Project nested inside a larger repository uses the non-Git path so
review cannot cross the approved root. Non-Git results are a bounded, durable
log of the exact successful `apply_patch` requests in that logical context;
command and external edits are excluded. Start a new logical context when that
journal reaches its limit—the shared directory is unchanged.

## Model-visible tools

The public vocabulary has exactly eleven tool names. Tools whose scopes were not
approved are unavailable:

```text
list_projects
project_control
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

`exec_command` appears only when both `project:write` and the explicit,
high-trust `process:execute` scope are granted. It follows the Codex-style
input shape:

```json
{
  "executionRef": "pex1_...",
  "operationId": "command-2026-07-30-001",
  "program": "npm",
  "args": ["test", "--", "--runInBand"],
  "workingDirectory": ".",
  "environment": {"CI": "1"},
  "yieldTimeMs": 10000,
  "maxOutputTokens": 12000,
  "tty": false
}
```

`workingDirectory` must resolve inside that execution's checkout or worktree.
Only use `shell:true` with `command` and `approvalReason` when shell syntax such
as pipes, redirection, or loops is actually required. The command still has the
full file and network authority of the DevSpace OS user. `write_stdin` only
sends input, closes, interrupts, or resizes an interactive process and is a
mutation requiring `operationId`. Use read-only `read_process_output` for both
live polling and retained, bounded output.

Mutating operations use `operationId` replay protection where defined by their
tool schema. File edits use version preconditions (`ifMatch`) to prevent stale
writes. Root locks coordinate concurrent writes and commands. Tool and process
output is bounded, and retained process state is cleaned up according to server
limits. When a tool returns a continuation cursor, pass the same `executionRef`
and the cursor, but omit the initial query and paging parameters.

## Administration

Run the loopback-only admin panel with:

```bash
node dist/cli.js admin
```

Useful commands include:

```bash
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js audit --limit 100
```

The Admin panel reports Project-execution diagnostics. `doctor` reads the same
SQLite state without mutating it and reports total, open, and terminal
execution counts. DevSpace does not manage Git worktrees.

`GET /healthz` is the liveness check. `GET /readyz` is the readiness check.
Keep credentials, `auth.json`, internal control tokens, and tunnel credentials
out of repositories and logs.

## Development

```bash
npm ci
npm run build
npm test
npm run typecheck
```

Use the repository scripts in `package.json` as the source of truth.

## More documentation

- [ChatGPT coding workflow](./docs/chatgpt-coding-workflow.md)
- [ChatGPT tool contract](./docs/chatgpt-tool-contract.md)
- [Configuration reference](./docs/configuration.md)
- [Security model](./docs/security.md)
- [Troubleshooting](./docs/gotchas.md)
- [Real ChatGPT host acceptance](./docs/chatgpt-host-acceptance.md)
