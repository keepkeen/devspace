<p align="center">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  让 ChatGPT 网页版像本地编码助手一样，按需读取、修改和验证你明确授权的本地项目。
</p>

<p align="center">
  <a href="https://github.com/keepkeen/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/keepkeen/devspace/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/keepkeen/devspace/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2f6f44?style=flat-square"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-3f6b45?style=flat-square&logo=node.js&logoColor=white">
  <img alt="MCP Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-343a40?style=flat-square">
</p>

> [!IMPORTANT]
> 这是 [Waishnav/devspace](https://github.com/Waishnav/devspace) 的社区增强分支，
> 基于上游提交
> [`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5)，由
> [keepkeen/devspace](https://github.com/keepkeen/devspace) 独立维护。

## 一句话了解 DevSpace

ChatGPT 运行在云端，通常无法直接打开你电脑上的项目。DevSpace 在本机运行一个
MCP/OAuth 后端，把你明确批准的 Project 通过有界工具调用连接给 ChatGPT 网页版。
模型可以按需查看文件、应用补丁、运行测试、审阅变更，并在后续对话中继续已保存的任务。

它的使用体验接近本地编码助手，但运行方式不同：模型仍在 ChatGPT 云端，工具请求经
公网 HTTPS 到达你的电脑。DevSpace 不是本地模型、仓库同步或备份服务，也不会在连接时
预先上传整个仓库；ChatGPT 只会收到实际工具调用返回的内容。

```text
ChatGPT 网页版
    │  MCP + OAuth
    ▼
公网 HTTPS 地址 ──► DevSpace（本机 127.0.0.1:7676）──► 已批准的 Project

本机浏览器 ───────► 仅回环可访问的管理 / 控制服务
```

DevSpace 目前只支持 ChatGPT 网页版，不提供其他 MCP host 的兼容模式。

### 你可以用它做什么

- 让 ChatGPT 理解一个本地代码库，定位文件和跨文件关系；
- 批量读取已知文件，或批量执行 grep、glob 和目录检查；
- 使用文件版本前置条件安全地应用补丁，并分页审阅变更；
- 在项目目录中运行构建、测试和开发命令，持续读取长进程输出；
- 按需加载 `AGENTS.md` 与 Skills，减少无关上下文；
- 保存精简的任务进度，在新对话或重新授权后显式恢复工作。

### 与本地 Codex 的关键区别

| | 本地编码 Agent | ChatGPT + DevSpace |
| --- | --- | --- |
| 模型所在位置 | 通常由本地客户端直接编排 | ChatGPT 云端 |
| 本地文件访问 | 客户端直接访问 | 通过 DevSpace 的 MCP 工具按需访问 |
| 项目选择 | 通常由当前目录决定 | 由 OAuth grant 明确批准的 Project 决定 |
| 命令权限 | 取决于客户端沙箱或权限模式 | 继承运行 DevSpace 的本机用户权限，不是沙箱 |
| 跨对话继续 | 取决于客户端 session | 通过有界 Task 摘要显式恢复，不保存完整聊天记录 |

> [!WARNING]
> `exec_command` 不是沙箱。虽然文件工具和命令工作目录被限制在当前 Project，子进程
> 本身仍拥有运行 DevSpace 的本机 OS 用户权限和网络访问能力，可能访问 Project 之外的
> 内容。高风险环境请使用专用 OS 用户、容器或虚拟机。

## 10 分钟快速开始

### 开始前需要

- ChatGPT 账号或 Workspace 允许使用开发者模式和自定义 MCP 连接；可用性可能受
  账号与 Workspace 策略影响；
- Node.js `>=22.19 <27`、npm、Git 和 Bash（Windows 使用 Git Bash 或 WSL）；
- 一个把本地 `127.0.0.1:7676` 转发为公网 HTTPS 的工具，例如
  [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)；
- 一个用于测试的窄范围项目目录。不要直接批准 home 或磁盘根目录。

当前仓库可验证的安装路径是源码构建；仓库未提供自动安装系统服务的命令。

### 1. 安装

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --version
```

安装、构建和长期运行应使用同一个 Node 安装，因为 `better-sqlite3` 与 Node ABI 相关。
如需全局使用 `devspace` 命令，可在仓库中执行 `npm link`。

### 2. 启动 HTTPS 隧道

在另一个终端运行：

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

记录它输出的 HTTPS origin，例如 `https://random-name.trycloudflare.com`。初始化配置中
填写这个 origin，不追加 `/mcp`。临时域名会变化，长期使用请配置稳定域名。

### 3. 初始化并启动

```bash
cd ~/tools/devspace
node dist/cli.js init
node dist/cli.js serve
```

初始化向导会要求你设置窄范围 Project roots、本地端口和公网 HTTPS origin。请保存
首次显示的 Owner 密码：OAuth 批准页面需要它，DevSpace 只保存密码 verifier，无法
恢复明文。

默认启动只向 OAuth 客户端声明 `project:read` 和 `project:write`，不会开放本地命令
执行。若你确实需要让 ChatGPT 运行构建和测试，请在充分理解非沙箱风险后改为：

```bash
DEVSPACE_OAUTH_SCOPES=project:read,project:write,process:execute node dist/cli.js serve
```

若只需要查看项目，可使用 `DEVSPACE_OAUTH_SCOPES=project:read`。修改 scopes 后必须
重启服务、在 ChatGPT 中 Refresh 连接并重新授权；已有 grant 不会被静默扩权。

保持 `serve` 和上一步的隧道持续运行。在第三个终端执行后续健康检查，并在使用
ChatGPT 期间不要关闭前两个进程。

默认配置与状态位置：

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/
```

### 4. 验证本地与公网服务

```bash
curl -fsS http://127.0.0.1:7676/healthz
curl -fsS http://127.0.0.1:7676/readyz
curl -fsS https://random-name.trycloudflare.com/readyz
node dist/cli.js doctor
```

成功标准：`healthz` 返回 `status:"alive"`；两个 `readyz` 请求均为 HTTP 200，且返回
`ok:true`、`status:"ready"`。`doctor` 检查本机配置和依赖，但不能代替公网可达性或
真实 ChatGPT 授权测试。

### 5. 连接 ChatGPT

按照 OpenAI 当前的
[MCP 开发者模式连接流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)：

1. 在 ChatGPT 打开 **Settings → Security and login**，启用 **Developer mode**。
2. 打开 [ChatGPT Plugins](https://chatgpt.com/plugins)，新增一个 MCP connection。
3. MCP URL 填写公网 origin 加 `/mcp`，例如
   `https://random-name.trycloudflare.com/mcp`。
4. 使用 OAuth 连接。在 DevSpace 批准页输入 Owner 密码，并选择这个 grant 可以访问的
   Project roots。页面会展示请求的 scopes，但 Project 选择页不会另行提供能力勾选框。
5. 完成授权，确认 ChatGPT 发现的工具，然后在一个新对话中从工具菜单添加该连接。

ChatGPT 的界面名称可能变化，开发者模式也可能受 Workspace 管理策略限制。以链接的
OpenAI 官方文档为准。

### 6. 完成第一次只读任务

连接成功后，可以直接发送：

> 使用 DevSpace 查看已授权的 Project。打开我指定的项目，只读取 `README.md` 和
> `package.json`，用三点说明它的用途和主要脚本；不要修改文件，也不要执行命令。

一次完整成功应包含：选择或打开正确的 Project、加载根指令、读取两个文件，并返回
与文件内容一致的总结。模型会自行完成 `list_projects → open/resume → hydrate`；
根指令尚未加载完成时，其他 Project 工具会被暂时门控。

确认只读流程正确后，再尝试一个可审阅的小修改：

> 修改前先读取目标文件；只做我指定的改动，完成后展示变更，不要提交 Git。

## 日常工作流

1. **选择 Project。** 单 Project 可直接打开；多个 Project 时先列出并明确选择。
2. **获取必要上下文。** 读取目标文件，按需 grep/glob，加载路径上的 `AGENTS.md` 和
   相关 Skill，不一次性扫描整个仓库。
3. **修改与验证。** 用版本保护的补丁修改文件，运行最小相关测试。
4. **审阅变更。** 明确查看 Git 工作区 diff 或当前 execution 的补丁记录。
5. **继续长任务。** 保存精简进度；之后在新对话中从 Project 的 Task 列表显式恢复。

默认 checkout 直接使用你批准的原目录：不同对话如果选择同一目录，会看到相同文件。
如果 Project 根正好是 Git 顶层，并且 grant 具有写权限，可以显式选择 managed worktree；
它按 Thread 隔离，而不是按 Task 隔离。

## 需要理解的概念

| 概念 | 对用户意味着什么 |
| --- | --- |
| Project | 一个被当前 OAuth grant 明确批准的本地根目录。模型只看到不透明引用和标签。 |
| Task | Project 级的有界进度摘要，可在新对话或重新授权后显式恢复；不是聊天全文或文件快照。 |
| Thread | 当前 Actor 的私有运行记录和生命周期状态，由 DevSpace Project 页面管理。 |
| execution | 服务器为当前可信 host session 和 Actor 绑定的运行环境；模型不传递 `executionRef`。 |
| checkout | 默认直接使用原目录；逻辑状态隔离，但文件系统共享。 |
| managed worktree | 可选的 per-Thread Git worktree，仅适用于根目录就是 Git 顶层的 Project。 |

成功的 `open`、`resume` 或 `hydrate` 会在服务器端更新当前 session + Actor 的 execution
绑定。后续工具自动使用该绑定，不接收也不应复用 execution 引用。绑定缺失或失效时，
重新打开 Project，或从明确的 `taskRef` 恢复；DevSpace 不按“最近使用”或“唯一候选”猜测。

## 工具与批处理

启用并授予全部三个 scopes 后，模型可见以下 11 个工具：

| 类别 | 工具 | 作用 |
| --- | --- | --- |
| Project 与连续性 | `list_projects`, `project_control`, `save_progress` | 选择 Project、打开/恢复任务、加载根指令、保存进度 |
| 读取与上下文 | `read_files`, `inspect`, `skills` | 读取文件、搜索/列目录、按需加载 Skill |
| 修改与审阅 | `apply_patch`, `show_changes` | 应用版本保护补丁，查看 Git diff 或补丁记录 |
| 命令与进程 | `exec_command`, `write_stdin`, `read_process_output` | 启动命令、交互/中断、读取活动或保留输出 |

`read_files` 和 `inspect` 都支持每批 1–8 项：服务端并发处理、保持输入顺序，并逐项返回
成功或错误。批处理仍受单项和聚合输出预算约束，不等于一次性读取整个仓库。

默认 read + write 配置只显示前 8 个工具；三个命令与进程工具仅在 grant 包含
`process:execute` 时出现。工具面始终按当前 grant 的实际 scopes 过滤。

Project 页面另有一个仅 App 使用的 `project_thread_control`，负责 Thread 的列表和生命周期
管理，不应由模型调用。精确 action、字段、scope、cursor 和恢复规则以
[ChatGPT 工具契约](./docs/chatgpt-tool-contract.md)为准。

按照 ChatGPT 官方工具结果契约，`content` 和 `structuredContent` 对模型与 App 都可见，
而结果 `_meta` 只交给 App、对模型隐藏。DevSpace 只把 UI 投影放入 `_meta`；授权、路径
约束和服务端校验从不依赖这一可见性边界。

## 权限与安全边界

| OAuth scope | 能力 |
| --- | --- |
| `project:read` | 发现 Project/Task，读取指令、Skill、文件与变更。 |
| `project:write` | 应用版本保护补丁，并允许显式创建 managed worktree。 |
| `process:execute` | 与进程交互；启动新命令还必须同时拥有 read 和 write。 |

部署前请理解以下边界：

- **只批准窄目录。** 不要批准 home、文件系统根、云盘根或包含无关隐私数据的目录。
- **数据按需返回。** 仓库不会预先整体上传，但文件内容、命令输出和 diff 在工具返回时会
  发送给 ChatGPT。
- **命令不是沙箱。** Project 路径约束不是完整的 OS 隔离边界。
- **默认目录共享。** DevSpace 的 session、授权和进程状态隔离，不会自动隔离原目录文件。
- **仓库内容不可信。** `AGENTS.md`、Skills、日志和模型摘要不能扩大 OAuth 权限或 Project 根。
- **写入有并发保护。** `ifMatch`、`operationId`、签名 cursor 和根锁只协调 DevSpace 自身
  操作，无法阻止编辑器、Git hook 或其他本机进程修改文件。

更多细节见[安全模型](./docs/security.md)。

## 常见问题

### ChatGPT 连接后没有新工具，或仍使用旧参数

在 [ChatGPT Plugins](https://chatgpt.com/plugins) 打开该连接并选择 **Refresh**，确认工具
元数据已更新，然后新建对话复测。工具 schema 更新后，旧对话可能继续使用缓存快照。

### 临时隧道域名变化了

用新 origin 启动服务：

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-tunnel.example.com" node dist/cli.js serve
```

随后更新 ChatGPT 中的 MCP URL 并重新授权。只重启隧道不够，因为 OAuth issuer 和
redirect URL 也依赖公网 origin。

### `doctor` 通过，但 ChatGPT 仍无法连接

按顺序检查：服务终端输出 → 本地 `/readyz` → 公网 `/readyz` → OAuth 批准 → ChatGPT
连接元数据。`doctor` 不会探测隧道或 ChatGPT。

### `better-sqlite3` ABI 错误

确认运行时 Node 与安装依赖时一致，然后执行：

```bash
npm rebuild better-sqlite3
```

更多排障入口见[常见问题](./docs/gotchas.md)和
[真实 ChatGPT host 验收](./docs/chatgpt-host-acceptance.md)。

## 本地管理与长期运行

```bash
node dist/cli.js admin
node dist/cli.js admin --no-open
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js audit --limit 100
node dist/cli.js audit health --json
```

管理与内部控制服务只监听回环地址，绝不能通过隧道公开。当前只有 allowed roots 支持
热更新；其他配置通常需要重启后端。

仓库提供一个面向已配置 macOS 用户 LaunchAgent 的
[一次性部署助手](./docs/macos-launchd-deployment.md)，带锁、就绪验证和回滚。它不是首次
安装服务的教程，也不是跨平台 `devspace deploy` 命令。

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

涉及浏览器 UI 或打包时再运行：

```bash
npm run test:browser
npm run test:pack
```

以 [`package.json`](./package.json) 中的脚本为准。

## 深入文档

- [安装与连接](./docs/setup.md)
- [ChatGPT 编程工作流](./docs/chatgpt-coding-workflow.md)
- [ChatGPT 工具契约](./docs/chatgpt-tool-contract.md)
- [配置参考](./docs/configuration.md)
- [安全模型](./docs/security.md)
- [常见问题](./docs/gotchas.md)
- [真实 ChatGPT host 验收](./docs/chatgpt-host-acceptance.md)
- [macOS LaunchAgent 部署](./docs/macos-launchd-deployment.md)

## License

[MIT](./LICENSE)
