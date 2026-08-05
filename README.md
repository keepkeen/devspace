<p align="center">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  让 ChatGPT 在明确授权的边界内读取、修改、运行和持续维护本地项目。
</p>

<p align="center">
  <a href="https://github.com/keepkeen/devspace/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2f6f44?style=flat-square"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-3f6b45?style=flat-square&logo=node.js&logoColor=white">
  <img alt="MCP Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-343a40?style=flat-square">
</p>

> [!IMPORTANT]
> 这是 [Waishnav/devspace](https://github.com/Waishnav/devspace) 的社区增强分支，
> 基于上游提交
> [`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5)，由
> [keepkeen/devspace](https://github.com/keepkeen/devspace) 独立维护。

## DevSpace 是什么

ChatGPT 运行在云端，不能直接打开你的本地项目。DevSpace 作为 ChatGPT App 的
本地 MCP 后端运行在你的电脑上，只把你批准的 Project 通过工具调用提供给
ChatGPT 网页版。

```text
ChatGPT 网页版
    │
    ▼
公网 HTTPS 隧道 ──► MCP / OAuth 服务（127.0.0.1:7676）──► 已批准的 Project

本机浏览器 ───────► 仅回环可访问的管理 / 控制服务
```

DevSpace 不会预先上传整个仓库，也不是第二个隐藏的编程模型。ChatGPT 只会收到
实际工具调用返回的有界内容。当前实现只支持 ChatGPT 网页版，不提供其他 MCP host
的兼容模式。

核心能力包括：

- 以 Project 为中心、受 OAuth grant 约束的持久 execution；
- 多账号、多授权并存，各自的授权状态、Thread、进程和 cursor 互相隔离；
- 带版本前置条件的读取与补丁、分页 diff、幂等操作和跨进程根锁；
- 可恢复的 Thread、进度摘要、活动日志和进程输出；
- 按需发现和加载的 AGENTS 指令与 Skills；
- 默认共享原目录，也可为 Git 顶层 Project 显式创建受管 worktree。

## 安全边界

只批准范围较小的项目根目录。不要批准 home、文件系统根目录、云盘根目录，或
包含无关隐私数据的目录。

DevSpace 对 Project、工具路径和命令工作目录执行授权与路径约束，并通过服务器保存的
session binding、签名 cursor、`operationId`、`ifMatch`、持久化 tombstone 和根锁
处理越权、重放、陈旧写入及并发竞争。仓库文件、指令、Skill、日志和模型保存的
摘要始终是不可信输入，不能扩大 OAuth 权限。

当 ChatGPT 提供匿名 `openai/subject` 或 `openai/session` 元数据时，DevSpace 只保存
HMAC 派生引用，用于 Actor 所有权和同一对话的 Thread 解析，不保存原始标识，也
无法访问完整聊天记录、隐藏 reasoning、token 使用量或 ChatGPT 的 compaction 历史。

> [!WARNING]
> `exec_command` 不是沙箱。子进程拥有运行 DevSpace 的本地 OS 用户权限和继承的
> 网络访问能力，可能访问已批准 Project 之外的内容。DevSpace 不提供命令 allowlist、
> 子进程文件系统隔离或逐命令网络控制。高风险环境应使用专用 OS 用户、容器或虚拟机。

## 快速开始

完整步骤见[安装与连接指南](./docs/setup.md)。以下命令使用仓库内 CLI；执行
`npm link` 后可用 `devspace` 替代 `node dist/cli.js`。

### 1. 安装

需要 Node.js `>=22.19 <27`、npm、Git、Bash（Windows 使用 Git Bash 或 WSL），
以及一个把本地服务转发为公网 HTTPS 的工具，例如
[cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)。

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --help
```

安装、构建和长期运行应使用同一个 Node 安装，因为 `better-sqlite3` 与 Node ABI
相关。

### 2. 启动 HTTPS 隧道

临时测试时，在另一个终端保持以下命令运行：

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

记录它输出的 HTTPS origin，例如 `https://random-name.trycloudflare.com`。初始化时
填写 origin，不追加 `/mcp`。

### 3. 初始化并启动

```bash
cd ~/tools/devspace
node dist/cli.js init
node dist/cli.js serve
```

初始化会询问窄范围 Project 根目录、本地端口和公网 HTTPS origin。保存向导显示的
Owner 密码；OAuth 批准页面需要它，存储的 verifier 无法恢复明文。

默认配置和状态目录：

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/
```

### 4. 检查服务

```bash
curl http://127.0.0.1:7676/healthz
curl http://127.0.0.1:7676/readyz
curl https://random-name.trycloudflare.com/readyz
node dist/cli.js doctor
```

`healthz` 表示进程存活，`readyz` 表示服务已准备接收请求。

### 5. 连接 ChatGPT

在 ChatGPT 中启用开发者模式并创建自定义 MCP App：

1. Endpoint 填写公网 origin 加 `/mcp`，例如
   `https://random-name.trycloudflare.com/mcp`。
2. 选择 OAuth，在 DevSpace 批准页面输入 Owner 密码。
3. 选择该 grant 可以访问的 Project 和能力。
4. 完成授权并扫描工具，然后在对话中启用此 App。

多个 OAuth grant 可以同时有效；新账号或重新授权不会替换其他 grant。每个 bearer
只解析到自己的能力、已批准 Project 和 execution。工具 schema 变化后，ChatGPT
可能仍使用旧快照，需要重新扫描或重建 App。

临时隧道地址变化时，可只覆盖本次启动：

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" node dist/cli.js serve
```

长期使用请配置稳定域名。隧道只能转发 MCP/OAuth 服务端口，不能暴露管理或内部
控制端口。

## Project、Task 与 execution

| 概念 | 含义 |
| --- | --- |
| Project | 当前 OAuth grant 明确批准的本地根目录。模型只看到不透明引用和标签。 |
| Task | Project 级、可跨对话和重新授权恢复的共享有界任务摘要；由 `list_projects` 列出。 |
| Thread | 当前 Actor 的私有运行记录；模型只在 bootstrap 上下文中接收其 `threadRef` 和 checkpoint。 |
| execution | 服务器为可信 `openai/session` 与 Actor 选择的活动运行环境；其内部身份不会暴露给模型。 |
| checkout | 默认模式，直接使用已批准的原目录；逻辑状态隔离，但文件系统不隔离。 |
| managed worktree | 显式可选的每 Task Git branch/worktree，仅适用于 Git 顶层 Project。 |

推荐对话流程：

1. 单 Project 可直接 `project_control(action=open)`；多 Project 或需要恢复任务时，
   先用 `list_projects` 获取明确的 `projectRef` 和 `tasks[].taskRef`。
2. 新任务用 `open`，恢复已保存任务用 `resume` 和明确的 `taskRef`。DevSpace 不按
   最近使用时间猜测任务；Project App 展示 Actor-private Thread 列表及其 lifecycle controls。
3. 成功的 `open` 或 `resume` 会为可信 `openai/session` 与 Actor 选择 execution。
   根指令较长时用每次返回的 cursor 继续 `hydrate`，直到
   `rootInstructionsComplete` 为 `true`；随后直接调用 Project 工具，不传 execution 引用。
4. 用 `read_files`、`inspect` 和 `skills` 获取所需上下文；出现新的嵌套指令时，
   先阅读返回的 instruction delta，再重试变更。
5. 使用 `apply_patch`、带必填 `source` 的 `show_changes` 和最小验证命令完成工作。
   长任务用 `save_progress` 保存精简摘要；进程输出用 `read_process_output` 读取。
6. Actor-private Thread 的 pause、archive、complete 或 close 在 Project App 中管理，
   而不是要求模型调用。共享 saved Task 的完成与容量释放使用执行中的
   `save_progress(status:"completed")`。

`open` 和 `resume` 使用 `operationId` 保证安全重试，并原子替换当前 session+Actor 的
选择。同一 session+Actor 的选择、hydrate 和 lifecycle 操作按请求顺序串行，后发选择
不会被较慢的旧请求覆盖。只要 host session 保持稳定，传输重连、服务重启或切换对话后都可以调用
`hydrate`；服务器会
按当前 OAuth principal、client、grant、authorization epoch、scope、批准根目录和
Project 身份重新解析并验证绑定的 execution。并发 session 可选择不同 Project，
不同 Actor 或不同 session 都不能复用其他绑定。绑定缺失或陈旧时，调用
`project_control(action=open)`，或明确选择 `tasks[].taskRef` 后调用 `resume`；不要按
最近使用或唯一候选猜测。重新授权会创建新的 execution，且不继承旧进程、命令重放
状态或 execution 私有变更日志。

### Checkout 模式

默认 `checkoutKind:"checkout"` 不会创建 branch 或 worktree。两个 execution 如果
绑定同一个 Project 原目录，会看到相同文件；Git 管理和并发协调仍由用户与工具负责。

对根目录恰好等于 Git 顶层的 Project，可在拥有 `project:write` 时显式请求
`checkoutKind:"worktree"`。DevSpace 会在私有状态目录创建受管 branch/worktree；
重复请求不会重复创建。Project App 的 Thread pause、archive 和 complete 保留它，
dirty worktree 不会被普通 close 自动删除；这些 action 不会完成共享 saved Task。

## 指令、Skills 与上下文

- 根 AGENTS 指令分页返回；在最后一页确认前，其他 Project 工具会被门控。
- 目标路径上的嵌套 AGENTS 指令按需发现，不会一次性注入全部目录内容。
- `project_control` 不注入整个 Skill catalog。模型先调用 `skills(action=search)`
  获取少量匹配描述，再用 `skills(action=load)` 加载一个 Skill 的 `SKILL.md`；其
  `skill://` 资源仍按需读取。
- 用户、管理员和 DevSpace Skill 可以隐式调用；仓库 Skill 始终按不可信仓库内容
  处理，不能自行获得隐式模型调用权或扩大授权。
- bootstrap 上下文使用 schema v8：execution 身份保留在服务器端；
  `thread.threadRef` 标识私有 Thread；checkpoint
  用标量 trust 字段区分服务器观察状态和不可信模型摘要；被分页截断的 instruction
  仅标记 `fragment.partial:true`。
- `save_progress` 保存的是 Project 级有界模型摘要，不是聊天全文；同一 Project
  后续可由新 grant 显式选择该 Task。恢复摘要只出现在 `thread.checkpoint` 中，不会
  再以第二份 Task 对象重复注入。

## OAuth 能力与工具

| Scope | 能力 |
| --- | --- |
| `project:read` | 发现 Project 和 Task，读取指令和 Skill，检查文件与变更。 |
| `project:write` | 应用版本保护补丁，并允许显式请求 managed worktree。 |
| `process:execute` | 与进程交互；启动命令时还必须同时拥有 `project:write`。 |

原始 `tools/list` 返回 12 个工具，其中 `project_thread_control` 标记为仅 Project App
可见；模型可见词汇固定为其余 11 个，并继续按 grant scope 过滤：

| 工具 | 所需 scope | 用途 |
| --- | --- | --- |
| `list_projects` | read | 返回批准的 Project，以及有界 `tasks`、`taskTrust` 和 `taskLimits`。 |
| `project_control` | read | 模型 bootstrap：open/resume/hydrate/interrupt；interrupt 另需 execute。 |
| `project_thread_control` | read；仅 App | 管理 Actor-private Thread 的 resolve/list/status/activity/pause/archive/complete/close；不管理 saved Task。 |
| `save_progress` | read | 保存 Project 级有界 Task，并返回 `task.taskRef`；`status:"completed"` 完成 Task 并释放容量。 |
| `read_files` | read | 批量读取已知文件及版本。 |
| `inspect` | read | 批量 grep、glob 或列目录。 |
| `skills` | read | 搜索 Skill 元数据或加载一个 Skill。 |
| `apply_patch` | read + write | 使用路径版本前置条件应用补丁。 |
| `show_changes` | read | 按显式 `source` 读取分页 Git diff 或 execution 补丁日志。 |
| `exec_command` | read + write + execute | 启动直接 argv 命令或明确说明理由的 shell 命令。 |
| `write_stdin` | read + execute | 输入、关闭、interrupt 或调整受跟踪进程。 |
| `read_process_output` | read + execute | 轮询活动进程，或分页、tail、搜索保留输出。 |

精确 action、字段、限制、cursor 与恢复规则以
[ChatGPT 工具契约](./docs/chatgpt-tool-contract.md)为准。

## 文件、变更与进程

`read_files` 返回文件版本；`apply_patch` 对每个触及路径要求 `ifMatch`，并使用
`operationId` 防止重复副作用。`show_changes` 要求调用者明确选择来源：
`source:"repository"` 仅在 Project 根本身是 Git 顶层时读取仓库工作区 diff；
`source:"apply_patch_history"` 在任何 Project 中都可读取当前 execution 成功
`apply_patch` 的有界持久日志，但不包含命令或外部编辑记录。

`exec_command` 支持两种互斥模式：直接 `program` + `args`，或确实需要管道、重定向
等语法时使用 `shell:true` + `command` + `approvalReason`。工作目录必须位于当前
checkout，但子进程本身仍拥有 OS 用户权限。

长运行命令会保留 Project 根 lease，因此其他文件或命令操作可能返回
`project_busy`。`read_process_output` 不获取该根锁，可以持续读取现有 session 的
stdout/stderr；它不会自动读取命令重定向到其他文件或远程机器上的 worker 日志。

## 本地管理与部署

```bash
node dist/cli.js admin
node dist/cli.js admin --no-open
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js config set widgets full
node dist/cli.js audit --limit 100
node dist/cli.js audit health --json
node dist/cli.js --version
```

管理面板只监听回环地址，并使用 capability、Host/Origin、CSRF 和 ETag 校验。当前
只有 allowed roots 支持热更新；用户指令、fallback 文件名、widgets 和资源限制等
设置需要重启后端。

管理面板的 restart 只控制明确注册的 macOS 用户 LaunchAgent，并会在仍有活动进程
时拒绝重启。仓库另带一个具有锁、就绪验证、回滚和恢复计划的
[macOS 一次性部署助手](./docs/macos-launchd-deployment.md)，它不是跨平台
`devspace deploy` 命令。

## 开发

基础检查：

```bash
npm ci
npm run build
npm test
npm run typecheck
```

涉及浏览器 UI 或打包时再运行：

```bash
npm run test:browser
npm run test:pack
```

以 [`package.json`](./package.json) 中的脚本为准。

## 文档

- [安装与连接](./docs/setup.md)
- [ChatGPT 编程工作流](./docs/chatgpt-coding-workflow.md)
- [ChatGPT 工具契约（规范性公共契约）](./docs/chatgpt-tool-contract.md)
- [配置参考](./docs/configuration.md)
- [安全模型](./docs/security.md)
- [常见问题](./docs/gotchas.md)
- [真实 ChatGPT host 验收](./docs/chatgpt-host-acceptance.md)
- [macOS LaunchAgent 部署](./docs/macos-launchd-deployment.md)
