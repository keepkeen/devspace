# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- OAuth authorization grants bind local principals, capabilities, and epochs
- granular OAuth capabilities are checked again for every tool
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

Failed approval attempts are not tracked in one global in-memory counter.
DevSpace persists bounded token-bucket state for the exact authorization
session, dynamic client registration, source IP, and a global fallback. This
prevents one attacker from consuming every legitimate client's allowance and
keeps backoff consistent across process restarts. A successful approval clears
only that exact authorization-session key.

When proxy trust is enabled, forwarded IP information is accepted only from a
loopback direct peer. Do not expose the backend directly while also trusting
arbitrary forwarding headers.

## Authorization Grants, Principals, And Host Identity

OAuth `client_id` identifies a dynamic connector registration. It is not a
verified account identity and does not own Workspace state. Every successful
Owner approval creates an authorization grant with a fixed local principal,
granted scope set, and authorization epoch. Authorization codes, access tokens,
and refresh tokens reference that grant directly. Refresh rotation preserves
the original grant and never derives a principal from `clientId`.

A fresh grant and principal are isolated by default. To deliberately reconnect
a new grant to an earlier principal, generate a one-time code locally:

```bash
devspace auth principals
devspace auth reconnect-code <principal-id>
```

Treat this code as a short-lived credential. It is stored hashed, expires, is
consumed once, and must not be sent through ChatGPT or repository content.
Tokens issued before a successful relink are revoked.

Tool calls may carry `openai/subject`, `openai/organization`, and
`openai/session`. DevSpace stores only purpose-separated HMAC values under a
server identity key. Subject and organization provide grant consistency,
anonymous audit/rate-limit dimensions, and protection against using one token
under another host subject. They are not credentials and never replace the OAuth
bearer token. Raw values are not persisted.

For ChatGPT-style hosts, the session HMAC participates in a bounded server-side
binding from the authorized principal/grant to one Workspace context. Generic
MCP clients use an explicit `wctx5` receipt. An explicitly invalid receipt is
never allowed to fall back to session state. Server restart clears these
in-process bindings while retained aliases remain resumable.

DevSpace still receives no trusted human account or conversation identity.
Aliases are the durable local continuity key. New conversations and restarted
servers must list and resume retained Workspaces rather than reopen remembered
paths. Missing managed worktrees remain recoverable records; physically lost
uncommitted files cannot be guaranteed.

## OAuth Capabilities

Version 2.0 uses only these explicit scopes:

- `workspace:read`
- `workspace:write`
- `process:execute`
- `network:access`
- `worktree:create`
- `workspace:revoke`

If an authorization request omits `scope`, only `workspace:read` is granted.
Elevated capabilities must be explicit. tools/list is filtered by the grant, and
tool handlers enforce the actual combination immediately before execution,
including conditional checks for writable checkouts, worktree creation, network
inheritance, and mutating process input. A cached schema cannot turn a read token
into process, write, or revoke authority.

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Local Admin Panel

The management panel runs as a separate `devspace admin` process bound to
`127.0.0.1` on its own port. Never proxy that port through Cloudflare or another
tunnel. Each launch uses a one-time URL-fragment capability, an HttpOnly local
session cookie, strict Host/Origin checks, and CSRF protection. The panel does
not expose OAuth owner tokens or tunnel credentials. Both the Admin UI and OAuth
approval page deny iframe embedding with CSP `frame-ancestors 'none'` and
`X-Frame-Options: DENY`.

Runtime restart is available only for an explicitly enrolled user-level
launchd service. It requires the authenticated local session, CSRF, a short-lived
one-time confirmation token, and a fixed service label. DevSpace calls
`/bin/launchctl` directly with fixed arguments; it does not invoke a shell,
accept executable paths, or control root/system services. Restart completion is
verified using the enrolled launchd process PID plus a fresh backend readiness
generation before the UI reports success.
Tunnel management remains status-only, and public diagnostics issue only a
credential-free `/readyz` request without following redirects.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

For that reason, new checkout workspaces are read-only by default and do not
permit shell execution. Use a managed worktree for writable model work. Direct
writes to the user's current checkout require an explicit
`writeAccess: "read_write"`; this is an authority choice, not a claim that the
shell has been sandboxed.

Direct `program` + `args` execution removes shell expansion and quoting
ambiguity, but it is not an OS sandbox. Runtime capabilities explicitly report
that the default implementation has no process sandbox, no per-process network
isolation, and only guardrail-level filesystem confinement. Unsupported
`network: "deny"` is removed from the tool schema rather than presented as a
control that always fails. Workspace generations and file versions do not
replace OS isolation.

Spawned commands do not inherit the server's complete environment. DevSpace
passes only basic executable-path, home/user, temporary-directory, locale, and
platform variables, then adds its Workspace markers and any variables supplied
explicitly in the tool call. OAuth secrets, CI tokens, proxy credentials,
`NODE_OPTIONS`, SSH-agent sockets, and unrelated service credentials are not
forwarded implicitly. Explicit environment values are still capabilities and
should be provided only when the command actually needs them.

Repository files, repository instructions, and Skill content are untrusted
workspace-scoped data. They may guide work inside their scope, but their text
cannot grant OAuth capability, alter the filesystem allowlist, disclose
secrets, bypass file preconditions, or authorize operations outside the Workspace.
Structured tool results are the source of truth for execution and retry state.
Do not retry a mutation unless `safeToRetry` is explicitly true.

## Concurrent Workspace Access

Workspace operations first use a fair process-local read/write queue keyed by
the canonical physical root. Write operations additionally acquire a
cross-process lock under a per-user lock directory, using hashed root keys so
absolute paths are not disclosed. Reader markers, writer intent, and writer
markers prevent writer starvation. Stale markers are reclaimed only after PID
liveness checks, and lock timeouts return `workspace_root_busy` before effects.

Reads and default change previews may overlap. Patches, commands, mutating
process input, checkpoint advancement, close, and revoke serialize even when
different principals or DevSpace state directories point at the same checkout.

If `exec_command` returns a running background or interactive process, the
write lease transfers to that process session and remains held until the entire
process tree exits, is terminated, the Workspace closes or revokes, or the
server shuts down. Polling and stdin tools operate on the existing lease rather
than deadlocking by reacquiring it.

This coordination covers DevSpace instances, not arbitrary external editors.
Every patch therefore still requires strict `ifMatch` versions. Use separate
managed worktrees, a dedicated OS account, container, or VM when stronger
isolation is required.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, DevSpace logs requests and tool calls. Principal, client, grant,
subject, organization, and session dimensions use opaque or HMAC-derived
identifiers; raw host identity claims and bearer tokens are not logged. Shell
command previews are disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.
