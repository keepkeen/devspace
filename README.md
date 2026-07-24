<p align="center">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  <strong>让 ChatGPT 直接读取、修改和测试你电脑上的项目。</strong>
</p>

<p align="center">
  DevSpace 把你授权的本地目录转换成安全、可检查的 MCP 工具。<br>
  ChatGPT 操作的是真实本地文件，不需要把整个仓库上传到云端沙箱。
</p>

<p align="center">
  <a href="https://github.com/keepkeen/devspace/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2f6f44?style=flat-square"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-3f6b45?style=flat-square&logo=node.js&logoColor=white">
  <img alt="MCP Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-343a40?style=flat-square">
  <img alt="ChatGPT App" src="https://img.shields.io/badge/ChatGPT-App-111?style=flat-square&logo=openai&logoColor=white">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#连接-chatgpt">连接 ChatGPT</a> ·
  <a href="#怎么使用">怎么使用</a> ·
  <a href="#推荐的项目组织">项目组织</a> ·
  <a href="#这个分支改进了什么">分支亮点</a> ·
  <a href="#安全边界">安全边界</a>
</p>

<p align="center">
  <a href="./docs/assets/devspace-screenshot.png">
    <img src="./docs/assets/devspace-screenshot.png" alt="DevSpace connected to ChatGPT" width="900">
  </a>
</p>

> [!IMPORTANT]
> 这是 [Waishnav/devspace](https://github.com/Waishnav/devspace) 的社区增强分支，
> 基于上游提交
> [`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5)。
> 本仓库不是上游官方版本。

## DevSpace 是什么？

ChatGPT 运行在云端，正常情况下无法打开你电脑上的
`/Users/alice/code/my-app`。Code Interpreter 和网页版 Python 也运行在另一台
机器上，所以把本地路径发给它们是没有用的。

DevSpace 在你的电脑上启动一个轻量 MCP 服务。授权目录之后，ChatGPT 可以：

- 读取文件和搜索代码；
- 修改文件和应用补丁；
- 运行测试、Lint、构建和其他命令；
- 查看 Git 变更；
- 遵守 `AGENTS.md`、`CLAUDE.md` 和本地 Skill；
- 在对话结束或网络重新连接后继续使用同一个 workspace。

在普通工作流中，DevSpace 只是工具服务，不是另一个隐藏的编码模型。由
ChatGPT 自己决定调用哪些工具，每次调用都会显示在对话中。项目也提供可选的
本地子代理功能，但默认关闭。

专用文件工具只能打开允许列表中的目录。DevSpace 不会提前上传整个仓库；只有
工具调用实际返回的内容会发送给 MCP 客户端。

## 工作原理

```mermaid
flowchart LR
    U["你"] --> C["ChatGPT 网页端"]
    C --> H["公网 HTTPS 地址"]
    H --> T["Cloudflare Tunnel"]
    T --> D["本地 DevSpace · 127.0.0.1:7676"]
    D --> W["已授权的本地目录"]
    D --> P["文件、Git 和命令工具"]
    A["本地管理面板"] -. "仅 localhost" .-> D
```

公网地址用于传输 MCP 和 OAuth 请求。管理面板只监听本机地址，不会暴露到
Tunnel 上。

## 快速开始

### 环境要求

- Node.js `>=22.19 <27`
- npm 和 Git
- macOS/Linux 上的 Bash，或者 Windows 上的 Git Bash/WSL
- 一个公网 HTTPS Tunnel，例如
  [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- 允许开启开发者模式的 ChatGPT 账号或工作区

安装依赖、构建项目和启动服务时应使用同一套 Node.js。DevSpace 使用原生模块
`better-sqlite3`，不同 Node ABI 之间不能直接混用。

### 1. 安装这个分支

```bash
git clone https://github.com/keepkeen/devspace.git
cd devspace
npm ci
npm run build
```

下面的教程直接从当前仓库运行 CLI：

```bash
node dist/cli.js --help
```

如果你更喜欢简短的 `devspace` 命令：

```bash
npm link
devspace --help
```

### 2. 初始化配置

```bash
node dist/cli.js init
```

初始化向导主要询问三项内容：

1. **允许访问的根目录**：例如 `/Users/alice/code`。ChatGPT 只能通过专用
   文件工具打开这些目录。
2. **本地端口**：默认是 `7676`。
3. **公网地址**：你的 HTTPS Tunnel 地址，不包含 `/mcp`。

普通配置和 Owner 密码分开保存：

```text
~/.devspace/config.json
~/.devspace/auth.json
```

不要分享或提交 `auth.json`。任何拿到 Owner 密码的人都可以批准新的 MCP 客户端。

### 3. 启动 DevSpace

```bash
node dist/cli.js serve
```

保持服务运行，在另一个终端检查本地状态：

```bash
curl http://127.0.0.1:7676/readyz
```

健康状态会返回 HTTP `200`，JSON 中包含：

```json
{"ok":true,"name":"devspace","status":"ready"}
```

也可以运行安装诊断：

```bash
node dist/cli.js doctor
```

### 4. 启动 HTTPS Tunnel

临时测试可以直接运行：

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

Cloudflare 会打印一个临时地址，例如：

```text
https://random-name.trycloudflare.com
```

保存该地址，然后重新启动 DevSpace：

```bash
node dist/cli.js config set publicBaseUrl https://random-name.trycloudflare.com
node dist/cli.js serve
```

检查完整公网链路：

```bash
curl https://random-name.trycloudflare.com/readyz
```

Quick Tunnel 每次重启都可能更换地址。日常使用建议创建带固定域名的 Named
Tunnel：

```bash
cloudflared tunnel login
cloudflared tunnel create devspace
cloudflared tunnel route dns devspace devspace.example.com
```

`~/.cloudflared/config.yml` 示例：

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /Users/you/.cloudflared/YOUR_TUNNEL_UUID.json

ingress:
  - hostname: devspace.example.com
    service: http://127.0.0.1:7676
  - service: http_status:404
```

启动 Named Tunnel：

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run devspace
```

最后保存固定公网地址：

```bash
node dist/cli.js config set publicBaseUrl https://devspace.example.com
```

## 连接 ChatGPT

OpenAI 目前把自定义 MCP 集成称为 **developer-mode app（开发者模式应用）**。
产品界面可能继续变化，最新入口请参考 OpenAI 官方的
[Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)。

1. 打开 ChatGPT 的 **Settings → Security and login**，开启
   **Developer mode**。组织账号可能需要管理员先允许该功能。
2. 打开 **Settings → Plugins**，或者直接访问
   [chatgpt.com/plugins](https://chatgpt.com/plugins)。
3. 新建一个 developer-mode app。
4. 填写容易理解的名称和说明，例如 `Local DevSpace`。
5. MCP 地址填写完整的 `/mcp` URL：

   ```text
   https://devspace.example.com/mcp
   ```

6. 创建应用并检查 ChatGPT 扫描到的工具列表。
7. 在 DevSpace OAuth 页面输入 `~/.devspace/auth.json` 中的 Owner 密码。
8. 新建 ChatGPT 对话，点击输入框附近的 **+**，选择 **More**，然后把
   DevSpace 应用添加到当前对话。

如果 DevSpace 新增或修改了工具，请在 ChatGPT 的 **Settings → Plugins** 中
打开该应用并选择 **Refresh**。只重启本地服务不会自动更新 ChatGPT 缓存的工具
定义。

## 怎么使用

第一次连接项目时，在提示词里明确要求使用 DevSpace，并给出准确的本地路径和一个
容易记忆的别名：

```text
使用 DevSpace 把 /Users/alice/code/my-app 打开为别名 my-app。
先阅读项目指令，找出失败的测试并修复，运行最小范围的验证，
最后总结修改了哪些文件。
```

正常的调用流程是：

1. ChatGPT 用本地项目路径和别名调用 `open_workspace`。默认返回精简的 v4 metadata
   continuation，不立即注入项目指令或 Skill 目录。metadata receipt 只能加载上下文或
   关闭/撤销 Workspace，不能读取、搜索、执行或修改文件。
2. 模型用 metadata receipt 调用 `get_workspace_context(contextMode: "full")`，取得
   结构化项目指令、Skill 目录和新的 context-loaded receipt。结果中的模型可见
   `workspace` 会包含
   `ref`、`alias`、不暴露本机路径的 `projectFingerprint` 和 generation；
   `continuation` 会包含 receipt、阶段、固定过期时间以及两类 revision。只有用当前 context-loaded receipt 刷新
   `get_workspace_context` 时，显式的 `contextMode: "retained"` 才会按已绑定的
   revision 跳过正文；打开、恢复、新对话和上下文压缩后必须使用 `full`。
3. 后续读取、搜索、编辑和命令调用只传当前 `receipt`。每个 Workspace-scoped
   结果都会在模型可见的 `structuredContent` 中回显同一个 `workspace` 和
   `continuation`，普通工具不会自行签发或续期 receipt；只有显式加载/刷新上下文
   才更新其固定到期时间。receipt 已经绑定本机
   connection principal、Workspace、代次、上下文阶段、私有 context session 及两类
   上下文修订号，模型不需要在每次调用里重复绝对路径或内部 ID。
4. ChatGPT 的每次工具调用都可以使用新的无状态 HTTP 传输；真正需要复用的是
   Workspace 的持久化记录，不是 MCP transport session。传输重连或旧 MCP session
   header 不会中断 workspace。
   新对话不需要再次发送绝对路径：先调用 `list_workspaces`，再通过 alias 或持久化的
   `workspaceRef` 调用 `resume_workspace`（二选一）恢复并取得新 `receipt`。
   `list_workspaces` 还返回稳定的 `projectFingerprint`，用于区分同名项目而不泄露主机路径。
   服务重启后旧 receipt 会失效，
   但 alias 和 Workspace 记录仍可恢复。
   如果你删除并重新添加 ChatGPT 应用，新的动态 OAuth 注册会在首次成功授权时建立新的
   connection principal，因此看不到旧 alias。需要明确恢复旧连接时，先在本机运行
   `devspace auth principals`，再用
   `devspace auth reconnect-code <principal-id>` 生成一次性短期代码，并在新的 OAuth
   授权页面输入。旧 receipt 永远不能跨注册复用。
   同一 connection principal 下可以同时保留多个项目 alias。ChatGPT 不会向 DevSpace
   提供可信的对话 ID，因此每个对话应把自己的 alias 当作持续性键：隔天继续、平台
   断线或打开新 transport 后先 `list_workspaces`，再恢复原 alias，不要新建替代 worktree。
   如果原 managed worktree 路径暂时丢失，alias 会保留为 `recovery_required`；恢复时
   DevSpace 会优先在原路径重建同一 Workspace，并尽量使用 Git 记录的最新提交。物理目录
   连同未提交内容一并丢失时，无法保证找回未提交修改，结果会明确标记
   `dataLossPossible=true`。
5. 只有你明确要求释放 workspace 时，模型才应调用 `close_workspace`。长时间
   未使用的 workspace 也可能在达到配置的空闲期限后自动过期。

新建 checkout 默认只读。需要直接修改当前 checkout 时，明确使用
`writeAccess: "read_write"`；更推荐使用 `mode: "worktree"` 获得隔离的可写工作区。
从 1.x 迁移的 checkout 会把历史权限显式写入 v14 数据库；新 checkout 仍默认只读。

不要让 ChatGPT 使用云端 Python 或 Code Interpreter 去检查本地路径。它们仍可
用于与本地项目无关的计算和数据处理；本地项目操作应通过 DevSpace 完成。

### 连接主体不是 ChatGPT 账户身份

DevSpace 看不到经过验证的 ChatGPT 账户 `sub`。动态 OAuth 注册本身不创建身份；只有
首次成功的 Owner 授权才为它建立独立的本机 connection principal。这提供的是
**连接级隔离**，不是 ChatGPT 账户级证明。
只有输入本机生成的一次性 reconnect code，新的注册才会显式绑定到旧 principal。

两个 principal 即使资源彼此不可见，仍可打开同一个物理 checkout。本 DevSpace
实例会按规范化根目录让读取和默认变更预览共享锁，让补丁、命令、可写进程输入、
显式 checkpoint 推进、关闭和撤销进入同一写队列。锁只覆盖 MCP 工具调用本身；返回的后台进程可以继续产生
无法完整观测的副作用，因此结果会标记为 `unknown`，后续补丁仍依赖 `ifMatch` 防止
静默覆盖。关闭和撤销会先终止受跟踪进程。并行工作仍优先使用独立 Git worktree。

### OAuth 能力范围

DevSpace 支持 `workspace:read`、`workspace:write`、`process:execute`、
`network:access`、`worktree:create` 和 `workspace:revoke`。授权页面会展示这些能力，
工具执行前还会再次校验。2.0 不再接受模糊的 `devspace` 全权限 scope；
`DEVSPACE_OAUTH_SCOPES` 只能包含上述六个能力中的非空子集。

### `AGENTS.md` 和 Skill

首次 `open_workspace` 默认只返回 metadata。模型随后用 receipt 调用
`get_workspace_context(contextMode: "full")` 取得 `instructions.items[]`。每项包含来源、
信任级别、作用域、相对路径、内容哈希和正文，不再把 Markdown 标题与服务端提示拼在一起。
仓库指令明确标记为 `repository_untrusted`，不能覆盖用户要求或 DevSpace 安全策略。
需要用户级指令时，可在管理面板或
`DEVSPACE_USER_INSTRUCTIONS_PATH` 中显式指定一个文件；默认不会读取
`~/.codex/AGENTS.md`。可信个人 Skill 使用 `~/.agents/skills`，DevSpace 自己管理的
Skill 使用 `~/.devspace/skills`，其他本机 allowlist 使用 `DEVSPACE_SKILL_PATHS`。full context 返回的根级
指令会直接绑定并确认到该 receipt 的私有 context session，第一次在根目录修改或执行前
不必再次发送。读取嵌套目录时只返回 `scopedInstructionsAvailable=true`；准备进入新的
嵌套指令作用域修改或执行前，模型调用 `load_workspace_instructions` 获取增量结构化指令和
一次性确认 Token。Token 只能由签发它的 context session 使用；新对话恢复 Workspace
不会清除旧有效 receipt 的确认状态。
纯空白指令文件会跳过，用户、根目录和嵌套
指令链合计最多 32 KiB；后台进程后续通过 `write_stdin` 进入新目录时也会先经过
同一套指令确认。完整上下文返回基于初始指令路径和内容生成的
`sha256-v1:` `instructionRevision`，便于客户端识别未变化的指令链，避免重复污染上下文。
Skill 目录使用独立的 `skillRevision`；只有模型仍保留旧目录时才传
`knownSkillRevision`，目录未变化便不会重复返回。revision 只在当前
context-loaded receipt 的 `get_workspace_context(retained)` 刷新中生效；新对话和
上下文压缩后应使用 `full`。

DevSpace 也会告诉 ChatGPT 当前可用的本地 Skill；`list_skills` 支持搜索和分页。ChatGPT 网页端没有 Codex 的
`$skill`/`/skills` 界面，因此模型通过 `load_skill` 完整加载对应 `SKILL.md`；
加载成功后才允许读取支持文件并执行工作流。同名 Skill 不会被覆盖，模型使用
`skillId`、隐私安全的逻辑路径和作用域区分。加载后可通过
`skill://<skillId>/references/example.md` 读取 reference、script 等支持文件，
无需向模型暴露本机 Skill 绝对路径。详细规则见
[ChatGPT 编码工作流](./docs/chatgpt-coding-workflow.md)。
仓库来源 Skill 始终标记为 `repository_untrusted` 并默认 `explicitOnly=true`；仓库自己的
`agents/openai.yaml` 不能为自身开启隐式调用。`load_skill` 把正文放入结构化
`skill.content`，固定文本只说明来源和信任边界，避免把服务端话术与不可信正文混在一起。
explicit-only Skill 不进入自动 full-context 目录；用户明确提到 Skill 时，模型先用
`list_skills(query=<精确名称>)` 取得清洗后的描述和 `skillId`，再调用 `load_skill`。
如需本机显式信任某一个仓库 Skill，可把它的精确目录或 `SKILL.md` 路径加入
`DEVSPACE_SKILL_PATHS`；该本机 allowlist 优先于自动仓库发现，同时不会重复加载同一清单。

### 固定工具协议

DevSpace 只提供一套稳定的 Codex 风格工具：`read`、`batch_read`、
`batch_inspect`、`apply_patch`、`exec_command`、`write_stdin` 和
`read_process_output`，再加 `list_workspaces`、`resume_workspace`、
`get_workspace_context`、`load_workspace_instructions`、`get_operation_status`、
`revoke_workspace` 和可选 Skill 工具。不再按模式切换
`bash`、`exec_command` 或文件工具名称，避免 ChatGPT 对旧工具表产生缓存混淆。

`exec_command` 优先使用 `program` + `args` 直接启动程序，参数不会经过 Shell
重新解析。只有需要管道、重定向等 Shell 语法时才使用 `shell: true` + `command`；
交互式 Shell 也必须走这一模式，不能用 `program: "bash"` 绕过逐次输入检查。
2.0 不再接受 `cmd` 或 `cwd` 别名；工作目录只使用 `workingDirectory`。需要发送多行
Python、SQL 或 SSH 脚本时，模型可使用结构化 `stdin` 字段，避免多层引号在远端解析失败。提供 `stdin` 后默认自动
关闭输入流；需要继续交互时可设 `closeStdin: false`，之后通过 `write_stdin`
追加内容或关闭输入流。PTY 不模拟 Ctrl-D 作为 EOF。

`apply_patch`、`exec_command`、`close_workspace` 和 `revoke_workspace`
必须提供 `operationId`；`show_changes` 默认是只读预览，不推进 checkpoint，也不需要
write scope 或 operation ID。只有显式设置 `advanceCheckpoint: true` 时才需要
`operationId` 和 `workspace:write`。`write_stdin` 在发送输入、关闭 stdin 或调整终端
尺寸时也必须提供，纯轮询不需要。每次新操作使用新 ID；网络响应丢失时用同一 ID 重试，
服务端会重放已保存结果而不会再次执行。所有失败均返回结构化 `error.code`、
`retryable`、`safeToRetry`、`recovery`、`phase` 和 `effectsKnown`。命令非零退出不是
“命令未执行”：结果会返回
`ok: false`、`status: "exited"`、`commandExecuted: true` 和 `exitCode`。
`get_operation_status(operationId)` 可查询保留状态而不会重新执行或重复返回大结果。
结果正文到期后会被清除，但该 ID 的轻量去重记录会保留到 Workspace 记录删除；旧 ID
不会在 24 小时后重新变成一次新操作。

所有 Workspace 工具都要求当前 v4 上下文 `receipt`；统一注册层会在工具执行前解析它并校验
connection principal、OAuth capability、Workspace 代次、context phase 与私有 context session。metadata receipt
只能升级上下文或执行关闭/撤销；读取、搜索、进程和修改工具必须使用 context-loaded receipt。
2.0 不再从 `workspaceId` 或 generation 猜测最近 receipt；缺少
`continuation.receipt` 的调用会在 handler 开始前失败。升级后必须在 ChatGPT 中 Refresh
应用工具定义。
receipt 还绑定签发时的 alias、项目指纹和两类上下文修订号，供恢复和缓存去重使用；
receipt 缓存同时具有全局上限和单 principal 公平上限，使用只刷新 LRU 顺序，不延长固定
期限。项目内文件变化仍由指令门禁、Skill 重载和文件版本锁分别检查。服务重启、principal
relink/revoke、Owner 凭据或授权根等真实权限边界变更以及
关闭/重新打开会使旧 receipt 失效，此时用 alias 恢复并获取新的 receipt。`read` 返回
`contentHash` 和精确字符串形式的
`mtimeNs`。`apply_patch` 默认要求每个 touched path 都有 `ifMatch`：已有文件使用最新读取
版本，预期不存在的新路径显式传 `null`。缺少任一路径的前置条件时，补丁不会开始执行。

所有 Workspace-scoped 工具都会返回统一的 `workspace` 和 `continuation`；只有
`open_workspace`、`resume_workspace` 与 `get_workspace_context` 的上下文载荷保留独立
`context.phase`，避免普通工具重复两份 revision。
写入、命令、可写进程交互、显式推进的变更 checkpoint、关闭和撤销还会返回
`operation` 和 `effects`。operation 明确给出 `not_started`、`committed` 或
`outcome_unknown`，以及是否可安全重试和副作用是否已知。每项 effect 还标记证据可信度：
DevSpace 直接测得的版本或生命周期状态为 `observed`，策略声明为 `declared`，任意进程可能
产生而无法枚举的副作用为 `unknown`，不会伪造精确文件清单。

同一 connection principal 重复打开相同提交的 managed worktree 时会默认复用；只有明确需要另一份
隔离环境时才设置 `forceNew: true`。`list_workspaces` 会返回持久化的 `dirtySource`，
空项目、顶层条目以及 Git 分支/脏状态则通过紧凑的 `project` 字段返回。过期清理只删除
干净 worktree，绝不自动删除带修改的 worktree。

如果已经明确知道多个相互独立的文件或搜索目标，`batch_read` 和
`batch_inspect` 可以减少 MCP 往返。输入可携带短 `ref`，输出会回显 `ref` 并明确给出
`completed`、`partial` 或 `failed` 以及成功/失败数量。如果下一个目标依赖上一次搜索结果，模型
仍应按顺序检查，而不是强行批量处理。
`batch_read.items[]` 的成功项直接包含 `path`、`content`、`contentHash`、精确
`mtimeNs`、`offset`、可选 `nextOffset`/`truncated`；它与单文件 `read` 共用读前/读后
稳定性校验，因此版本可直接用于后续 `apply_patch.ifMatch`。

DevSpace 对较大的工具结果只保留一份模型可见正文，避免同一文件或命令输出在
`content` 和 `structuredContent` 中重复占用上下文。单项文件读取只在 `content`
返回正文；Skill 正文位于带来源/信任字段的结构化 `skill.content`；
命令和进程轮询把合并后的 stdout/stderr 放在
`structuredContent.output.text`，分页读取放在
`structuredContent.page.text`，而 `content` 只返回简短状态说明；`batch_read` 使用上述
版本化文件项，`batch_inspect` 保留 `ref/ok/result`，两者都不返回主机绝对路径或拼接后的
聚合 `result`。`_meta` 只承载可选的
ChatGPT 组件信息，普通 MCP 客户端可以忽略。依赖旧重复字段的客户端需要按上述
归属读取结果；详细契约见[ChatGPT 编码工作流](./docs/chatgpt-coding-workflow.md)。
单个 `SKILL.md` 的加载上限为 64 KiB。

## 推荐的项目组织

DevSpace 的持久化单位是 **connection principal 下的 Workspace alias**。最稳定的
使用方式是：一个 Git 项目一个目录、一个持续任务一个 alias、需要并行隔离时一个
managed worktree。不要把整个 Home 目录当成项目根。

推荐结构：

```text
~/code/                              # DevSpace allowed root
├── billing-api/                     # 一个独立 Git 项目
│   ├── AGENTS.md                    # 简短、稳定、适用于整个仓库的规则
│   ├── docs/
│   │   └── agent-architecture.md    # 详细背景资料，不塞进根指令
│   ├── services/
│   │   └── payments/
│   │       └── AGENTS.md            # 只作用于该子目录的增量规则
│   ├── .agents/
│   │   └── skills/
│   │       └── release-check/
│   │           ├── SKILL.md         # 仓库 Skill，默认 explicit-only
│   │           └── references/
│   └── package.json
└── mobile-app/                      # 另一个项目，使用另一个 alias

~/.agents/skills/                    # 个人可信 Skill，不属于任何仓库
└── company-review/
    └── SKILL.md
```

建议按下面的方式选择 Workspace：

| 需求 | 建议做法 |
| --- | --- |
| 隔天继续同一任务 | `list_workspaces` 后恢复原 alias，不重新发送路径。 |
| 新对话继续原任务 | 恢复同一个 alias；两个对话会看到同一个 Workspace 状态。 |
| 同一仓库开启独立新任务 | 使用新的 managed worktree 和新 alias，例如 `billing-api-auth-fix`。 |
| 只审查当前 checkout | 使用默认只读 checkout，不授予写权限。 |
| 两个账号或 principal 并行修改同一仓库 | 使用两个 managed worktree；不要共享同一个可写 checkout。 |
| 同时处理多个项目 | 每个项目保留独立 alias；不要让一个对话在多个 alias 之间来回漂移。 |

项目本身建议遵循这些规则：

1. **Allowed root 只放项目集合。** 推荐授权 `~/code`、`~/work` 之类的目录，
   不要授权 `~`、`/`、云盘根目录或包含大量私人文件的目录。
2. **Git 仓库先有一个基线提交。** managed worktree 需要有效提交；重要阶段及时
   commit。物理 worktree 丢失时，DevSpace 能恢复已提交内容，不能保证恢复随目录
   一同消失的未提交文件。
3. **根 `AGENTS.md` 保持短小。** 只写构建命令、测试要求、架构边界和禁止事项。
   详细设计放入 `docs/`；子系统规则放在对应目录的嵌套 `AGENTS.md`。完整有效指令链
   上限为 32 KiB，越短越不容易挤占模型上下文。
4. **Skill 按信任来源分层。** 仓库 Skill 默认不可信且必须显式加载；个人或管理员
   可信 Skill 放在用户/Admin Skill 根。只有确实需要隐式选择时，才把精确 Skill
   目录加入 `DEVSPACE_SKILL_PATHS`。description 保持一行，长资料放入 `references/`。
5. **不要把秘密写进指令或 Skill。** Token、SSH key、云凭据和私有环境变量应留在
   系统密钥链或进程环境中；只有命令明确需要时才通过受控环境覆盖传入。
6. **生成物留在项目内。** `dist`、`coverage`、缓存和临时测试输出放在仓库目录中并
   加入 `.gitignore`，这样正常清理命令不会碰到 Workspace 外部路径。
7. **Monorepo 默认打开仓库根。** 用嵌套指令描述 package 差异。只有某个子项目需要
   独立权限、独立生命周期或完全不同的任务历史时，才单独打开子目录。
8. **对话分支不是 Git 分支。** ChatGPT 的对话分支会复制 receipt，但仍指向同一个
   Workspace。需要文件级隔离时必须创建 managed worktree。

## 保持长期在线

要让 ChatGPT 随时连接到本地，需要同时保持两个进程运行：

```text
DevSpace 服务  +  HTTPS Tunnel
```

建议用 `launchd`、`systemd` 等系统服务管理器运行它们，开启自动重启，并使用
固定 Tunnel 域名。ChatGPT 对话结束不会自动关闭本地 workspace；workspace
状态保存在 SQLite 中，不依赖某一条 HTTP 连接。

服务重启后，ChatGPT 可能创建新的 MCP 传输会话。已持久化的 checkout
workspace 不会丢失，但旧 receipt 会失效；模型应先 `list_workspaces`，再用
alias 或 `workspaceRef` 调用 `resume_workspace` 并使用 `contextMode: "full"` 取得新 receipt。

<details>
<summary><strong>小火箭或其他 TUN 代理</strong></summary>

把以下 Cloudflare Tunnel 直连规则放在通用代理和 FINAL 规则之前：

```text
DOMAIN,region1.v2.argotunnel.com,DIRECT
DOMAIN,region2.v2.argotunnel.com,DIRECT
DOMAIN-SUFFIX,argotunnel.com,DIRECT
IP-CIDR,198.41.192.0/24,DIRECT,no-resolve
IP-CIDR,198.41.200.0/24,DIRECT,no-resolve
IP-CIDR6,2606:4700:a0::/48,DIRECT,no-resolve
IP-CIDR6,2606:4700:a8::/48,DIRECT,no-resolve
```

不要把整个 `198.18.0.0/15` Fake-IP 网段设为直连。

</details>

## 本地管理面板

```bash
node dist/cli.js admin
```

DevSpace 会打开一个仅限 localhost、带一次性令牌的管理地址。面板可以：

- 添加和删除允许访问的目录；保存后热更新，无需重启；
- 选择结果卡片模式和用户级说明文件；
- 设置 MCP、进程、workspace、命令和 worktree 配额；
- 查看后端、Tunnel、配额和最近失败状态；
- 下载经过脱敏的诊断报告；
- 一键撤销所有 OAuth 客户端和 Token；
- 重启明确授权的 macOS `launchd` 后端，并验证新 PID 和 readiness generation。

保存配置不会偷偷重启后端。允许访问的目录会立即热更新：新增目录马上可用，
移除目录会使相关 workspace 失效并终止其运行命令。其他影响运行服务的配置仍需重启。在
macOS 上，只有明确授权的 `launchd` 服务才能由管理面板重启，例如：

```bash
DEVSPACE_LAUNCHD_SERVICE_LABEL=com.waishnav.devspace node dist/cli.js admin
```

管理面板不会启动、接管或结束任意 `cloudflared` 进程。Tunnel 控制目前只显示
状态，不执行启停操作。

## 这个分支改进了什么？

上游项目验证了“通过 MCP 访问本地 workspace”这条路线。本分支重点解决日常
使用 ChatGPT 网页端时的持久性、安全性、速度和管理问题。

以下对比基于上游提交
[`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5)。

| 方面 | 这个分支的改进 |
| --- | --- |
| 对话与项目连续性 | Workspace 不绑定短暂 MCP transport。alias、`workspaceRef` 和 HMAC `projectFingerprint` 可见；同一连接的多个对话可分别保留多个项目，隔天或新 transport 后精确恢复。 |
| worktree 恢复 | managed worktree 路径丢失时不创建无穷新分支；原 Workspace ID/alias 保留为 `recovery_required`，恢复时优先使用 Git worktree metadata 中的最新提交，并明确标记未提交数据风险。 |
| 稳定连接主体 | 动态 OAuth 注册在首次成功 Owner 批准后才获得 connection principal；删除并重加连接时可用一次性 reconnect code 明确恢复旧主体。不同 principal 不能复用 Workspace、进程、输出或 operation ID。 |
| 细粒度 OAuth | `workspace:read`、`workspace:write`、`process:execute`、`network:access`、`worktree:create`、`workspace:revoke` 分别校验。相同权限重新批准不会无故推进全部 Workspace generation。 |
| 可见 continuation | 所有 Workspace 工具回显 `workspace` 和当前 `continuation`，包括固定 `expiresAt`。普通调用不重复签发 receipt；上下文加载或刷新才续期，mutation 重放动态附加当前 continuation。 |
| 公平 receipt 缓存 | receipt 有全局和单 principal 配额，过期记录先清理，LRU 使用不滑动固定 TTL，避免一个连接挤掉其他连接的上下文。 |
| 紧凑模型上下文 | metadata/full/retained phase、延迟加载指令、explicit-only Repository Skill、单一正文位置和精简 envelope 控制工具上下文；完整多轮/分支/多 principal 模拟持续测量模型可见字节。 |
| 文件一致性 | `read` 与 `batch_read` 共用读前/读后版本校验并返回 `contentHash`/`mtimeNs`；`apply_patch` 对每个 touched path 强制完整 `ifMatch`，不存在 blind write。 |
| 幂等 mutation | 写入、命令、可写进程输入、生命周期和 checkpoint 推进使用持久 operation ID。响应丢失时可重放结果，不会重复执行；未知结果不会自动重跑。 |
| 变更预览做减法 | `show_changes` 默认是只读预览，不要求 write scope 或 operation ID，也不推进 checkpoint；只有显式 `advanceCheckpoint` 才成为幂等写操作。 |
| 命令与进程边界 | 普通 build/test/Git/package 命令和项目内清理可正常执行；Workspace 外写入、根目录删除、受保护状态、`sudo` 和远程内容 pipe-to-shell 被阻止。子进程只继承最小安全环境，后台进程不长期锁死 Workspace。 |
| 进程输出 | 命令正文位于模型可见的结构化 `output.text`，分页正文位于 `page.text`；有持久输出时始终返回 `outputId`。命令还有硬超时、终止宽限和资源配额，输出所有权同时绑定 principal 和 Workspace。 |
| 指令门禁 | 用户/根/嵌套指令以结构化来源、trust、scope、hash 和 revision 返回。根指令按私有 context session 确认，进入新目录修改前显式加载增量规则，全链限制为 32 KiB。 |
| Skill 信任边界 | Repository Skill 永远是 `repository_untrusted`、默认 explicit-only，不能通过自身 metadata 提权；catalog description 会清洗控制字符/HTML/代码块，正文与固定服务端文本分离。 |
| 同根并发协调 | 规范化物理根上的公平读写锁允许并行读取并串行化 MCP 写调用；长期 dev server 不持有生命周期级全局锁，严格文件版本防止静默覆盖。 |
| 撤销和清理 | revoke/close 先阻止新调用、终止受跟踪进程并排空活动请求；持久化清理任务在崩溃后继续。干净 worktree 可删除，脏 worktree 保留为可审计结果。 |
| 管理与可观测性 | localhost 管理面板支持热更新 allowed roots、配额、脱敏诊断和受控服务重启；日志使用 `connectionRef`、`oauthClientRef` 和 `workspaceActivityRef`，不记录原始 Token 或主机路径。 |
| 发布供应链 | Claude/Pi 改用用户已安装的 CLI，不再为未启用 provider 强制安装 Claude/Pi/Google SDK；基础文件工具由本地纯 Node 实现。MCP SDK 以已审计依赖树打包，minimatch/brace 固定为安全版本，规避上游 Hono 1.x advisory。`test:pack` 在全新消费者项目中默认安装 tarball、运行 CLI/SQLite/服务烟测并强制 `npm audit --omit=dev` 为 0。 |

## 安全边界

DevSpace 允许远程模型在受控范围内访问你的电脑。请把已授权的 ChatGPT 应用
当成一个拥有当前 DevSpace 系统用户权限的编码协作者。

DevSpace 会强制执行：

- 专用文件工具的目录允许列表；
- 真实路径和符号链接检查；
- OAuth 授权和 connection principal 资源所有权；
- Host 与 OAuth 重定向地址允许列表；
- MCP 会话、进程、输出和命令时间限制；
- 只监听 localhost 的管理面板；
- 明确的写操作标注和 ChatGPT 确认流程。

> [!WARNING]
> `exec_command` 使用运行 DevSpace 的系统用户权限。文件工具的目录
> 允许列表并不是任意 shell 命令的操作系统级沙箱。如果需要强隔离，请使用
> 专用系统账号，或者把 DevSpace 放进只挂载授权目录的容器/虚拟机中运行。

推荐做法：

1. 只授权真正需要的最小目录。
2. 保护好 `~/.devspace/auth.json` 和 Tunnel 凭据。
3. 不要把本地管理面板暴露到公网 Tunnel。
4. 使用 TLS 和固定域名。
5. 检查 ChatGPT 的写操作确认和 Git Diff。
6. 高风险或多用户环境使用专用系统账号。

完整说明见[安全模型](./docs/security.md)。

## 配置

常用命令：

```bash
node dist/cli.js init
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js config set publicBaseUrl https://devspace.example.com
node dist/cli.js admin
```

常用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 本地监听地址。 |
| `PORT` | `7676` | 本地 MCP 服务端口。 |
| `DEVSPACE_ALLOWED_ROOTS` | — | 逗号分隔的授权目录。 |
| `DEVSPACE_PUBLIC_BASE_URL` | — | 不带 `/mcp` 的公网 HTTPS 地址。 |
| `DEVSPACE_WIDGETS` | `full` | `full`、`changes` 或 `off`。 |
| `DEVSPACE_MAX_MCP_SESSIONS` | `64` | MCP 会话全局上限。 |
| `DEVSPACE_MAX_PROCESS_SESSIONS` | `32` | 保留进程会话的全局上限。 |
| `DEVSPACE_MAX_PROCESS_OUTPUT_FILE_BYTES` | `67108864` | 单个进程完整输出的持久化上限（64 MiB）。 |
| `DEVSPACE_MAX_PROCESS_OUTPUT_STORAGE_BYTES` | `1073741824` | 所有持久化进程输出的总上限（1 GiB）。 |
| `DEVSPACE_COMPLETED_PROCESS_OUTPUT_TTL_SECONDS` | `86400` | 已完成进程输出的保留时间（24 小时）。 |
| `DEVSPACE_MAX_COMMAND_RUNTIME_SECONDS` | `3600` | 命令硬超时时间。 |

完整选项见[配置参考](./docs/configuration.md)。

## 常见问题

<details>
<summary><strong>ChatGPT 提示本地工具已被禁用</strong></summary>

- 确认当前对话已经添加 DevSpace 应用。
- 确认配置的 URL 以 `/mcp` 结尾。
- 运行 `curl https://your-host/readyz`。
- 修改工具后，在 ChatGPT Plugin 设置里刷新应用。
- 如果客户端或 Token 已被撤销，重新完成 OAuth 授权。

</details>

<details>
<summary><strong>公网地址返回 502</strong></summary>

先检查本地服务：

```bash
curl http://127.0.0.1:7676/readyz
```

如果本地正常，再检查 `cloudflared` 日志，并确认 ingress 指向
`http://127.0.0.1:7676`。

</details>

<details>
<summary><strong><code>better-sqlite3</code> 无法加载</strong></summary>

安装依赖和运行服务使用的 Node.js ABI 可能不同：

```bash
npm rebuild better-sqlite3
node dist/cli.js doctor
```

</details>

<details>
<summary><strong>工具调用很慢</strong></summary>

- 已知多个独立目标后，使用 `batch_read` 或 `batch_inspect`。
- 分别测试本地和公网 `/readyz` 延迟。
- 如果使用 VPN/TUN 代理，让 Cloudflare Tunnel 相关地址按需直连。
- 长时间测试或构建属于命令执行时间，并不一定是 MCP 传输慢。

</details>

更多内容见[故障排查](./docs/gotchas.md)。

## 从 1.x 升级到 2.0

2.0 是一次明确的协议和数据库切换。升级前先在系统服务管理器中停止 DevSpace，
然后复制整个 state directory（默认 `~/.local/share/devspace`）作为离线备份。
不要只复制主数据库：process-output 元数据也会升级。

首次启动 2.0 时：

- 主 `devspace.sqlite` 会在临时文件中转换为唯一的 canonical v14 schema，完成
  integrity/foreign-key 校验后再原子替换；原文件保留为
  `devspace.sqlite.pre-v14.<timestamp>.bak`。
- 历史 `devspace` Token scope 只在迁移时展开为六个明确能力；2.0 运行时不再
  接受该 scope。
- Workspace 会补齐 principal、alias、canonical root、write access 和 generation；
  不存在的 checkout 会关闭，同 principal 的重复 active checkout 只保留一个。
- mutation replay 会移除旧 receipt/continuation 快照；claimed cleanup job 会回到
  可重试的 pending 状态。
- `process-output/metadata.sqlite` 从 v2 事务迁到 v3，所有权列统一为
  `connection_principal_id`。

数据库迁移成功后，在 ChatGPT 的 DevSpace 应用设置中执行 **Refresh**。1.x 的
`workspaceId`/generation、`cmd`/`cwd` 和 `devspace` scope 请求不会被兼容执行。

需要回滚时，先停止 2.0，恢复升级前复制的**整个 state directory**，再安装并启动
原 1.x 版本。只恢复主数据库备份不足以回滚 process-output v3。确认回滚服务可用后，
再次刷新 ChatGPT 中的工具定义。


## 开发

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run test:browser
npm run build
npm run test:pack
```

`test:pack` 不只是生成 tarball：它会在全新临时消费者项目中安装发布包，运行
CLI、SQLite 和服务启动烟测，并执行生产依赖审计。任何消费者可见漏洞都会让发布门禁失败。

## 文档

- [安装指南](./docs/setup.md)
- [ChatGPT 编码工作流](./docs/chatgpt-coding-workflow.md)
- [真实 ChatGPT 宿主验收矩阵](./docs/chatgpt-host-acceptance.md)
- [配置参考](./docs/configuration.md)
- [安全模型](./docs/security.md)
- [故障排查](./docs/gotchas.md)

## 上游与署名

DevSpace 由 [Waishnav](https://github.com/Waishnav) 创建。本分支保留原项目的
提交历史、资源和 MIT 许可证，并单独维护针对 ChatGPT 持久工作流、安全、速度
和本地管理的增强功能。

- 上游项目：[Waishnav/devspace](https://github.com/Waishnav/devspace)
- 当前分支：[keepkeen/devspace](https://github.com/keepkeen/devspace)
- 对比基线：[`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5)

## 许可证

[MIT](./LICENSE) © Waishnav and contributors。本分支改动使用相同许可证。
