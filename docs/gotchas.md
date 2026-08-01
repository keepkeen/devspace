# Troubleshooting Gotchas

This guide covers the supported ChatGPT-web-only DevSpace architecture.

## `devspace` command not found

The repository-local command is always:

```bash
node dist/cli.js --help
```

The shorter `devspace` command requires:

```bash
npm link
```

Run both from the DevSpace source checkout.

## Unsupported Node version

DevSpace requires Node.js `>=22.19 <27`. Check:

```bash
node --version
npm --version
```

Use the same Node installation for `npm ci`, `npm run build`, and the running
service.

## `better-sqlite3` could not load

This usually means dependencies were installed under a different Node ABI.

```bash
npm ci
npm run build
node dist/cli.js doctor
```

If a service manager starts DevSpace, verify that it uses the same absolute
Node binary as the successful build.

## Public URL includes `/mcp`

Store only the public origin:

```text
https://devspace.example.com
```

Use the origin plus `/mcp` only as the ChatGPT app endpoint:

```text
https://devspace.example.com/mcp
```

Fix an incorrect value with:

```bash
node dist/cli.js config set publicBaseUrl https://devspace.example.com
```

Then restart DevSpace and update the ChatGPT app.

## Tunnel URL changed

Random quick-tunnel hostnames are temporary. After a change:

1. update `publicBaseUrl`;
2. restart DevSpace;
3. confirm local and public `/readyz`;
4. update the ChatGPT app endpoint;
5. approve a new OAuth grant.

A stable hostname avoids repeating this procedure.

## Host header or HTTP 403 problems

Verify:

- `DEVSPACE_PUBLIC_BASE_URL` matches the browser-visible HTTPS origin;
- the reverse proxy preserves an expected `Host` header;
- `DEVSPACE_ALLOWED_HOSTS`, if set, includes the actual host;
- only the public service port is tunneled.

Do not proxy the loopback admin/control port.

## OAuth redirect host rejected

The redirect URI must use an allowed host. Configure
`DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` only for hosts you trust. Do not add a
broad wildcard to make an unknown redirect pass.

## Owner password not accepted

The stored verifier cannot recover the plaintext Owner password. Check for:

- transcription errors;
- a different `DEVSPACE_CONFIG_DIR`;
- an environment override in `DEVSPACE_OAUTH_OWNER_TOKEN`;
- a service manager using different environment settings.

Do not paste the Owner password into ChatGPT or a repository file.

## A previous OAuth connection stopped working

Approving connection B does not replace connection A. DevSpace supports
multiple concurrently active grants, including several grants for the same
OAuth client.

If A stopped working, check whether A's exact grant was revoked or expired,
refresh-token replay invalidated it, its authorization epoch changed, or its
approved Project was removed. Reauthorize A without revoking B. If separate
people or trust domains require OS-level isolation, run separate DevSpace
instances under separate OS users because grants do not sandbox shared local
files or commands.

## `project_selection_required`

More than one Project is approved, so `use_project` cannot use a default.
Call `list_projects`, let the user choose, then retry creation with its returned
`projectRef` and the intended `operationId`.

With exactly one approved Project, call `use_project` directly with
`operationId`; listing first is unnecessary.

## `project_execution_required` or `project_execution_not_found`

Every Project-scoped tool requires the opaque `executionRef` returned by
`use_project`. DevSpace never infers it from a ChatGPT account, conversation,
transport, or most-recent selection.

If the reference is missing, pass the known value. If it is invalid, closed, or
belongs to a replaced grant, create a new execution. Do not send an absolute
path or guess/edit the opaque reference.

## `project_execution_recovery_required`

The approved shared Project path cannot be recovered or no longer matches the
persisted Project identity. Restore the directory or approve the intended
Project again, then resume. Create another logical context with a new
`operationId` only when that is the intended action. DevSpace does not repair or
change Git state.

## `insufficient_scope`

The active OAuth grant lacks the capability required by the tool. The public
scopes are:

- `project:read` for selection, instructions, Skills, reads, inspection, and
  change review;
- `project:write` for patches;
- `process:execute` for commands and process interaction.

Approve a new grant with the required capabilities. Other active grants remain
valid.

## Added root or Project is still missing

`DEVSPACE_ALLOWED_ROOTS` is the service-wide ceiling. OAuth approval separately
selects Projects within that ceiling.

After adding a root:

1. verify the root in the local admin panel or `config get`;
2. call `list_projects`;
3. if the Project is not authorized, approve a new grant and select it;
4. call `use_project` directly for one Project, or `list_projects → use_project`
   when several are approved.

Never approve a broad parent directory merely to make discovery easier.

## Project path rejected

File paths and command `workdir` values must resolve inside the referenced
Project.
Common causes are:

- an absolute path instead of a Project-relative path;
- `..` traversal outside the checkout;
- a symlink whose canonical target is outside the approved root;
- a `workdir` that names a file or missing directory;
- the root was removed after the Project was selected.

Use a path relative to the selected Project. Do not weaken the approved-root
configuration to accommodate an unrelated path.

## Instructions are missing or unexpected

`use_project` returns a compact bounded root instruction delta. `read_files`
and `inspect` return a newly applicable nested `instructionsDelta` with the
target result. A mutation or command may instead return
`instructions_required` and start no effect; review that delta before retrying.

Check:

- the instruction file is inside the approved checkout;
- the filename and nesting match the repository convention;
- `AGENTS.override.md` or `AGENTS.md` is used by default;
- `CLAUDE.md` is listed in `projectDocFallbackFilenames` or
  `DEVSPACE_PROJECT_DOC_FALLBACK_FILENAMES` if that explicit fallback is
  intended;
- the file fits the configured instruction limits;
- `DEVSPACE_USER_INSTRUCTIONS_PATH`, if set, points to the intended file;
- the call uses the intended `executionRef`.

## Skills do not appear

Check:

- the Skill has a readable `SKILL.md`;
- required manifest fields are present;
- the directory is in a discovered or explicitly configured Skill root;
- it is not listed in `DEVSPACE_DISABLED_SKILL_PATHS`.

Use `skills` with `action=search` for explicit discovery. Then use the same tool
with `action=load` and a returned `skillId` before following the selected
instructions. Skill bodies are intentionally lazy.

## `ifMatch` or file-version conflict

The file changed after ChatGPT read it. This is a safety check, not a transient
write failure.

Recovery:

1. read the current file;
2. reconcile the intended edit with the new content;
3. create a new patch using the current version;
4. review with `show_changes`.

Do not remove the precondition or blindly overwrite the newer file.

## A retry reports an operation conflict

Effectful calls use operation replay protection. Reusing an operation identifier
with a different request body is rejected.

- Retry an identical lost-response request with the same identifier.
- Use a new identifier for a logically new effect.
- If the server reports an uncertain outcome, inspect files or process output
  before deciding what to do next.

## Project root is busy

Another DevSpace write or tracked command holds the root lock. An interactive or
background command may keep the lease until its process tree exits or is cleaned
up.

Wait or finish the owning process. Do not bypass the lock by running a second
DevSpace instance against the same checkout. External editors are not covered
by this lock, so file-version checks still matter.

## A command can access paths outside the Project

That is the documented security boundary. DevSpace validates the declared
`workdir`, but it does not sandbox the child process. The command has the
authority of the OS user running DevSpace and can use absolute paths and the
network.

Use a dedicated low-privilege OS user, container, or VM when stronger isolation
is required. Treat `process:execute` as high-trust access.

## Windows shell command fails

`exec_command.cmd` is interpreted by the platform runtime. Shell syntax and
program names differ across operating systems. Use commands valid for the OS
running DevSpace and set `workdir` separately.

Do not assume a Unix shell is present on Windows.

## Command output is truncated

`max_output_tokens` bounds the output returned by `exec_command`. A long-running
command may return a process handle instead of waiting for completion.

Use:

- `read_process_output` with `sessionId` to poll a live process;
- `write_stdin` with a fresh `operationId` only when input, close, interrupt,
  or terminal resize is needed;
- `read_process_output` with `outputId` for the first retained-output read;
- a narrower test or log filter when output is too large.

Retained output is size- and time-limited. It is not permanent storage.

## `write_stdin` cannot find the process

The process may have exited, expired, been cleaned up, or belong to an inactive
authorization or Project context. Inspect the original `exec_command` result and
try `read_process_output` if retained output is still available.

Do not guess process identifiers from another execution. An empty
`write_stdin` call is not a poll; it is rejected because the tool is
mutation-only.

## A continuation cursor is rejected

Signed cursors are self-contained and bound to the active grant, Project
generation, resource revision, query, and paging parameters. On continuation,
pass the same `executionRef` and cursor. Do not repeat or change the original
`outputId`, mode, query, offset, or limit beside it.

If the resource or Project changed, restart the read without the stale cursor.

## `show_changes` is empty

Confirm:

- `executionRef` identifies the logical context you intended;
- the edit succeeded rather than failing an `ifMatch` check;
- the execution is still active under the current grant.

When the Project root is the Git top level, also confirm that the change is
visible to the current repository diff. A Project nested inside a larger Git
repository intentionally uses the non-Git source. That source includes only the
exact successful DevSpace `apply_patch` requests recorded under that execution;
it excludes command writes, external edits, and patches from other executions,
even though those files are visible in the shared directory. It is a bounded
chronological operation log, not a net filesystem diff. If it is full, create a
new logical context for the same Project.

`show_changes` is read-only and bounded. A very large result may return a
summary; narrow inspection to the reported files.

## `read_files` or `inspect` returns a summary

`read_files` and `inspect` bound both input and output. Large requests may omit
bodies or return a summary.

Split the request into smaller, known file sets. Avoid repeatedly scanning the
whole repository.

## Safe backend restart

Before restarting:

1. note any running command;
2. stop or finish interactive work when practical;
3. restart only the DevSpace service;
4. confirm local and public `/readyz`;
5. reuse the existing `executionRef`, or call
   `use_project({"executionRef":"..."})` to explicitly resume it.

Restarting may clean up running or retained process state, but persisted
executions are revalidated when their references are used again. DevSpace
termination covers only process groups it started and still tracks, on a
best-effort basis; detached or untracked descendants may survive. Restart does
not delete Project files or change Git state.

## Different executions see the same files

That is deliberate. Executions isolate opaque references, authorization,
instruction state, idempotency, processes, and non-Git patch journals; they do
not isolate the filesystem. All executions bound to the same approved Project
use that existing directory.

Ask the model to use ordinary Git branches or worktrees when isolation is
needed. DevSpace itself never creates, removes, resets, or prunes them.

See [ChatGPT Tool Contract](./chatgpt-tool-contract.md) for the canonical
surface and recovery behavior.
