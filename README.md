<p align="center">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  让 ChatGPT 读取、修改并测试你明确授权的本地项目。
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

ChatGPT 运行在云端，不能直接打开你的本地 checkout。DevSpace 在你的电脑上运行，
通过本地 MCP 服务和公网 HTTPS 入口，把你明确批准的 Project 提供给 ChatGPT 网页版。

```text
ChatGPT 网页版 → HTTPS 隧道 → 127.0.0.1:7676 上的 DevSpace → 已批准的 Project
                                      └→ 仅限本机的管理面板
```

DevSpace 不会预先上传整个仓库，也不是第二个隐藏的编程模型。ChatGPT 只会收到
它实际调用工具后返回的内容。

DevSpace 只面向 ChatGPT 网页版，不提供其他 MCP host 的兼容模式。

## 安全边界

只批准范围较小的项目根目录。不要批准 home 目录、文件系统根目录、云盘根目录，
或包含无关隐私数据的目录。

DevSpace 会检查 Project 选择、文件路径和命令工作目录是否位于已配置的根目录内。
文件写入同时保留 `ifMatch`、`operationId` 和根锁等并发安全约束。

这不是操作系统级隔离。`exec_command` 会以运行 DevSpace 的本地 OS 用户权限启动
进程；该进程可以读取或修改此用户能访问的任何内容，也可以访问网络。DevSpace
不提供进程沙箱、命令允许/拒绝策略、对子进程的受保护路径强制，也不提供逐命令
网络控制。如需更强隔离，请使用专用 OS 用户、容器或虚拟机。

## 快速开始

以下示例使用仓库内 CLI。可选执行 `npm link` 后，可以用 `devspace` 替代
`node dist/cli.js`。

### 1. 安装

需要 Node.js `>=22.19 <27`、npm、Git，以及可提供 HTTPS 入口的工具，例如
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)。

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --help
```

安装、构建和长期运行请使用同一个 Node 安装，因为 `better-sqlite3` 与 Node ABI
相关。

### 2. 启动 HTTPS 隧道

临时测试时，在另一个终端保持以下命令运行：

```bash
cloudflared tunnel --url http://127.0.0.1:7676
```

复制它输出的 HTTPS origin，例如 `https://random-name.trycloudflare.com`。
初始化时不要追加 `/mcp`。

### 3. 初始化并启动

```bash
cd ~/tools/devspace
node dist/cli.js init
node dist/cli.js serve
```

初始化向导会询问：

- 需要批准的 Project 所在的窄范围根目录；
- 本地端口，通常为 `7676`；
- 公网 HTTPS origin，不含 `/mcp`。

保存初始化时显示的 Owner 密码。批准 ChatGPT OAuth 连接时需要它，存储的验证值
无法恢复明文密码。

默认配置和状态位置：

```text
~/.devspace/config.json
~/.devspace/auth.json
~/.local/share/devspace/
```

### 4. 检查就绪状态

```bash
curl http://127.0.0.1:7676/readyz
curl https://random-name.trycloudflare.com/readyz
node dist/cli.js doctor
```

服务就绪时，两个 readiness 请求都应返回 HTTP `200`。

### 5. 连接 ChatGPT 网页版

在 ChatGPT 中启用开发者模式并创建自定义 MCP App：

1. 使用公网 origin 加 `/mcp`，例如
   `https://random-name.trycloudflare.com/mcp`。
2. 选择 OAuth，并检查请求的能力。
3. 输入 Owner 密码，选择此连接允许使用的 Project。
4. 完成授权、扫描工具，然后在对话中选择此 App。

对外 OAuth scope 只有：

- `project:read`：发现 Project、加载指令和 Skill、读取、检查与审阅变更；
- `project:write`：应用补丁；
- `process:execute`：运行本地命令并与进程交互。

DevSpace 只有一个隐藏的本地 Owner，但允许多个 OAuth grant 同时有效，包括同一个
OAuth client 下的多个授权。每个 bearer 只解析到自己的 grant、scope 和已批准
Project；新增或重新授权不会替换其他账号/连接的 grant。

临时隧道地址变化后，更新公网 origin 并重新启动服务：

```bash
node dist/cli.js config set publicBaseUrl https://new-random-name.trycloudflare.com
node dist/cli.js serve
```

随后更新 ChatGPT App endpoint 并重新授权。长期使用建议配置稳定域名。隧道只应
转发 DevSpace 服务端口，绝不能转发本地管理或控制端口。

ChatGPT 可能缓存工具快照。DevSpace 工具定义变化后，请重新扫描或重建 App。

## 对话内工作流

每次调用都必须通过当前 OAuth bearer grant 的权限检查。ChatGPT 提供匿名
`openai/subject`、`openai/organization` 或 `openai/session` 时，DevSpace 只保存这些值的
HMAC 引用，用于长期 Actor 所有权和当前对话到 Thread 的绑定，不保存原始标识，也拿不到
完整 ChatGPT 对话记录或隐藏 reasoning。

1. 同一个 ChatGPT 对话继续任务时，先调用
   `project_control({"action":"resolve"})`。只有完全相同的匿名 session 才会解析现有
   Thread；DevSpace 不按最近使用时间自动选择。
2. 只有一个已批准 Project 且没有 session binding 时，直接调用
   `project_control({"action":"open","operationId":"..."})`；不要先调用 `list_projects`。
3. 有多个 Project 时，先用 `list_projects` 获取不透明 `projectRef`，再调用
   `project_control`。使用 `action=list` 查看当前 OAuth grant 私有的可恢复 Thread，
   使用 `action=resume` 和明确的 `threadRef` 继续任务；DevSpace 不按最近使用时间猜测。
4. 保存 `project_control` 返回的 `executionRef`，后续每个 Project 工具都显式传入它。
5. 阅读紧凑根指令增量；用 `read_files` 或 `inspect` 获取目标内容和新出现的嵌套指令。
6. 相关时用 `skills` 延迟加载一个 Skill；应用小补丁、用 `show_changes` 审阅，再运行
   最小范围验证。长任务或准备换新对话时，用 `save_progress` 保存一个精简任务快照。

`project_control(action=open, projectRef, operationId)` 默认把逻辑 execution 绑定到已批准
Project 的原目录。对 Git 顶层 Project，可显式传 `checkoutKind:"worktree"` 创建受管
Thread worktree；每个活动 worktree Thread 独占一个可写目录。优先使用 `action=pause`、
`archive` 或 `complete`，这些动作保留 checkout。dirty worktree 不会被自动删除；旧的
`action=close` 仅保留兼容用途。非 Git Project 继续使用 checkout。
相同请求重试返回同一个 execution，不会重复创建 worktree。

`executionRef` 不属于某个 ChatGPT 对话。重连或服务重启后可继续把它传给普通工具，
也可用 `project_control({"action":"hydrate","executionRef":"..."})` 显式恢复。它只能由创建它的原始 grant
使用；其他账号/连接即使拿到引用也不能访问。原始 grant 被撤销或过期、Project 被取消
授权或 Project 路径失效时，该 execution 会被拒绝。grant 撤销也会终止该 execution
中仍受跟踪的进程，并清理进程输出和 review 临时状态；它不会删除 Project 文件，也
不会改动 Git branch、commit 或 worktree。

`save_progress` 不保存完整聊天记录，而是为当前私有 Thread 保存一个最多 8 KiB 的模型摘要。
标题与进度的 JSON 序列化结果还必须小于 12,000 字节，避免大量转义字符让恢复响应
超过上下文预算。首次保存不带 `ifMatch`；更新时必须带当前 Thread `version`。
`project_control(action=resolve)` 可解析同一 ChatGPT session 已绑定的 Thread；新对话仍需
`action=list` 后明确 `resume`。继续任务总会创建一个受当前 grant 授权的新 execution。
Thread 归属于匿名 Actor，而不是一次 grant；重新授权后只有当前 grant 仍批准对应 Project
时才能恢复。checkpoint 中的服务器观测字段具有 `server_observed` provenance，
模型摘要仍标记为 `untrusted`，恢复后必须重新读取相关文件。

DevSpace 另行保存 append-only Task Journal 和 Task Snapshot，只记录服务器可验证的补丁、
命令结果、生命周期与工作状态，不伪造 ChatGPT 用户消息、助手消息、reasoning 或 compaction。

`show_changes` 只在 Project 根本身就是 Git 顶层目录时读取当前 Git 工作区差异，并且
不会写 index、object 或 ref；嵌套在更大仓库中的 Project 按非 Git 处理，避免越过
批准根。非 Git 结果是当前逻辑 context 中成功 `apply_patch` 原始请求的有界、持久化
日志，不包含命令或外部编辑；日志达到上限时，新建逻辑 context 即可继续，共享目录
不会变化。

## 模型可见工具

公开工具词汇固定为 11 个名字；未授权 scope 对应的工具不会可用：

```text
list_projects
project_control
save_progress
read_files
inspect
skills
apply_patch
show_changes
exec_command
write_stdin
read_process_output
```

`exec_command` 只有同时授予 `project:write` 和显式高信任
`process:execute` 时才出现。它使用 Codex 风格输入：

```json
{
  "executionRef": "pex1_...",
  "operationId": "command-2026-07-30-001",
  "program": "npm",
  "args": ["test", "--", "--runInBand"],
  "workingDirectory": ".",
  "environment": {"CI": "1"},
  "yieldTimeMs": 10000,
  "maxOutputTokens": 12000,
  "tty": false
}
```

`workingDirectory` 必须解析到该 execution 所绑定的 checkout/worktree 内。只有确实需要
管道、重定向或循环等 Shell 语法时才传 `shell:true`、`command` 和 `approvalReason`。
命令仍拥有 DevSpace OS 用户的完整文件和
网络权限。`write_stdin` 只用于输入、关闭、终止或调整交互进程，是必须带
`operationId` 的变更操作；实时轮询和保留输出读取都使用只读的
`read_process_output`。

工具 schema 定义的变更操作使用 `operationId` 防重放；文件编辑使用版本前置条件
`ifMatch` 防止陈旧写入。根锁协调并发写入和命令。工具与进程输出都有大小限制，
保留的进程状态会按服务限制清理。工具返回 continuation cursor 时，后续调用继续传
同一个 `executionRef` 和 cursor，但不重复初始查询或分页参数。

## 本地管理

启动仅回环地址可访问的管理面板：

```bash
node dist/cli.js admin
```

常用命令：

```bash
node dist/cli.js doctor
node dist/cli.js config get
node dist/cli.js audit --limit 100
```

管理面板显示 Project execution 的状态诊断。`doctor` 以只读方式输出状态库中的
execution 总数和 open/terminal 状态。Thread/checkpoint 使用独立的
`project-threads.sqlite`；受管 worktree 位于 DevSpace 私有状态目录下。

`GET /healthz` 用于存活检查，`GET /readyz` 用于就绪检查。不要把凭据、
`auth.json`、内部控制 token 或隧道凭据写入仓库或日志。

## 开发

```bash
npm ci
npm run build
npm test
npm run typecheck
```

以 `package.json` 中的仓库脚本为准。

## 更多文档

- [ChatGPT 编程工作流](./docs/chatgpt-coding-workflow.md)
- [ChatGPT 工具契约](./docs/chatgpt-tool-contract.md)
- [配置参考](./docs/configuration.md)
- [安全模型](./docs/security.md)
- [常见问题](./docs/gotchas.md)
- [真实 ChatGPT host 验收](./docs/chatgpt-host-acceptance.md)
