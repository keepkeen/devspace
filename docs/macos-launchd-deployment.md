# One-shot macOS launchd deployment

DevSpace includes a repository-owned deployment worker for replacing a built
`dist` directory while the backend is managed by a user LaunchAgent. It does
not use `launchctl submit`. The generated helper is an explicit LaunchAgent
with `RunAtLoad=true` and `KeepAlive=false`, and every terminal path attempts
to `bootout` that exact helper label.

The worker accepts an already built, same-filesystem staging directory. It
does not build, restart, or deploy merely by importing the module. To enqueue
one deployment from the checkout root:

```bash
node scripts/macos-launchd-deploy.mjs install \
  --project-root "$PWD" \
  --staged-dist "$PWD/.build-stage/dist" \
  --service-label com.example.devspace \
  --service-plist "$HOME/Library/LaunchAgents/com.example.devspace.plist" \
  --control-readiness-url http://127.0.0.1:7677/internal/readiness
```

Before touching the main job, the helper validates both staged entrypoints,
the main plist and its label, the loaded launchd PID, and authenticated,
PID-correlated `/internal/readiness` state. By default the installer derives
the internal token through the currently installed `dist`; an orchestrator may
instead supply it through `DEVSPACE_DEPLOYMENT_INTERNAL_TOKEN` or a mode-0600
`DEVSPACE_DEPLOYMENT_INTERNAL_TOKEN_FILE`. The token is stored only in the
mode-0600 plan and is never printed or logged. The worker then stops the job, atomically renames `dist`, bootstraps
the original main plist, and requires a new launchd PID and readiness
generation. The former dist is removed only after that verification succeeds.

Safety properties:

- A single exclusive lock rejects concurrent work; stale locks are reclaimed
  only after their recorded PID is no longer alive. A terminal receipt rejects
  reuse of the same operation.
- Preflight and unsuccessful-stop failures never start or restart the main job.
- Recovery bootstraps the main job only if this operation successfully stopped
  it.
- Every attempted dist swap enters idempotent rollback. The rollback recognizes
  unchanged, partially swapped, fully swapped, and already-restored layouts.
- Every stage boundary is appended and fsynced under
  `.build-stage/deployments/`. If the helper or machine stops after service
  shutdown or between the two renames, the same plan reconciles the old dist,
  restores PID-correlated readiness, and then safely resumes. Re-running the
  install command selects that unfinished plan instead of creating a new one;
  login also reloads its still-present LaunchAgent.
- The success receipt is made durable before the old dist is removed. The
  operation plan and helper plist are deleted only after recovery, receipt,
  backup cleanup, and lock release all complete.

The mechanism supports only a macOS GUI user domain and an authenticated
loopback `/internal/readiness` URL. It never invokes a shell and does not search for or kill
processes.
