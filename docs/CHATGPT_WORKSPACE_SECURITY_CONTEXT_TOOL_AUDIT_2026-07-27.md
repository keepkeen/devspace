# Historical ChatGPT Security and Tool Audit — 2026-07-27

> **Status: superseded.** This file is a historical record of the audit that
> motivated the ChatGPT-only contract. It is not normative product
> documentation and must not be used to infer current tool names, OAuth
> behavior, recovery steps, or worktree lifecycle. The canonical contract is
> [ChatGPT Tool Contract](./chatgpt-tool-contract.md).

## Historical purpose

The 2026-07-27 audit examined the then-current account, authorization,
Project/Workspace context, instructions, Skills, mutation, command, process,
restart, and deployment behavior. It found that the implementation had useful
low-level safeguards, but its public contract exposed too much lifecycle state
and still carried generic-host and managed-worktree assumptions.

The original report also recorded machine-specific runtime observations,
temporary grant counts, exact receipt expiries, deployment status, and a
pre-consolidation public tool vocabulary. Those details were point-in-time
evidence, not durable product promises, and have been removed from this current
branch to prevent them from being mistaken for supported behavior.

## Durable findings from the audit

The following conclusions remain relevant:

- Project files, repository instructions and Skills, command output, and model
  text are untrusted content. User/admin/bundled/DevSpace/explicit Skills retain
  explicit trusted provenance, but no content can expand authorization.
- Local path containment protects file-tool arguments and the declared command
  working directory; it does not sandbox a launched process.
- File mutations need complete version preconditions and replay-safe operation
  identifiers.
- OAuth grant identity is sufficient; account and conversation hints should not
  become a second identity system.
- Project selection must be explicit and never guessed from recency; execution
  identity remains server-held behind an exact trusted session+Actor binding.
- Tool output, instruction context, diff data, and process output must remain
  bounded.
- A backend restart cannot preserve live process state, while a durable Project
  execution may be recovered by hydrating its stable trusted session binding.

## Resolution in the ChatGPT-only contract

| Audit concern | Current resolution |
| --- | --- |
| Ambiguous multi-account/principal behavior | One hidden local Owner with multiple concurrent OAuth grants. Each bearer is isolated by client, grant, authorization epoch, scopes, and approved Projects; anonymous host IDs are stored only as HMAC-derived references for private Actor/session continuity. |
| Host metadata treated as optional compatibility hints | Trusted Actor/session references key private Thread UX and implicit execution selection, while every authorization decision still revalidates the active OAuth bearer grant and approved Project. Missing session metadata fails closed for model Project tools. |
| Transport recovery conflated with conversation recovery | A durable server-held execution binding keyed by exact session+Actor handles stable-session transport recovery. Project-level saved Tasks support explicit cross-conversation or reauthorization continuity without persisting full transcripts. |
| Model-provided absolute paths and implicit current state | `list_projects` returns opaque approved Project/Task references; model-visible `project_control` explicitly opens, resumes, hydrates, or interrupts; subsequent Project tools omit execution identity and resolve only the trusted session+Actor selection. |
| Large public lifecycle/tool vocabulary | Raw `tools/list` has 12 names, but App-only `project_thread_control` owns Actor-private Thread discovery/status/activity/lifecycle actions and is hidden from the 11-tool model surface. |
| Eager instruction and Skill context | `project_control` returns compact root instruction pages without the Skill catalog. Target tools return only newly applicable instruction deltas; `skills` lazily searches and loads one selected Skill. |
| Ambiguous process polling | `write_stdin` is mutation-only and requires `operationId`. Live polling belongs to read-only `read_process_output`. |
| Continuations requiring the model to reconstruct query state | Signed continuation cursors retain query state; continuation calls use the cursor under the same trusted session+Actor selection. |
| Command policy described as a security boundary | `process:execute` is explicit opt-in. Commands have the full file and network authority of the DevSpace OS user; there is no process sandbox or per-command network policy. |
| Overstated process cleanup | Shutdown and interrupt provide best-effort coverage only for process groups DevSpace started and still tracks. Detached or untracked descendants may survive. |
| Concurrent conversations sharing mutable files | Checkout Threads may deliberately share the approved Project directory. An explicit managed-worktree mode provides one writable worktree per active Thread; dirty worktrees are never removed automatically. |
| Instruction-file ambiguity | `AGENTS.override.md` and `AGENTS.md` are defaults. `CLAUDE.md` is used only when explicitly configured as a fallback. |

## Guarded effect requirements

The audit's mutation concerns are resolved in the current public contract:

- each new patch, command, or process-input effect has a fresh `operationId`;
- repeating an identical lost-response request with the same identifier replays
  the recorded outcome;
- using an identifier with different arguments is rejected;
- `apply_patch` requires an `ifMatch` version for every existing touched path
  and `null` for a touched path expected not to exist;
- stale file versions require rereading and reconciling content;
- Project root locks coordinate cooperating DevSpace writes and tracked
  commands, while external programs remain outside that lock.

## Remaining operational cautions

The resolved public contract does not remove the underlying host risks:

- approve only narrow Project roots;
- keep the Owner password, OAuth tokens, `auth.json`, master keys, tunnel
  credentials, and internal control tokens out of repositories and logs;
- treat `process:execute` as full local OS-user authority;
- use a dedicated OS account, container, or VM when stronger isolation is
  required;
- rescan or rebuild the ChatGPT App after tool-schema changes;
- hydrate the stable trusted session binding for transport recovery; explicitly
  open or select `tasks[].taskRef` from `list_projects` when the binding is
  missing/stale or for cross-conversation work;
- use managed worktree mode only for a Git top-level Project and review or hand
  off dirty changes before closing the Thread.

## Normative references

- [ChatGPT Tool Contract](./chatgpt-tool-contract.md)
- [Security Model](./security.md)
- [Configuration Reference](./configuration.md)
- [ChatGPT Coding Workflow](./chatgpt-coding-workflow.md)
- [Real ChatGPT Host Acceptance Matrix](./chatgpt-host-acceptance.md)
