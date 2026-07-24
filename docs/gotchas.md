# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

Commands below assume this fork was cloned, built with `npm run build`, and the
current directory is the repository root. After `npm link`, `devspace` can be
used instead of `node dist/cli.js`.

## `devspace` Command Not Found

Use `npx`:

```bash
node dist/cli.js init
node dist/cli.js serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

DevSpace requires Node `>=22.19 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
node dist/cli.js doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
node dist/cli.js config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

For a one-off run:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" node dist/cli.js serve
```

For a stable URL:

```bash
node dist/cli.js config set publicBaseUrl https://devspace.example.com
```

## Host Header Or 403 Problems

DevSpace derives allowed hosts from the configured public URL.

Run:

```bash
node dist/cli.js doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

Use this only for intentional local debugging:

```bash
DEVSPACE_ALLOWED_HOSTS="*" node dist/cli.js serve
```

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, configure:

```bash
DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS="chatgpt.com,example.com" node dist/cli.js serve
```

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.devspace/auth.json
```

To regenerate setup:

```bash
node dist/cli.js init --force
```

Changing the Owner password revokes issued access and refresh tokens but keeps
registered OAuth clients, so an existing ChatGPT connector can reauthorize.

## `invalid_client` While Reconnecting ChatGPT

This error occurs before Owner-password validation. It means ChatGPT cached an
OAuth `client_id` that is no longer registered, usually after the Admin panel's
**revoke all clients and tokens** action or after replacing the state database.

Close the authorization page, remove the current DevSpace connection or app in
ChatGPT, and add it again. Clicking **Connect** alone may reuse the stale client
ID. DevSpace then accepts a fresh dynamic client registration and shows the
normal Owner-password approval page. The registration stays unassigned until a
successful approval, which creates a new local connection principal by default.

To deliberately recover aliases owned by the earlier principal, run locally:

```bash
devspace auth principals
devspace auth reconnect-code <principal-id>
```

Enter that code once on the new approval page. Do not paste it into ChatGPT.
Without this explicit link, reopening the project creates isolated connection
state.

## Unknown `workspaceId`

`workspaceId` values are scoped to the local connection principal that opened
them. Normal MCP transport reconnects do not invalidate them. Refreshing or
reauthorizing the same registered client with the same principal and authority
does not advance its Workspace generation. Principal relink/revoke,
Owner/root-authority changes, lifecycle transitions, and backend restart still
invalidate affected receipts. A new dynamic registration remains unassigned;
its first successful approval creates another principal that cannot see former
aliases unless the owner explicitly uses a reconnect code. Before opening the
project again, always call `list_workspaces`;
creating a replacement worktree can strand the original task.

In a new conversation on the same OAuth connection, call `list_workspaces` and
then `resume_workspace` with exactly one returned alias or `workspaceRef` and
`contextMode="full"`; the host path does not need to be repeated. The opaque
`projectFingerprint` helps distinguish same-named projects. After a backend restart or resident-cache eviction, directly
using an old ID returns `workspace_resume_required`. Resume by alias before any
file or process operation, or use the listed workspaceRef when alias retention
is uncertain. The response returns the same durable ID with a
newer `workspaceGeneration` only after instructions, Skills, profiles, and
review checkpoints are hydrated.

Every later Workspace tool must include that generation. If policy, credential
epoch, or lifecycle state changes, `stale_workspace_generation` instructs the
client to list/resume rather than guessing whether an old handle is safe.

## Managed Worktree Is Missing Or Platform Closed The Session

The MCP transport, receipt, and browser conversation connection are not the
Workspace. A platform-side session closure should be handled by opening a new
transport, calling `list_workspaces`, and resuming the alias selected by that
conversation. The same connection principal may have several project aliases;
do not pick another project's alias merely because both are visible.

If the managed worktree directory cannot be found, DevSpace keeps the Workspace
active and lists it as `recovery_required`. `resume_workspace` attempts to
recreate the original path under the same Workspace ID. It first uses Git's
registered worktree HEAD, which preserves committed work even when the folder
was removed, then falls back to the saved base commit. The recovery result marks
`dataLossPossible=true`: uncommitted files that disappeared with the directory
cannot be reconstructed from Git.

When `open_workspace(mode="worktree")` finds exactly one active worktree for the
same source repository, it reuses it even if the source branch has moved. When
several exist, `workspace_selection_required` returns their aliases. Resume the
correct alias or explicitly use `forceNew=true`; do not enter a loop of creating
new branches to replace an inaccessible one.

`open_workspace` is for the first use of a host path. Its default metadata mode
returns a visible Workspace reference but only a metadata-phase receipt; call
`get_workspace_context` with that receipt and `contextMode="full"` before work.
Every later scoped result echoes `workspace` and `continuation`, but ordinary
tools do not renew the receipt's fixed expiry. Revision hints
are only a cache optimization in explicit `retained` mode and do not prove that
a new model conversation remembers the bodies.

ChatGPT OAuth clients use stateless MCP POST requests, so an old transport
session header does not invalidate or consume the workspace. Non-ChatGPT MCP
hosts remain stateful; an unknown transport session returns a dedicated 404 and
the server records a redacted `unknown_mcp_session` diagnostic.

For log correlation, `oauthClientRef` identifies the dynamic OAuth
registration, while `connectionRef` identifies the local principal. Neither is
a verified ChatGPT account. `workspaceActivityRef` identifies the principal
plus Workspace handle, which separates work against different projects.
ChatGPT does not currently provide DevSpace a documented thread/conversation
ID, so two conversations using the same principal and reused Workspace cannot
be labeled as separate threads without an explicit client handshake.

## `insufficient_scope`

The access token authenticated successfully but lacks a capability required by
that tool. Reauthorize with the indicated scope rather than retrying the tool.
Common combinations are:

- writable checkout: `workspace:read workspace:write`
- managed worktree: add `worktree:create`
- command execution: add `process:execute network:access`
- close/revoke: add `workspace:revoke`

The legacy `devspace` scope grants all capabilities for backward compatibility.

## Workspace Path Rejected

The path must be inside one of the allowed roots configured during setup.

Run:

```bash
node dist/cli.js config get
```

Then either open a project under an allowed root or rerun setup:

```bash
node dist/cli.js init --force
```

## User Instructions Are Missing Or Unexpected

DevSpace does not automatically read `~/.codex/AGENTS.md`. That file often
contains Codex-specific operating policy which is unnecessary context for a
ChatGPT web connector. To opt in to one user-level file, set it in the local
Admin panel or configure:

```bash
DEVSPACE_USER_INSTRUCTIONS_PATH=~/.devspace/AGENTS.md node dist/cli.js serve
```

The path must be a readable file. A missing path, directory, or unreadable file
causes `open_workspace` to fail instead of silently dropping policy. The user
file and applicable project instructions share the 32 KiB budget. Saved path
changes require a backend restart; an environment override locks the Admin
field until the startup environment is changed.

## Worktree Mode Fails

Worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `baseRef` resolves to a commit

For a new repository, create the first commit or use checkout mode.

Uncommitted source checkout changes are not copied into the managed worktree.
Commit, stash, or ask the model to work in checkout mode if those changes are
needed.

## Windows Shell Commands Fail

DevSpace shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
node dist/cli.js doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Check:

```bash
DEVSPACE_SKILLS=1 node dist/cli.js serve
```

DevSpace checks these standard Agent Skills layers:

- project `.agents/skills` directories from the approved repository boundary to workspace
- `~/.agents/skills`
- `DEVSPACE_ADMIN_SKILLS_DIR` (default `/etc/codex/skills`)
- Skills bundled with DevSpace

It also checks compatibility and custom paths:

- `~/.devspace/skills`
- `DEVSPACE_AGENT_DIR/skills`, defaulting to `~/.codex/skills`
- additional paths from `DEVSPACE_SKILL_PATHS`

When `DEVSPACE_SUBAGENTS=1`, DevSpace loads agent profiles from
`~/.devspace/agents/*.md` and project `.devspace/agents/*.md`, then exposes a
compact profile catalog through `open_workspace`. The bundled
`subagent-delegation` skill keeps the model-facing workflow to
`devspace agents ls`, `devspace agents run`, and `devspace agents show`.
`devspace agents ls` lists existing subagent sessions, not profile
definitions.

Packaged agent profile examples under `examples/agents/` are starter templates.
Copy or adapt them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added through `DEVSPACE_SKILL_PATHS` when needed.

If a Skill appears in `open_workspace`, ChatGPT web should call `load_skill`
with its `skillId` before reading other files inside the Skill directory.
Duplicate names require the ID. Skills marked
`explicitOnly=true` remain available only for explicit user
requests. Check `DEVSPACE_DISABLED_SKILL_PATHS` when an expected Skill is
missing; the catalog also reports entries omitted by its 8,000-byte UTF-8
budget.

## Review Card Does Not Appear

Per-tool widget cards are enabled by default with:

```bash
DEVSPACE_WIDGETS=full
```

The aggregate `show_changes` tool is only exposed with
`DEVSPACE_WIDGETS=changes`. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results.

The default `show_changes` call is a read-only preview and does not advance the
review checkpoint. Repeat it freely with the current receipt. Set
`advanceCheckpoint: true` only to acknowledge the displayed delta; that form
requires `workspace:write` and an `operationId`.

## A Batch Tool Shows Only a Summary

`batch_read` and `batch_inspect` intentionally keep their independent payloads
in `structuredContent.items[]`. Text `content` contains only a short completion
summary. Give inputs short `ref` values when order alone is fragile; results
echo refs and report top-level `completed`, `partial`, or `failed` plus counts.
Successful `batch_read` items contain workspace-relative path, content,
contentHash, mtimeNs, offset, and optional paging/truncation metadata; failures
contain `error`. `batch_inspect` items retain the compact `result` form. Absolute
host paths/operations and the former aggregate result are not emitted.
Update clients or adapters that only display text content, or use single-item
tools when structured results are unavailable.

Other heavy results also have one canonical model-visible location: single
file and process bodies are in text `content`, while Skill bodies are in
structured `skill.content` with source/trust metadata and only actionable
process handles and paging fields remain structured. Do not fall back to
`_meta.card.payload.content`; `_meta` is optional widget presentation and may be
absent. For durable output, display the page from `read_process_output` text
`content` and continue with structured `nextOffset` until `eof` is true.
