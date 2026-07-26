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

ChatGPT runs in the cloud and cannot directly open `/Users/alice/code/my-app` on your computer.
DevSpace runs a local MCP server that turns approved folders into file, search, patch, Git, and
command tools.

It does not upload the whole repository in advance, and it is not a hidden second coding model.
Only content returned by actual tool calls is sent to the MCP client, and those calls appear in
the conversation.

```text
ChatGPT → HTTPS tunnel → DevSpace 127.0.0.1:7676 → approved local projects
                              └→ local admin panel (localhost only)
```

## Recommended directories and working directories

Keep the program, projects, and persistent state separate:

```text
~/tools/devspace/                 # DevSpace installation
~/code/work/                      # work projects; approve separately
~/code/personal/                  # personal projects; approve separately
~/.devspace/                      # config.json, auth.json, managed worktrees
~/.local/share/devspace/          # SQLite, operations, process-output metadata
```

Important details:

1. `devspace init` uses the **current working directory** as the default allowed root. If you plan
   to press Enter, first run `cd ~/code/work`; explicitly entering the path is safer.
2. Do not approve `~`, `/`, an entire cloud drive, or a folder containing broad private data.
   Keep work and personal roots separate when possible.
3. Prefer installing DevSpace outside approved project roots. Open the DevSpace repository as a
   project only when you are developing DevSpace itself.
4. Once `allowedRoots` is explicit, the directory from which `devspace serve` starts no longer
   defines authorization. A service manager should still use an absolute CLI path and set its
   WorkingDirectory to the DevSpace installation.
5. Project commands start at the current Workspace root. `workingDirectory` may select only a
   subdirectory inside that Workspace; it cannot be used to escape the project.

## Quick start

### 1. Install

You need Node.js `>=22.19 <27`, npm, and Git. Use the same Node installation for dependency
installation, builds, and the long-running service because `better-sqlite3` is tied to the Node ABI.

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --help
```

Optional:

```bash
npm link
devspace --help
```

### 2. Initialize

```bash
node dist/cli.js init
```

The wizard asks for:

- approved project roots;
- the local port, normally `7676`;
- the public HTTPS origin, without `/mcp`.

Normal configuration and security credentials are stored separately:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

`auth.json` stores only an Argon2id verifier for the Owner password, an independent random master
key, and its derivation mode. It cannot recover the plaintext password, so save the password shown
once by the initialization wizard. Never share or commit `auth.json`; its master key derives local
identity, root, cursor, receipt, audit-reference, and internal-control keys.
Legacy upgrades use `legacy-direct` to keep existing identifiers stable. If the file migration
completed while SQLite still has the old verifier, the next startup proves the same secret against
both old scrypt and new Argon2id state, then upgrades in place without deleting OAuth tokens.

### 3. Start and check the server

```bash
node dist/cli.js serve
curl http://127.0.0.1:7676/readyz
```

A healthy server returns HTTP `200` and includes:

```json
{"ok":true,"name":"devspace","status":"ready"}
```

For installation or native dependency problems:

```bash
node dist/cli.js doctor
```

`doctor` also performs a bounded scan of approved roots and reports instruction files or lines over
8 KiB, effective chains near the 32 KiB hard limit, repeated templates, and root rules that appear
better scoped to a nested `AGENTS.md`.

### 4. Provide an HTTPS entry point

ChatGPT cannot connect directly to a local port. Use an HTTPS tunnel or reverse proxy. A temporary
example is:

```bash
cloudflared tunnel --url http://127.0.0.1:7676
node dist/cli.js config set publicBaseUrl https://random-name.trycloudflare.com
```

Use a stable hostname for regular use. Forward only the DevSpace service port; never expose the
local admin panel through the tunnel.

### 5. Connect ChatGPT

Enable Developer mode in ChatGPT and create a custom MCP app:

1. Set the endpoint to `https://devspace.example.com/mcp`.
2. Choose OAuth and scan the tools.
3. Enter the Owner password saved during initialization; it cannot be recovered from `auth.json`.
4. After password verification, create or reuse a local principal and select which approved roots
   this grant may access.
5. Finish the scan, create the app, and select it in a new conversation.

ChatGPT UI, plan availability, and write permissions can change. Follow the current
[OpenAI Developer mode and MCP apps guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
When DevSpace changes tool definitions, rescan or refresh the app in ChatGPT; restarting only the
local server does not refresh ChatGPT's cached tools.

`DEVSPACE_TOOL_PROFILE=browse` exposes a fixed nine-tool lifecycle/read/inspection surface. The
default `coding` profile additionally exposes Skill, mutation, process, worktree, operation, and
revocation tools when the OAuth grant has the matching scopes. A profile is fixed when the server
is created; reconnect or refresh tools after changing it rather than changing tools/list mid-chat.

## What happens during startup and shutdown

`devspace serve` starts in this order:

1. Validate Node against `package.json#engines.node`.
2. Ensure configuration exists. Environment variables override `config.json` and `auth.json`,
   which in turn override defaults.
3. Load `better-sqlite3` early so a Node ABI mismatch fails before the server starts.
4. Acquire a singleton lease for the local state directory so two backends cannot write the same
   state at once.
5. Open and migrate the canonical v16 database. A `pending` mutation left by an abnormal stop is
   recovered as `outcome_unknown`; DevSpace does not pretend that it never ran.
6. Initialize OAuth, Workspaces, processes, output, audit storage, and a unique process generation.
7. `/readyz` returns `200` only while the service is not closing and both the Workspace and OAuth
   databases are ready.

`/healthz` only means that the process is alive. Use `/readyz` for troubleshooting and service
management.

On `SIGINT` or `SIGTERM`, DevSpace stops accepting new work, drains HTTP requests, and then closes
process and database resources. A controlled macOS restart verifies that **both the PID and the
readiness generation changed** instead of trusting only the restart command's exit status.

## Workflow inside a conversation

For the first task in a project, say something concrete:

```text
Use DevSpace.
Open /Users/alice/code/my-app as alias my-app with write access.
Read the project instructions, fix the failing test, run the smallest relevant verification,
and summarize the changed files.
```

The actual workflow is:

1. `open_workspace` accepts only roots allowed by the current OAuth grant. Project selection may
   return metadata; immediate analysis or editing uses full context.
2. `get_workspace_context` loads the Workspace manifest and revisions without dumping every
   project instruction and Skill body into the conversation.
3. Before touching concrete files, `load_workspace_instructions(paths)` loads only the instruction
   chain that applies to those paths. Large files use signed, UTF-8-safe 8 KiB fragments, and only
   the final page returns the instruction token.
4. `read` returns content and a version. `apply_patch` requires `ifMatch`, preventing an external
   edit from being overwritten silently.
5. Every mutation uses a unique `operationId`. If a response is lost, check the operation state
   before trying the action again.
6. Prefer `program + args` for commands. Use `shell: true + command` only for pipes, redirection,
   and other shell syntax.
7. Long-running commands may continue in the background; output and operation state are persisted.

The default MCP HTTP transport is stateless. When a ChatGPT conversation ends or the service
restarts, the network transport, in-memory binding, and old receipt expire, but SQLite still keeps:

- aliases and `workspaceRef` values;
- checkout/worktree mode and write access;
- project fingerprints, generations, operation states, and process-output metadata.

After a new chat or restart, say:

```text
Use DevSpace. List the saved Workspaces, then resume alias my-app.
Do not reopen the local path and do not automatically choose the most recently used Workspace.
```

That means `list_workspaces → resume_workspace`. Resume issues a fresh context and receipt; an old
connection becoming invalid does not mean the project record was lost.

## Checkout or worktree

| Situation | Recommendation |
| --- | --- |
| Inspect the current directory | `checkout` + `read_only` |
| Intentionally edit the current directory | `checkout` + `read_write` |
| Parallel or experimental work | managed `worktree` |
| Two principals writing the same repository | one separate worktree per principal |

Give a continuing task a clear alias such as `billing-api-auth-fix`. A ChatGPT conversation branch
is not a Git branch; use a real worktree when file-level isolation matters.

## Permissions and security

An OAuth grant may include:

| Scope | Capability |
| --- | --- |
| `workspace:read` | open, read, search, inspect instructions and changes |
| `workspace:write` | edit files and advance review checkpoints |
| `process:execute` | start and control local processes |
| `network:access` | let a command inherit host networking |
| `worktree:create` | create managed worktrees |
| `workspace:revoke` | close or revoke Workspaces |

Each OAuth grant also binds specific approved roots. The global allowlist is not a shared pass for
every account.

> [!WARNING]
> `exec_command` still runs as the OS user that runs DevSpace. Command policy is an accident
> guardrail, not an operating-system sandbox.

The default runtime has no process sandbox and cannot reliably deny networking per process. Use a
dedicated OS account, container, or VM for high-risk projects. DevSpace blocks obvious self-kill
and self-restart commands; backend restart is available only through the local Admin control plane.

## Administration and long-running operation

```bash
node dist/cli.js admin
```

The admin panel listens only on localhost. It manages roots, quotas, Widgets, diagnostics, token
revocation, and controlled restart. Allowed roots can hot-reload; most other runtime settings
require a restart.

For continuous availability, keep both of these running:

```text
DevSpace server + HTTPS tunnel
```

Use launchd, systemd, or another service manager and a stable hostname. Controlled restart on
macOS requires the Admin process to know the same fixed launchd label:

```bash
DEVSPACE_LAUNCHD_SERVICE_LABEL=com.example.devspace node dist/cli.js admin
```

Useful checks:

```bash
curl http://127.0.0.1:7676/readyz
curl https://devspace.example.com/readyz
node dist/cli.js doctor
node dist/cli.js audit --limit 50
```

## Development and verification

```bash
npm ci
npm run typecheck
npm test
npm run test:browser
npm run build
npm run test:pack
```

`npm test` recursively discovers every `src/**/*.test.ts`; the repository currently has **59 test
files**. The runner prints the discovered count and fails if any discovered test does not complete,
so a new test cannot be silently omitted from a handwritten list.

Browser tests run separately. `test:pack` builds the npm package, installs it into a clean temporary
project, checks both README files, runs CLI/SQLite/server smoke tests, and audits production
dependencies.

## Troubleshooting

**Local `/readyz` fails:** inspect the DevSpace log, run `doctor`, and confirm that a second backend
is not using the same state directory.

**Local works but public access fails:** inspect the tunnel, DNS, and ingress. The public URL must
forward to the DevSpace service port.

**`better-sqlite3` cannot load:** installation and runtime probably use different Node ABIs. Switch
to the intended Node version and run:

```bash
npm rebuild better-sqlite3
node dist/cli.js doctor
```

**A new app cannot see an old Workspace:** verify that authorization reused the intended principal.
Use `devspace auth principals` and dry-run migration commands for historical orphan principals;
do not reopen paths at random and create duplicate Workspaces.

## Upgrade

Stop DevSpace and back up the entire state directory, normally `~/.local/share/devspace`, before
upgrading. Do not copy only the primary SQLite file because process output and other persistent
metadata are part of the state. Start the new version, let the canonical v16 migration complete,
check `/readyz`, and then refresh the ChatGPT app tools.

## More documentation

- [Configuration reference](./docs/configuration.md)
- [Security model](./docs/security.md)
- [ChatGPT coding workflow](./docs/chatgpt-coding-workflow.md)
- [Real-host acceptance matrix](./docs/chatgpt-host-acceptance.md)
- [Troubleshooting](./docs/gotchas.md)

DevSpace was created by [Waishnav](https://github.com/Waishnav). This fork preserves the original
history and [MIT license](./LICENSE).
