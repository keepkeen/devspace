<p align="center">
  <strong>简体中文</strong> · <a href="./README_EN.md">English</a>
</p>

<p align="center">
  <img src="./docs/assets/devspace-logo-light.png" alt="DevSpace" width="136">
</p>

<h1 align="center">DevSpace</h1>

<p align="center">
  让 ChatGPT 在你批准的本地项目里读代码、改文件、运行测试。
</p>

<p align="center">
  <a href="https://github.com/keepkeen/devspace/blob/main/LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2f6f44?style=flat-square"></a>
  <img alt="Node.js 22.19–26" src="https://img.shields.io/badge/node-%3E%3D22.19%20%3C27-3f6b45?style=flat-square&logo=node.js&logoColor=white">
  <img alt="MCP Streamable HTTP" src="https://img.shields.io/badge/MCP-Streamable_HTTP-343a40?style=flat-square">
</p>

> [!IMPORTANT]
> 这是 [Waishnav/devspace](https://github.com/Waishnav/devspace) 的社区增强分支，
> 基于上游提交 [`80423b5`](https://github.com/Waishnav/devspace/commit/80423b5)，
> 由 [keepkeen/devspace](https://github.com/keepkeen/devspace) 独立维护。

## DevSpace 是什么

ChatGPT 在云端，不能直接打开你电脑上的 `/Users/alice/code/my-app`。
DevSpace 在本机运行一个 MCP 服务，把你批准的目录变成文件、搜索、补丁、Git 和命令工具。

它不会先上传整个仓库，也不是藏在后台的第二个编码模型。只有工具调用实际返回的内容
会发送给 MCP 客户端，调用过程会显示在对话里。

```text
ChatGPT → HTTPS Tunnel → DevSpace 127.0.0.1:7676 → 已批准的本地项目
                              └→ 本地管理面板（仅 localhost）
```

## 推荐目录与工作目录

建议把“程序、项目、状态”分开：

```text
~/tools/devspace/                 # DevSpace 安装目录
~/code/work/                      # 工作项目根目录，可单独授权
~/code/personal/                  # 个人项目根目录，可单独授权
~/.devspace/                      # config.json、auth.json、managed worktrees
~/.local/share/devspace/          # SQLite、操作记录、进程输出元数据
```

几个容易踩坑的点：

1. `devspace init` 默认把**当前工作目录**当作允许根目录。准备直接按回车时，先
   `cd ~/code/work`；更稳妥的做法是明确输入路径。
2. 不要授权 `~`、`/`、整个云盘或包含大量私密资料的目录。工作和个人项目最好分开授权。
3. 一般把 DevSpace 安装在允许根目录之外。只有开发 DevSpace 本身时，才需要把它作为项目打开。
4. 配置中明确写好 `allowedRoots` 后，`devspace serve` 从哪里启动不再决定授权范围。
   服务管理器仍建议使用绝对 CLI 路径，并把 WorkingDirectory 设为 DevSpace 安装目录。
5. 项目命令默认在当前 Workspace 根目录运行。`workingDirectory` 只用于 Workspace 内的子目录，
   不能借它跳到项目外面。

## 快速开始

### 1. 安装

需要 Node.js `>=22.19 <27`、npm 和 Git。安装、构建和长期运行应使用同一个 Node 版本，
因为 `better-sqlite3` 与 Node ABI 相关。

```bash
git clone https://github.com/keepkeen/devspace.git ~/tools/devspace
cd ~/tools/devspace
npm ci
npm run build
node dist/cli.js --help
```

可选：

```bash
npm link
devspace --help
```

### 2. 初始化

```bash
node dist/cli.js init
```

向导会询问：

- 允许访问的项目根目录；
- 本地端口，默认 `7676`；
- 公网 HTTPS 地址，不要带 `/mcp`。

普通配置与安全凭据分开保存：

```text
~/.devspace/config.json
~/.devspace/auth.json
```

`auth.json` 只保存 Owner 密码的 Argon2id 校验值、独立随机 master key 和派生模式，
不保存可恢复的明文密码。初始化时请保存向导一次性显示的 Owner 密码。不要分享或提交
`auth.json`，其中的 master key 会派生本机身份、授权根、cursor、receipt 和内部控制令牌。
旧版升级使用 `legacy-direct` 保持既有标识稳定；如果文件迁移完成而 SQLite 仍是旧 verifier，
下次启动会同时校验旧 scrypt 与新 Argon2id，匹配时原位升级并保留现有 OAuth token。

### 3. 启动并检查

```bash
node dist/cli.js serve
curl http://127.0.0.1:7676/readyz
```

正常时返回 HTTP `200`，并包含：

```json
{"ok":true,"name":"devspace","status":"ready"}
```

安装或原生依赖有问题时：

```bash
node dist/cli.js doctor
```

`doctor` 还会有界扫描批准的根目录，提示超过 8 KiB 的指令文件或单行、接近 32 KiB 的
有效指令链、重复模板，以及适合下沉到子目录 `AGENTS.md` 的根规则。

### 4. 建立 HTTPS 入口

ChatGPT 不能直接连接本机端口，需要 HTTPS Tunnel 或反向代理。临时测试示例：

```bash
cloudflared tunnel --url http://127.0.0.1:7676
node dist/cli.js config set publicBaseUrl https://random-name.trycloudflare.com
```

长期使用请配置固定域名。Tunnel 只转发 DevSpace 服务端口，不要暴露本地管理面板。

### 5. 连接 ChatGPT

在 ChatGPT 中启用 Developer mode 并创建自定义 MCP App：

1. Endpoint 填 `https://devspace.example.com/mcp`。
2. 选择 OAuth，然后扫描工具。
3. 在 DevSpace 页面输入初始化时保存的 Owner 密码；`auth.json` 不能反推出该密码。
4. 密码通过后，选择创建或复用本地 principal，并勾选这个授权能访问的根目录。
5. 扫描完成后创建 App，在新对话中选择它。

ChatGPT 的界面、套餐和写入权限会变化，请以
[OpenAI 的 Developer mode 与 MCP App 说明](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
为准。DevSpace 工具定义变化后，需要在 ChatGPT 里重新扫描或刷新；只重启本地服务不会
刷新 ChatGPT 的工具缓存。

`DEVSPACE_TOOL_PROFILE=browse` 固定暴露 9 个生命周期、读取和检查工具；默认的
`coding` profile 再按 OAuth scope 加入 Skill、写入、进程、worktree、状态与撤销工具。
profile 在服务创建时固定，修改后应重新连接或刷新工具，不能依赖对话中途改变 tools/list。

## 启动和停止时发生了什么

`devspace serve` 的启动顺序是：

1. 按 `package.json#engines.node` 检查 Node 版本。
2. 检查配置是否存在。环境变量优先于 `config.json` 和 `auth.json`，后者再覆盖默认值。
3. 试加载 `better-sqlite3`，提前发现 Node ABI 不匹配。
4. 获取本地状态目录的单实例租约，避免两个后端同时写同一份状态。
5. 打开并迁移 canonical v16 数据库；上次异常中断的 `pending` 操作会恢复为
   `outcome_unknown`，不会被假装成“没执行”。
6. 初始化 OAuth、Workspace、进程、输出、审计和本次进程的唯一 generation。
7. `/readyz` 只有在服务未关闭、Workspace 数据库和 OAuth 数据库都就绪时才返回 `200`。

`/healthz` 只表示进程活着；排障和服务管理应优先检查 `/readyz`。

收到 `SIGINT` 或 `SIGTERM` 后，DevSpace 先停止接收新工作，再等待 HTTP 请求排空、关闭进程和
数据库。macOS 受控重启还会验证 **PID 和 readiness generation 都发生变化**，而不是只看命令
有没有返回成功。

## 对话中的工作流程

第一次处理项目时，可以直接说：

```text
使用 DevSpace。
把 /Users/alice/code/my-app 打开为别名 my-app，并允许修改。
读取项目指令，找出失败测试并修复，运行最小范围验证，最后总结改动。
```

实际流程是：

1. `open_workspace` 只接受本次 OAuth grant 允许的根目录。只是选项目时返回 metadata；
   立即分析或编辑时使用 full context。
2. `get_workspace_context` 加载 Workspace 清单和版本，不自动把所有项目指令与 Skill 正文塞进对话。
3. 处理具体文件前，`load_workspace_instructions(paths)` 只加载对目标路径生效的指令；
   大文件使用签名的 UTF-8 安全 8 KiB 片段，最后一页才返回 instruction token。
4. `read` 返回内容和版本；`apply_patch` 必须带 `ifMatch`，防止覆盖外部编辑。
5. 每个写操作使用唯一 `operationId`。响应丢失时先查状态，不要直接重做。
6. 命令优先使用 `program + args`；只有管道、重定向等 shell 语法才使用
   `shell: true + command`。
7. 长命令可以后台运行，输出和操作状态持久化保存。

默认 MCP HTTP 是 stateless。ChatGPT 对话结束或服务重启后，网络连接、内存 binding 和旧 receipt
会失效，但下面的信息仍在 SQLite 中：

- alias 和 `workspaceRef`；
- checkout/worktree 类型和写权限；
- 项目指纹、generation、操作状态与进程输出元数据。

新对话或重启后这样恢复：

```text
使用 DevSpace。先列出已保存的 Workspace，再恢复别名 my-app。
不要重新打开本地路径，也不要自动选择最近使用的 Workspace。
```

也就是 `list_workspaces → resume_workspace`。恢复会签发新的 context 和 receipt；旧连接失效不代表
项目记录丢失。

## Checkout 还是 Worktree

| 场景 | 建议 |
| --- | --- |
| 只读检查当前目录 | `checkout` + `read_only` |
| 明确修改当前目录 | `checkout` + `read_write` |
| 并行任务、实验性修改 | managed `worktree` |
| 两个 principal 同时写同一仓库 | 每个 principal 使用独立 worktree |

一个长期任务使用一个清楚的 alias，例如 `billing-api-auth-fix`。ChatGPT 的“对话分支”不是 Git
分支；需要文件隔离时必须使用真正的 worktree。

## 权限与安全

OAuth grant 可以分别授予：

| Scope | 能力 |
| --- | --- |
| `workspace:read` | 打开、读取、搜索、查看指令和改动 |
| `workspace:write` | 修改文件和推进 review checkpoint |
| `process:execute` | 启动和操作本地进程 |
| `network:access` | 让命令继承主机网络 |
| `worktree:create` | 创建 managed worktree |
| `workspace:revoke` | 关闭或撤销 Workspace |

每个 OAuth grant 还绑定允许根目录；全局允许列表不是所有账户共享的通行证。

> [!WARNING]
> `exec_command` 仍以运行 DevSpace 的系统用户身份执行。命令策略是防误操作护栏，不是操作系统沙箱。

默认没有进程 sandbox，也不能可靠地逐进程断网。高风险项目应使用专用系统账号、容器或虚拟机。
DevSpace 会阻止明显的自我终止和自我重启命令；后端重启只能由本地 Admin control plane 发起。

## 管理和长期运行

```bash
node dist/cli.js admin
```

管理面板只监听 localhost，可以管理根目录、配额、Widget、诊断、Token 撤销和受控重启。
允许根目录可以热更新；大多数其他运行参数需要重启。

长期运行需要同时托管：

```text
DevSpace 服务 + HTTPS Tunnel
```

建议使用 launchd、systemd 或其他服务管理器，并使用固定域名。macOS 受控重启需要给 Admin
进程配置同一个固定 label：

```bash
DEVSPACE_LAUNCHD_SERVICE_LABEL=com.example.devspace node dist/cli.js admin
```

常用检查：

```bash
curl http://127.0.0.1:7676/readyz
curl https://devspace.example.com/readyz
node dist/cli.js doctor
node dist/cli.js audit --limit 50
```

## 开发和验证

```bash
npm ci
npm run typecheck
npm test
npm run test:browser
npm run build
npm run test:pack
```

`npm test` 会递归发现全部 `src/**/*.test.ts`，当前为 **59 个测试文件**。运行器会打印发现数量，
并在任何已发现测试没有完成时失败，不再依赖容易漏文件的手写名单。

浏览器测试单独运行。`test:pack` 会构建 npm 包、安装到干净临时项目、检查中英文 README、
运行 CLI/SQLite/服务烟测，并执行生产依赖审计。

## 常见问题

**本地 `/readyz` 失败**：查看 DevSpace 日志，运行 `doctor`，确认没有第二个后端占用同一状态目录。

**本地正常，公网失败**：检查 Tunnel、域名和 ingress；公网 URL 应指向 DevSpace 服务端口。

**`better-sqlite3` 无法加载**：安装和运行使用了不同 Node ABI。切回正确 Node 后执行：

```bash
npm rebuild better-sqlite3
node dist/cli.js doctor
```

**新 App 看不到旧 Workspace**：先检查授权时是否复用了正确 principal；再用
`devspace auth principals` 和 dry-run 的迁移命令处理历史 orphan principal，不要重新打开路径碰运气。

## 升级

升级前先停止 DevSpace，并备份整个状态目录，默认是 `~/.local/share/devspace`。不要只复制主 SQLite
文件，因为进程输出和其他持久化元数据也属于状态。启动新版本后等待 canonical v16 迁移完成，
再检查 `/readyz` 并刷新 ChatGPT App 工具。

## 更多文档

- [配置参考](./docs/configuration.md)
- [安全模型](./docs/security.md)
- [ChatGPT 编码工作流](./docs/chatgpt-coding-workflow.md)
- [真实宿主验收矩阵](./docs/chatgpt-host-acceptance.md)
- [故障排查](./docs/gotchas.md)

DevSpace 由 [Waishnav](https://github.com/Waishnav) 创建。本分支保留原项目历史和
[MIT 许可证](./LICENSE)。
