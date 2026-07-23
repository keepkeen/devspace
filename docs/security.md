# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
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

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.
