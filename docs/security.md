# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- local connection principals own Workspace and process state
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

## Connection Principals And Account Identity

OAuth `client_id` identifies a dynamic connector registration. It is not a
verified ChatGPT account identity. Registration alone remains unassigned; after
the Owner approves it successfully, DevSpace creates or explicitly reconnects a
local connection principal and stores Workspace, process, output, and operation
ownership under that principal.

Newly approved registrations remain isolated by default. DevSpace does not
claim that two principals are two different human accounts, nor that two
registrations belong to the same account. A new registration joins an earlier principal only when
the owner locally generates a one-time reconnect code:

```bash
devspace auth principals
devspace auth reconnect-code <principal-id>
```

Treat the reconnect code like a short-lived credential. Enter it only on the
local DevSpace OAuth approval page. Do not send it through ChatGPT, commit it,
or paste it into repository instructions. The code is stored hashed, expires,
is consumed once, and cannot relink a source principal that already owns
retained Workspace state. Tokens issued before a successful relink are revoked.

If a future trusted identity provider supplies an authenticated issuer and
subject, that claim can be bound to the same local principal model. No such
ChatGPT account claim is assumed today.

DevSpace also receives no trusted ChatGPT conversation ID. Conversations under
one principal can see the same alias catalog, so the selected Workspace alias
is the local continuity key. The model should resume that alias after reconnects
or later turns instead of creating a replacement worktree. A missing managed
worktree path is retained as recoverable state; rebuilding it can restore
committed Git state but cannot guarantee recovery of physically lost,
uncommitted files.

## OAuth Capabilities

The legacy `devspace` scope grants the complete historical authority. Granular
deployments may instead use:

- `workspace:read`
- `workspace:write`
- `process:execute`
- `network:access`
- `worktree:create`
- `workspace:revoke`

The approval page explains requested capabilities. Tool handlers enforce their
actual combination immediately before execution, including conditional checks
for writable checkouts, worktree creation, and mutating process input. A token
that can read a Workspace cannot silently start a process or revoke it.

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
ambiguity, but it is not an OS sandbox. `network: "deny"` fails closed unless a
future runtime can enforce it. Workspace generations reject stale handles, and
file `contentHash` preconditions reduce accidental concurrent overwrites; they
do not replace OS isolation or coordination between users.

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

Within one DevSpace server, Workspace-scoped calls use a fair read/write lock
keyed by the canonical physical root rather than only by Workspace ID. Reads and
inspection can proceed together. Patches, commands, mutating `write_stdin`,
review-checkpoint updates, close, and revoke are serialized even when different
principals opened the same checkout.

The write lease covers each MCP command or process-input call, not the entire
lifetime of a returned background or interactive process. This avoids a dev
server or shell locking the Workspace indefinitely. Later subprocess effects
remain explicitly unknown, strict `ifMatch` protects file patches, and close or
revoke stops tracked processes. Another independently configured DevSpace
instance is outside the same in-process lock. Use separate managed worktrees, a
dedicated OS account, or a container when stronger isolation is required.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.
