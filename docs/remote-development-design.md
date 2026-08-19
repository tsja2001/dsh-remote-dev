# DeepSeek Harness 远程开发（Remote Dev）功能设计方案

> 版本：v1（草案）
> 范围：SSH 连接远端设备，在远端指定目录上进行完整开发（读写文件、执行命令、跑终端、起 dev server、浏览器预览），对标 Codex CLI / Claude Code 的 SSH Remote 能力。
> 定位：本文档是"因地制宜"的设计方案 —— 先盘点 DeepSeek Harness（下文简称 DSH）已有的能力与惯例，再推导新功能如何**长在**这些惯例上，而不是另起炉灶。

---

## 0. TL;DR

- **核心命题**：DSH 的"能力缝（capability seam）"哲学意味着远程开发**不需要新增一套远程工具**。`read/write/edit/bash/terminal/job_*/subagent` 全部原样复用，只需把 `ctx.fs` / `ctx.subprocess` / `ctx.terminals` / `ctx.shell` 四个 seam 的 Provider 换成 SSH 实现 —— 这正是 `docs/architecture.md` 中已经写明的机制：*"Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks."*
- **现成先例**：DSH 已经有一个完整的"远程执行世界"实现 —— E2B（`@deepseek-ai/dsh-e2b` 连接服务 + `dsh-fs-e2b` 文件后端 + `dsh-subprocess-e2b` 进程/终端后端）。SSH Remote 是第二个 Transport，复用同一套后端抽象。
- **与 Codex/Claude Code 的本质差异**：DSH 的模型调用留在本地（API key 不外泄），**远程化的是"执行世界"**（文件、命令、终端），而不是"agent 进程"。LLM 路由、审批栈、持久化、子代理编排全部留在 Host。
- **落地形态**：一组 Cordis 插件行。连接服务进 Host 组合（跨会话共享）；会话绑定与工具进 Agent Preset（每会话）；UI 通过 Client Slot + 包私有 RPC 呈现。
- **分四期交付**：M1 连接 + 远程 fs/subprocess 后端（工具无缝跑通）→ M2 绑定、沙箱语义与审批 → M3 前端（连接管理、目录浏览、终端、预览）→ M4 高级（文件事件、LSP、多 transport）。
- **开源与分发（§9）**：独立仓库 + 镜像上游包规范（seam 拆包、npm 发布、`dsh-plugin` topic、MIT），三种共享粒度（npm 插件包 / Agent Preset / Skill），远端零安装、本地侧一键装配。

---

## 1. 背景与需求

### 1.1 需求

- 用户通过 SSH 连接一台其他设备（服务器、开发机、树莓派……）。
- 在远端设备的**指定文件夹**上进行开发：读写代码、搜索、执行构建/测试、跑交互式终端、启动 dev server。
- 前端（DSH Web GUI）要有配套界面：连接管理、工作区切换、终端面板、端口预览等。
- 对齐 Codex CLI（`--ssh`）与 Claude Code（`/remote`）的体验。

### 1.2 设计目标

| 目标 | 说明 |
|---|---|
| 零工具重写 | 模型侧工具（read/write/edit/bash/glob/grep/terminal）不感知远程，换 Provider 即换执行世界 |
| 一个执行世界 | 文件、命令、终端、LSP 必须在**同一台远端机器**上，路径语义一致（杜绝"本地读文件、远端跑命令"的错位） |
| 审批栈复用 | 远程操作走现有的 `dsh-user-approval` 与沙箱模式，只是请求上下文携带远程身份 |
| 配置即资产 | 连接配置持久化、可分享、可版本化；认证资产（密钥）绝不明文入库 |
| 会话继承 | 子代理、workflow、goal 在远程会话中照常工作，绑定随 session 树传播 |

### 1.3 非目标（v1）

- 远程 GUI 编辑器/代码智能的完整重实现（LSP 远程化列为远期）。
- Windows 远端（v1 仅 POSIX 远端；Windows 的路径与 shell 语义差异单列）。
- 多人协作、远程机器间的多跳工作区同步。
- 把整个 agent 进程搬上远端（见 §2.4 的架构立场）。

---

## 2. DSH 设计灵魂 → 方案推导

本节是全文的"思想地基"：每条 DSH 惯例都直接决定远程开发的一个设计决策。括号内是代码事实出处。

### 2.1 能力缝（Seam）：Service Definition + Provider + Consumer

`docs/architecture.md` 明确定义：**缝（seam）= 可替换的能力，一个 Service Definition 声明接口、一个 Provider 实现、一个 Consumer 使用（通常是模型工具）**。一个缝换 Provider，整个产品跟着换。

> 映射：远程开发 = 给 `ctx.fs`、`ctx.subprocess`、`ctx.terminals`、`ctx.shell` 四个缝各写一个 SSH Provider。Consumer 层（tool-fs、tool-bash、tool-terminal）**一行不改**。

### 2.2 一切是插件行（Cordis 组合）

任何能力都是 `cordis.yml` 里的一行；行为由组合决定。Agent Preset 是"每个会话挂一份"的组合文件（`packages/preset/agent-presets`，`agent-preset/selected` 事件、`isolate` realm 支持 preset 内的会话级服务）。

> 映射：远程功能 = 一组明确的行：
> - Host 组合：连接服务 + 三个后端（跨会话共享，引用计数管理连接生命周期）；
> - Agent Preset：会话绑定 + 少量远程工具 + prompt 指导段，**只在 isolate realm 提供会话级 `ctx.fs`**，这样"绑定远程的会话"与"本地会话"可并存于同一进程。

### 2.3 观察-守卫-版本的文件语义

`ctx.fs` 抽象（`packages/fs/fs/src/index.ts`）要求：`resolve()` 产生不透明 `FsTargetKey`（注释明言："a remote backend might use a workspace URI or file id"）、`FsVersion` 新鲜度令牌、`fs/observed` 观察记录、写/编辑的版本守卫（`FS_STALE_VERSION`）、错误码词汇表（`FS_NOT_FOUND`…`FS_ABORTED`）。E2B 后端用 `stat` 事实哈希 + 私有 staging 目录 + 原子 rename 完整实现了这套语义（`packages/e2b/fs-e2b/src/index.ts`）。

> 映射：fs-ssh 后端逐条复刻这套语义：版本指纹 = 远端 `stat`（size/mtime/mode/inode）哈希；原子写 = 远端 `.dsh-*.tmp` staging + `rename`；读写前观察策略（`fs-observation-policy`）无需改动，因为它消费的是统一接口。**这保证了 read-before-edit、stale 保护在远程同样成立。**

### 2.4 一个执行世界（E2B 范式）

`ctx.e2b` 是"共享一个远程 Linux 世界的所有者"：`fs-e2b` 与 `subprocess-e2b` 消费同一个 SDK 句柄，于是文件与进程天然同机。DSH 的模型路由、LLM 适配器、审批都留在 Host。

> 映射：SSH 版为 `ctx.remote`（连接所有者）+ `fs-ssh` + `subprocess-ssh` + `terminals-ssh`，共享同一连接对象（SSH ControlMaster 多 channel）。**模型调用留在本地**：密钥不离开 Host，这是相对 Codex/Claude Code（agent 进程整体在远端）的安全优势，也是 DSH"Host 持有注册表与共享服务"的平面划分的自然结果。

### 2.5 沙箱与审批：边界即会话工作区

`ctx.sandboxPolicy` 的语义是"会话 cwd = workspace-write 边界"，模式（`workspace-write` / `danger-full-access`）与审批策略（`ask`/`never`）联动（见 `examples/acp-agent/cordis.yml` 的注释）。`fs-sandbox` / `bash-sandbox` 是执行侧的围栏。

> 映射：远程会话的"cwd"是一个 `remote://` URI。远程侧没有强隔离（远程账号就是信任边界 —— 与 Codex/Claude Code 一致），所以围栏改为两层：**Host 侧**沿用现有审批栈，审批请求上下文携带远程身份（连接名、主机、路径）；**远程侧**用 wrapper 脚本尽力而为地限制命令 cwd 与写路径在绑定目录内（诚实标注：这是防呆，不是安全边界）。

### 2.6 持久化：SessionEventMap 与 storage 域

会话日志（`session-persistence-jsonl`/`sqlite`）可扩展（"Add durable session state → extend `SessionEventMap`"）；连接类配置属于 `ctx.storage` 域（`storage-json`/`storage-sqlite`）；工作区实体 `ctx.workspace` 的 `WorkspaceId` 是 uuid 而非路径（"path normalization rewrites paths, and a reference anchor must stay stable"）—— 天然支持远程路径标识。

> 映射：连接 profile 进 storage 域；会话绑定作为 session 事件进日志（恢复会话时重放）；`Workspace.path` 支持 `remote://` URI（在远程侧做 realpath 规范化）。

### 2.7 前端：Slot + 包私有 RPC + 可扩展 capability 联合

Client 插件在 Slot 里注册 UI，Client→Host 走 `host.call`/`harness.handle` 私有 JSON RPC；`ctx.directoryPicker` 的 capability 联合类型是"merge-extensible"的，且其 `browse` 后端"works for remote clients no OS dialog can reach"。

> 映射：连接面板/工作区指示/审批卡片全部是 Slot UI + RPC；目录选择直接给 `directoryPicker` 增加一个 `remote` capability（复用 `DirectoryListing`/`DirectoryEntry` 结构，浏览经 SSH 列目录）—— 现成的交互协议，不用发明新表单。

### 2.8 Skill 封装与 Agent 体验

DSH 用 Skill 封装"特定领域怎么干活"（lark-*、cua-driver……），工具注册时通过 `ctx.systemPrompt.section()` 注入使用指导。

> 映射：交付一个 `remote-dev` Skill（连接、诊断、绑定切换、端口转发、常见错误码），preset 里挂一行；工具注册处照 `applyReadTool` 的模式加 `remote:*` 工具的 prompt 段。

---

## 3. 现状盘点：DSH 里已经有什么（可复用清单）

| 现有资产 | 位置 | 对远程开发的价值 |
|---|---|---|
| `FileSystem` 抽象 + `fs/*` 事件 | `packages/fs/fs` | 后端接口定义；`FsTargetKey` 注释已预留远程 URI |
| `E2BFileSystem` | `packages/e2b/fs-e2b` | 远程后端实现的**完整范本**（原子写/版本/错误码） |
| `SubprocessRuntime` 抽象 | `packages/subprocess/subprocess` | 进程执行缝；e2b 已证明可远程化 |
| `subprocess-e2b`（process/terminal） | `packages/e2b/subprocess-e2b` | 远程进程组信号、输出轮询、PTY 生命周期范式 |
| `ctx.e2b` 服务 | `packages/e2b/e2b` | "共享连接所有者"服务模式：一个句柄喂多个 adapter |
| `ctx.sandboxPolicy` + `dsh-sandbox-local` + `dsh-sandbox-policy` | `packages/sandbox` | 沙箱模式与回退根；审批联动逻辑 |
| `dsh-user-approval` | 组合示例见 `examples/acp-agent/cordis.yml` | 审批策略 `ask/never`；请求上下文可扩展 |
| `ctx.directoryPicker`（native/browse/auto） | `packages/host/directory-picker` | browse capability 的列表/面包屑协议，可直接扩展 `remote` kind |
| workspace 实体 | `packages/workspace/workspace` | uuid 锚点 + 规范化 path，支持远程 URI |
| storage 域 | `packages/storage/*` | 连接配置持久化 |
| session 日志 + `SessionEventMap` | `packages/session/*` | 绑定事件的持久化与重放 |
| 子代理注册表（spawn/fork） | `packages/subagent`、`session-projection` | 绑定随 session 树继承的挂点 |
| Client 壳（Slot/RPC/主题） | `packages/client/*`、`apps/web` | 前端全部 UI 的挂载机制 |
| `ctx.commands`（人机命令） | 扩展点地图 | "连接/断开"等操作可不经模型，直接由 UI 驱动 |

**结论：不需要任何新基础设施，只需要四个新 Provider + 一个连接服务 + 绑定/UI/技能。**

---

## 4. 总体架构

### 4.1 概念模型

```
┌────────────────────────────── Host（本地进程）──────────────────────────────┐
│                                                                            │
│  LLM 路由 / 模型适配器          审批栈 dsh-user-approval                    │
│  ctx.sandboxPolicy            session 日志 / workspace 实体                │
│  subagent / workflow / goal   storage 域（连接配置）                        │
│                                                                            │
│  ┌─────────────── ctx.remote（连接所有者，跨会话共享）───────────────┐      │
│  │  profile 注册表 │ 连接状态机 │ ControlMaster 复用 │ 心跳/重连 │     │      │
│  └───────┬───────────────┬───────────────┬───────────────┬───────┘      │
│          │ sftp/exec     │ ssh exec      │ ssh -tt PTY   │ 转发          │
│   ┌──────▼─────┐  ┌──────▼────────┐  ┌────▼────────┐  ┌───▼─────┐        │
│   │ ctx.fs     │  │ ctx.subprocess│  │ ctx.terminals│  │ ctx.     │        │
│   │ fs-ssh     │  │ subprocess-ssh│  │ terminals-ssh│  │ ports-ssh│        │
│   └──────┬─────┘  └──────┬────────┘  └────┬────────┘  └───┬─────┘        │
│          │               │                │                │              │
│  模型工具（read/write/edit/glob/grep/bash/terminal/job_*）—— 零改动         │
└──────────┼───────────────┼────────────────┼────────────────┼──────────────┘
           │               │                │                │
        SFTP 文件      远程命令          交互终端        本地端口←→远程端口
┌──────────▼───────────────▼────────────────▼────────────────▼──────────────┐
│                      SSH 通道（ControlMaster 多路复用）                      │
│                    远端设备（POSIX）— 绑定目录 /srv/app                    │
└───────────────────────────────────────────────────────────────────────────┘
```

### 4.2 组件清单（Cordis 行草案）

**Host 组合（新行）：**

```yaml
# 连接所有者：ctx.remote —— profile 注册表、连接生命周期、认证、复用
- id: remote
  name: '@deepseek-ai/dsh-remote-ssh'
  config:
    controlMaster: auto            # 复用 ~/.ssh 的 ControlMaster 或自建 socket
    heartbeatMs: 30000
    reconnect: true

# 远程文件后端：ctx.fs 的 SSH Provider（resolve 按 cwd 的 remote:// scheme 分派）
- id: remote-fs
  name: '@deepseek-ai/dsh-fs-ssh'

# 远程进程后端：ctx.subprocess 的 SSH Provider
- id: remote-subprocess
  name: '@deepseek-ai/dsh-subprocess-ssh'

# 远程终端后端：ctx.terminals 的 SSH Provider（交互 PTY）
- id: remote-terminal
  name: '@deepseek-ai/dsh-terminals-ssh'

# 远程端口转发：ctx.ports —— dev server 预览隧道
- id: remote-ports
  name: '@deepseek-ai/dsh-ports-ssh'
```

**Agent Preset（每会话，仅绑定远程的会话挂载）：**

```yaml
# 会话绑定：本会话的执行世界 = remote://prod-server/srv/app
- id: remote-binding
  name: '@deepseek-ai/dsh-remote-binding'
  config:
    connection: prod-server
    path: /srv/app
  # isolate: 在 isolate realm 提供会话级 ctx.fs（覆盖宿主本地 backend），
  # 只影响本会话，不污染其他会话
```

### 4.3 与 E2B 的共存规则

`ctx.fs` / `ctx.subprocess` 是单例服务：**一个会话同时只能有一个执行世界**。绑定远程的会话由 preset 在 `isolate` realm 提供 SSH 后端；未绑定的会话继续用宿主默认（本地/E2B）。这是 `docs/architecture.md` 扩展点地图的既有答案：*"Give one session a different capability set → compose an agent preset; a service row there needs an `isolate` realm."*

---

## 5. 核心设计

### 5.1 连接服务 `ctx.remote`（Host）

镜像 `ctx.e2b` 的"共享所有者"模式，但面向通用 SSH：

```ts
interface RemoteProfile {
  id: string                  // 稳定标识（uuid），非主机名
  title: string               // 显示名，如 "prod-server"
  host: string                // host 或 ~/.ssh/config 中的别名
  user?: string               // 缺省读 ~/.ssh/config / 当前用户
  port?: number
  // 认证来源（按序尝试，绝不存密码）：
  //   1. ~/.ssh/config（含 ProxyJump、IdentityFile、别名展开）
  //   2. ssh-agent 代理
  //   3. 指定密钥路径（引用文件，不复制内容）
  identityFile?: string
  jumpHost?: string           // 跳板机（ProxyJump）
  bindPath: string            // 默认绑定目录（可被会话覆盖）
}

interface RemoteSession {
  readonly profile: RemoteProfile
  readonly status: 'connecting' | 'ready' | 'degraded' | 'closed'
  // 供 fs/subprocess/terminals/ports 四个 adapter 消费的句柄：
  exec(argv: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>
  sftp(): Promise<SFTPHandle>                       // 文件操作通道
  pty(opts: PtyOpts): Promise<PTYHandle>            // 交互终端通道
  forward(localPort: number, remoteHost: string, remotePort: number): Promise<ForwardHandle>
  realpath(path: string): Promise<string>           // 远程侧规范化（绑定路径的权威解析）
  close(): Promise<void>
}
```

设计要点：

- **连接状态机**：`connecting → ready ⇄ degraded → closed`。`degraded` 表示网络抖动/重连中，操作排队或快速失败（`FS_IO_ERROR` 带 `remote:reconnecting` 上下文），重连成功自动恢复。心跳 = 轻量 `echo`/通道 keepalive。
- **ControlMaster 复用**：优先复用用户 `~/.ssh/config` 已有的 `ControlMaster`；否则在 `$DSH_HOME/run` 下自建 socket，多会话共享一条 TCP 连接（引用计数，最后一个会话断开才关）。
- **配置持久化**：profile 存 storage 域（`remote.connections.<id>`）；**密码字段被 schema 拒绝** —— 认证只接受 ssh-agent、密钥文件引用、`~/.ssh/config`。首次连接记录 `known_hosts` 指纹并在 UI 展示。
- **profile 来源**：DSH 存储中的 profile 为一级公民；同时提供"读取 `~/.ssh/config` 别名"的只读视图（不复制、不迁移，避免双份配置漂移）。
- **事件**：`remote/status(profileId, status)`、`remote/command-request(...)`（见 §5.4 审批）。

### 5.2 远程文件后端 `fs-ssh`（Host，实现 `FileSystem`）

逐条对照 `FileSystem` 抽象（`packages/fs/fs/src/index.ts`）与 `E2BFileSystem` 范本：

| 抽象方法 | fs-ssh 实现 |
|---|---|
| `resolve(path, {cwd})` | 解析 cwd：若为 `remote://<profile>/<abs>` 则取对应连接，否则视为本地路径原样放行（**按 cwd 分派**：同一 ctx.fs 服务本地与多个远程会话）。远程路径经 `remote.realpath()` 规范化后得到 `targetKey = remote://<profile>/<canonical>` |
| `processPath(target)` | 远端绝对路径（供远程子进程直接使用） |
| `fileUrl(target)` | 执行世界内的 `file://` URI（远程侧有效，与 E2B 语义一致） |
| `contains(parent, child)` | posix 相对路径判断（远程路径天然 posix） |
| `stat/lstat` | SFTP `stat` → `FsInfo`/`FsPathInfo`（type/size），版本指纹 = `sha256(size|mtimeMs|mode|ino)` |
| `readText/readBytes/streamText` | SFTP 流式读；二进制/非 UTF-8 按 `FS_NOT_TEXT` 拒绝（复刻 E2B 的采样逻辑） |
| `listDir` | SFTP 列目录，返回已解析子 target + 元数据 |
| `writeText/editText` | 复刻 E2B 原子写：私有 `.dsh-<uuid>.tmp` staging 目录（chmod 700）→ 写入 → `rename` 发布；`createIfAbsent` 用 `ln -T` 守卫；版本守卫在写前校验（`FS_STALE_VERSION`）；staging 清理失败吞掉 |
| `sandboxMode` | 返回绑定目录的围栏语义（见 §5.4） |

要点：

- **路径显示**：`displayPath` 用 `host:/abs/path`（scp 风格）或完整 `remote://` URI，UI 与模型输出都清晰可辨；模型 prompt 中明确"当前工作区在 `prod-server:/srv/app`"。
- **性能**：SFTP 单次往返；目录列表小缓存（TTL ~1s，绑定目录内）；大文件 `streamText` 流式，不整读。
- **并发**：同文件锁复刻 `E2BFileSystem.withLock`（per-targetKey 串行化写）。
- **断连语义**：`degraded` 期间写操作快速失败并附 `remote/reconnecting` 上下文，不静默重试（避免"看似成功实则没落盘"）；重连后版本守卫自然兜住 stale 场景。

### 5.3 远程进程与终端后端（Host）

**`subprocess-ssh`（实现 `SubprocessRuntime`）**：

- 执行 = 单条 SSH exec（非交互），argv 经严格引用（复刻 `quoteE2BShellArg` 的防注入模式，但用 POSIX shell 语义）；cwd = `processPath(target)`。
- 输出流式回传（stdout/stderr 分通道）；超时/中断 → 远程进程组信号（复刻 `subprocess-e2b` 的 pgid 阶梯：TERM→KILL）。
- 环境控制：注入 `DSH_REMOTE=1`、`DSH_REMOTE_PROFILE`、`DSH_BIND_ROOT`，让远端 wrapper 与工具感知执行世界。
- 沙箱包装：`bash-sandbox` 的 argv 包装逻辑在远程侧等价物 —— 远端 wrapper 脚本（部署在绑定目录或 `$DSH_HOME` 远端副本）校验 `cwd` 在绑定根内、写路径在绑定根内（见 §5.4 的威胁模型）。

**`terminals-ssh`（实现 ctx.terminals）**：`ssh -tt` 分配 PTY，复用 `subprocess-e2b` 的 sid 阶梯信号与输出轮询；GUI 终端面板直接消费现有 terminal 工具与渲染。

**`ports-ssh`（ctx.ports）**：SSH 反向转发 —— 远端 dev server 的端口映射到本地 `127.0.0.1:<port>`，UI 提供"打开预览"按钮（新开浏览器标签访问本地映射端口）。这是 Codex/Claude Code 里最常用的功能之一，v1 必须带。

### 5.4 会话绑定、沙箱语义与审批

**绑定**：

- 会话头新增 `workspace` 字段支持 `remote://<profile>/<path>`；绑定动作写 session 日志（扩展 `SessionEventMap`，如 `session/remote-bound`），会话恢复时重放并重连。
- `ctx.workspace` 实体扩展：`Workspace.path` 允许 `remote://` URI（realpath 在远程侧做）；`WorkspaceId` 保持 uuid 锚点不变 —— 这是对现有包的**温和扩展**（新增 union 类型 + 远程 realpath provider），不破坏本地语义。
- **继承规则**：fork 子会话天然继承父会话头（绑定随行）；spawn（fresh child）由 `session-projection` 传入绑定；workflow 的 agents 同样继承。goal/Ralph 无感知。

**沙箱模式映射**（`ctx.sandboxPolicy`）：

| 本地语义 | 远程语义 |
|---|---|
| `workspace-write`：cwd 内自由，cwd 外拒绝/审批 | 绑定目录内自由；目录外操作 → 审批（`ask`）或直接拒绝（`never` 时） |
| `danger-full-access` | 绑定目录外也放行（等同远程账号全权）—— 但 UI 明示"远程无强隔离" |

**审批上下文扩展**：`dsh-user-approval` 的请求负载增加：

```ts
interface ApprovalContext {
  remote?: {
    profileId: string
    host: string
    bindPath: string
    command?: string      // 远程命令（如有）
    targetPath?: string   // 越界文件路径（如有）
  }
}
```

UI 审批卡片据此渲染"主机、路径、命令"三要素，杜绝"本地审批弹窗不知道在审什么"。

**威胁模型（诚实声明）**：SSH 远程的信任边界是**远程账号本身**。wrapper 脚本是防呆不是安全边界（同一账号可绕过）；真正的控制是 Host 侧审批 + 密钥资产管理 + 审计日志。这与 Codex/Claude Code 的 remote 一致 —— 它们在远端同样没有强沙箱。文档中要写进"安全模型"章节（§5.6）。

### 5.5 前端设计（Client）

全部通过 Client Slot + 包私有 RPC 实现（实现时先用 `cordis_inspect_list` / `Slots.listSubTree` 查实际 Slot 树，以下为功能清单，Slot 名以实际注册为准）：

| UI | 功能 | 数据来源（host.call 方法） |
|---|---|---|
| 连接面板（侧栏/设置页 Slot） | profile 增删改查、测试连接、连接/断开、状态徽标（ready/degraded/closed）、known_hosts 指纹展示 | `remote.listProfiles` / `remote.test` / `remote.connect` / `remote.disconnect` / `remote.status` |
| 工作区选择器 | 绑定远程目录：host 列表 → 远程目录浏览（复用 `DirectoryListing`/`DirectoryEntry` 结构）→ 确认绑定 | `remote.browse(path)`（经 SSH 列目录，含面包屑与 home 根） |
| 会话工作区指示（会话头/状态栏 Slot） | 当前会话执行世界：`prod-server:/srv/app`，点击可切换/断开 | `remote.binding(sessionId)` |
| 审批卡片扩展 | 远程操作审批：主机、路径、命令三要素 + 连接状态 | 现有审批事件 + `remote` 上下文字段 |
| 终端面板 | 远程交互终端（复用 terminals 渲染） | `terminals.*` 现有 RPC |
| 文件浏览/变更 | 绑定目录文件树；变更徽标（可选 M4） | `fs.listDir`（经会话） / `remote/file-change` 事件（M4） |
| 预览按钮 | dev server 端口 → 本地隧道 → 新标签打开 | `remote.forward(localPort, remotePort)` / `remote.listForwards` |

目录选择实现方式：给 `ctx.directoryPicker` 增加 `{ kind: 'remote' }` capability（联合类型 merge-extensible，接口注释已承诺"未知 kind 隐藏入口"的降级约定）—— 交互协议（list/enter/create）与 browse 完全一致，只是列表数据经 SSH 获取，返回值为 `remote://` URI。

### 5.6 安全模型

| 威胁 | 对策 |
|---|---|
| 密码/密钥泄露 | 绝不存储密码（schema 拒绝）；密钥只存路径引用；优先 ssh-agent；`$DSH_HOME/.credentials.yaml` 的 owner-only 权限惯例沿用 |
| 中间人 | `known_hosts` 严格校验；首次连接指纹 UI 展示，用户确认 |
| 越权访问绑定目录外 | Host 侧审批栈（默认 `workspace-write` 语义）；远程 wrapper 防呆；审计日志记录每条远程命令与越界请求 |
| 恶意远端回连 | 远端命令运行在用户账号权限内；wrapper 拒绝修改 `$DSH_HOME` 与 ssh 控制目录 |
| 端口隧道滥用 | 转发仅限会话生命周期；UI 列出活动隧道，可一键关闭 |
| API key 泄露 | 模型调用留在本地（架构立场），远端环境永不注入 key |

### 5.7 Agent 体验：工具集与 Skill

**模型工具：零重写，少量新增。**

复用（无缝）：`read` / `write` / `edit` / `glob` / `grep` / `read_image` / `bash` / `terminal` / `job_*` / `subagent` / `workflow` / `goal` / `ralph`。

新增（会话工具，`ctx.tools.register` + `ctx.systemPrompt.section()`）：

| 工具 | 作用 |
|---|---|
| `remote_connect(profile)` | 建立/确保连接（供模型主动发起） |
| `remote_disconnect()` | 断开当前会话绑定 |
| `remote_status()` | 连接状态、绑定路径、活动隧道 |
| `remote_forward(localPort, remotePort[, remoteHost])` | 端口隧道（模型可自主起预览） |

**Prompt 指导**（preset persona 追加）：

> 当前会话的执行世界是 `prod-server:/srv/app`：所有文件工具与 bash 都在该机器上执行。路径是远程路径；`git` 状态、构建产物、环境变量都在远端。连接中断时工具会报 `remote/reconnecting`，重试即可。

**Skill：`remote-dev`** —— 连接与认证排查（agent 不可用、known_hosts、密钥权限 600）、绑定切换、wrapper 报错解读、端口转发与预览、远程文件语义（symlink、权限位）、常见错误码映射表。

### 5.8 编排与子代理

- fork 子会话继承绑定（session 头传播），子代理读写的"同一份代码"就是远程代码 —— 无需任何改动。
- workflow 的 agent 继承主会话绑定；若需"多台远端并行"（如 A 机编译、B 机测试），每台机器开一个绑定的会话，workflow 按会话分发 —— 这是 DSH 多会话模型天然支持的编排形态，v1 文档给出模式，不做新机制。
- 断连恢复后子代理正在跑的远程命令：由 `job_*` 的现有语义兜底（命令失败 → 子代理可见错误 → 重试）。

---

## 6. 扩展点与远期

| 方向 | 路径 |
|---|---|
| 更多 Transport | `ctx.remote` 定义为 Transport 无关（profile/会话/状态机不变），新增 `dsh-remote-docker`（容器 exec）、`dsh-remote-wsl`、`dsh-remote-kubernetes` 只是新 Provider |
| LSP 远程化 | DSH 已有 `packages/lsp`；远程 LSP = 语言 server 进程经 SSH 启动 + 语义 token/诊断经隧道回传（对齐 VS Code Remote 做法），M4 |
| 文件事件 | 远端 inotify（经 SSH 单向流）→ `remote/file-change` 事件 → UI 文件树/差异徽标，M4 |
| 双向同步模式 | 可选：绑定目录的本地镜像 + 双向同步（类似 mutagen），解决"低延迟网络 + 大仓库"场景；v1 不做，接口预留 |
| 多人共享连接 | profile 支持分享（导出为 yaml，不含密钥），配合审批上下文实现"谁在哪个主机上跑过什么"审计 |

---

## 7. 分阶段路线图

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M1 执行世界打通** | `ctx.remote`（连接/复用/心跳）+ `fs-ssh` + `subprocess-ssh` | 绑定 `remote://` 后，模型在远端目录完成"读-改-写-跑测试"全流程；`FS_STALE_VERSION` 在远端生效；断连报 `remote/reconnecting` 并可重试 |
| **M2 绑定与治理** | 会话绑定持久化（session 事件）、workspace 实体远程化、沙箱模式映射、审批上下文扩展、子代理继承 | 恢复会话自动重连；越界写触发带远程上下文的审批卡；fork/spawn/workflow 全部继承绑定 |
| **M3 前端** | 连接面板、远程目录选择（directoryPicker remote kind）、工作区指示、审批卡扩展、终端面板、端口预览 | 纯 UI 操作完成"连机器 → 选目录 → 开发 → 起 dev server → 浏览器预览"闭环 |
| **M4 体验增强** | `remote-dev` Skill、`remote_*` 工具、文件事件/文件树、LSP 远程化（可选）、隧道管理面板 | 新用户按 Skill 引导完成首次远程会话；文件变更在 UI 可见；LSP 诊断可用 |

每阶段都按 DSH 惯例交付：包 + 测试（vitest 单测 + snapshot 组合测试）、文档（README.i18n 双语文档）、`docs/` 更新。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 远程侧无法强沙箱 | 越权风险 | 明确威胁模型（远程账号=信任边界）；Host 侧审批兜底；审计日志；UI 明示 |
| 网络抖动导致文件操作失败 | 用户体验下降 | 状态机 degraded + 快速失败 + 版本守卫防半写；长命令走 job 语义可重试 |
| 延迟放大工具往返 | 模型效率下降 | SFTP 流式读、目录缓存、批处理；避免逐文件 stat |
| 多会话并发同连接 | 连接管理复杂度 | ControlMaster 多 channel + 引用计数；连接服务跨会话共享是 Host 平面职责 |
| 与 E2B/本地后端竞争 ctx.fs 单例 | 配置冲突 | isolate realm 会话级覆盖；组合文档明确"一个会话一个执行世界" |
| SSH 配置碎片化（~/.ssh/config vs DSH profile） | 用户困惑 | profile 只读视图引用 ssh config 别名，不复制；文档讲清优先级 |
| Windows 远端 | 范围膨胀 | v1 明确排除，接口按 posix 设计，预留 platform 字段 |

---

## 9. 开源、发行、部署与共享

> 前提事实（研究自 DSH 官方仓库与社区，2026-08）：
> - DSH 本身已开源：MIT 协议，[github.com/deepseek-ai/DeepSeek-Harness](https://github.com/deepseek-ai/DeepSeek-Harness)，安装即 `npx @deepseek-ai/dsh web`；当前处于 **developer preview，官方明示"THERE WILL BE COMPATIBILITY-BREAKING CHANGES"**。
> - 官方 README 为插件作者指了两条分发通道：GitHub **`dsh-plugin` topic**（插件仓库打此标签便于发现）与 GitHub Discussions / Discord 社区。
> - 官方包规范在 `docs/cookbook/adding-a-package.md`（包布局、workspace 约束、README 结构、verify 命令）与 `docs/development.md`（CI 门禁）；社区报道称其为"[一切皆插件的 Agent 运行时](http://rits.shanghai.nyu.edu/ai/deepseek-harness-cordis-everything-is-a-plugin/)"，与本文第 2 章的设计推导一致。

### 9.1 开发位置：在独立仓库开发，运行时注入（官方机制）

**结论先行：不在上游源码里开发插件，也不存在"把插件装进源码"这回事。** 代码写在独立仓库（本目录），通过**运行时组合注入**生效；上游源码 checkout（`deepseek-harness/`）保持纯净 —— 可随时 `git pull`、可删掉重下，与你的代码零纠缠。

这是官方文档设计的开发方式，两条证据：

1. **官方第一个插件教程**（`docs/user/develop/basic/index.md`）：教程让插件写在仓库外的 `scratch-plugin/`，用 `pnpm dsh web --patch ./scratch-plugin/cordis.yml` 注入，且 patch 行的 `name` **可以直接写本地 TS 源码的绝对路径** —— 意味着开发时"跑的就是你正在写的代码"，不需要构建步骤、不需要把文件放进源码树。
2. **官方发布教程**（`docs/user/develop/basic/publish.md`）：插件的分发单元是 **bundle**（npm 包，`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`），用户用 `dsh plugin --profile <name> add <pkg>` 安装进 **profile**（`$DSH_HOME/profiles/<name>`，pnpm 管理的部署单元）。**安装发生在运行时组合层，不是源码层。**

**什么时候才动上游源码？** 只有一条路：功能成熟后按 [CONTRIBUTING.md](https://github.com/deepseek-ai/DeepSeek-Harness) 提 PR 合并进 `packages/remote/*` —— 那是把代码搬过去，不是在上游目录里开发。开发期改源码 = 把自己变成 fork：每次上游更新都冲突、整套 monorepo 门禁从第一天压上来、将来 PR 还得把代码再搬一遍。

**已验证的前提**：seam 包已发布到 npm（`@deepseek-ai/dsh` 0.1.0-rc.6、`@deepseek-ai/dsh-fs` / `@deepseek-ai/dsh-subprocess` / `@deepseek-ai/dsh-e2b` 0.0.1-rc.1、`@deepseek-ai/cordis` 4.0.1），独立仓库可直接把它们声明为 peerDependencies，无需依赖本地 checkout。

**本地开发回路**：

| 阶段 | 做法 | 触碰源码？ |
|---|---|---|
| 单包快速迭代 | 在 checkout 里跑 `pnpm dsh web --patch <本仓库>/<pkg>/cordis.patch.yml`（patch 行 name 直接指 `src/index.ts` 绝对路径） | 否 |
| 多包联调 | `dsh plugin --profile dev add ./packages/fs-ssh`（pnpm `link:` 本地目录，官方支持） | 否 |
| 端到端测试 | 同一进程内跑真实 sshd（docker）目标 | 否 |
| 发布 | `npm publish`（带 `dsh.bundle` 声明）→ 用户 `dsh plugin --profile web add dsh-remote-dev` | 否 |
| 贡献上游（可选） | 按 `adding-a-package.md` 清单搬进 `packages/remote/*` 提 PR | 是（搬代码） |

**组合层叠顺序**（官方 `publish.md`，bundle 作者与用户都必须知道）：

```
空根 → ① 各 bundle patch（按 dsh.profile.bundles 顺序）→ ② profile 自身 cordis.patch.yml
     → ③ $DSH_HOME/cordis.patch.yml（机器级偏好）→ ④ --patch 参数层
```

后层按行 id 覆盖前层，**整行 config 替换而非深合并** —— 所以插件作者要提供用户大概率保留的默认值（用户可零成本覆盖），且 patch 里覆盖他人行时必须写全所有 key。

### 9.2 目标：四种共享粒度

"让别人用"不是一个动作，而是四种载体，按用户的组合深度递进：

| 粒度 | 载体 | 用户获得 | 适合场景 |
|---|---|---|---|
| npm Bundle 包 | `dsh plugin --profile <name> add <pkg>` | 能力（`ctx.remote`/`fs-ssh`/`subprocess-ssh`…） | 用户自己组组合、接自己的 transport |
| Agent Preset | 一个目录（`agent.cordis.yml`） | 开箱即用的远程开发会话 | 想"装完就能用"的多数用户 |
| Skill | `SKILL.md` bundle | 操作手册（连接/诊断/转发） | 让 agent 会"用"这个功能 |
| Profile 示例 | yaml（不含密钥） | 连接配置模板 | 想连自己机器的用户 |

设计原则：**能力、组合、知识、配置四层解耦** —— 用户可以只取一层，互不绑架。

### 9.3 开发阶段就做对的十件事（开源准备内建于开发，而非事后补）

1. **仓库形态从第一天就是开源项目**：独立 monorepo（本目录 `deepseek--harness-remote`），第一天就放 `LICENSE`（MIT，与上游一致）、README（What/Why/How/Install/Demo）、CHANGELOG、GitHub Actions CI。开源不是"最后发布一下"，是"开发过程的组织方式"。
2. **包结构按 seam 拆分**（§4.2 的五个包各自独立发布）：这是上游 `adding-a-package.md` 的拓扑要求（Service Definition / Provider / Consumer 分包装），也是社区复用前提 —— 别人能只装 `fs-ssh` 接自己的 transport，只装 `remote-binding` 不用我们的 UI。
3. **命名与元数据**：当前 npm 包使用用户 scope `dsh-remote-dev`；后续拆包继续放在 `@tsja/*` 下并保持语义化命名（`fs-ssh`/`subprocess-ssh`/`terminals-ssh`/`ports-ssh`/`remote-binding`/`tool-remote`）。GitHub 仓库打 **`dsh-plugin`** topic；`package.json` 完整填写 repository/description/license/keywords，让搜索引擎与 topic 页都能找到。
4. **依赖声明走上游惯例**：`@deepseek-ai/cordis` 与 dsh seam 包进 peerDependencies（同版本范围，devDependencies 镜像）；`@deepseek-ai/schemastery` 进 dependencies。预览期应对：peer 范围用保守区间（如 `>=0.1.0 <0.2.0`），并维护**兼容矩阵**（见 9.4）。
5. **README 直接对齐上游规范**（服务 API/事件/扩展点 + "Model Experience" + "Known Limitations and Deferred Work" 三段结构）：将来合并上游零摩擦；社区读者也熟悉这套结构。
6. **测试与 CI 对齐上游门禁**：vitest 单测 + 组合 snapshot 测试（cordis 组合行）+ 端到端（对 docker sshd 容器起真 sshd 跑全流程）；CI 跑上游五连 `constraints / typecheck / lint / build / hygiene`（+ publint），**另加一个矩阵 job：对上游最新 release 与 master 各跑一遍** —— 预览期破坏性变更靠这个兜底。
7. **双语文档**：README.i18n.yaml + README.md + README.zh.md（上游惯例）；用户指南进 `docs/` 并尽量镜像 `docs/user/guide` 的结构。
8. **示例与 demo 随仓库交付**：`examples/` 放一键演示（`docker run` 起 sshd 容器 → 绑定 → 读改跑全流程），README 顶部放录屏/GIF —— "能不能用"是开源项目的第一印象。
9. **出厂配置 = 性能优先模式**（§性能模式）：用户零配置即可获得"忽略安全开销、体验拉满"的默认行为；安全项（审批/观察策略/wrapper）作为文档化可选项。这同时是产品定位（§2.4 的便携性卖点）与开源上手成本（开箱即用）的双重需要。
10. **版本与变更纪律**：changesets（或手动 CHANGELOG + 语义化标签）；0.x 跟随上游节奏；每次发布附 release notes 模板（新增/修复/兼容性/测试过的 DSH 版本）。

### 9.4 建议仓库布局

```
deepseek--harness-remote/
├── LICENSE                     # MIT（与上游一致）
├── README.md / README.zh.md / README.i18n.yaml
├── package.json                # pnpm workspace 根；约束脚本镜像上游
├── pnpm-workspace.yaml
├── packages/
│   ├── remote/                 # Service Definition：ctx.remote 接口（零实现依赖）
│   ├── remote-ssh/             # Provider：SSH transport（连接状态机/复用/心跳）
│   ├── fs-ssh/                 # Provider：ctx.fs 后端（peer: dsh-fs, remote）
│   ├── subprocess-ssh/         # Provider：ctx.subprocess 后端（peer: dsh-subprocess, remote）
│   ├── terminals-ssh/          # Provider：ctx.terminals 后端（peer: dsh-terminal, remote）
│   ├── ports-ssh/              # Provider：ctx.ports 端口隧道（peer: remote）
│   ├── remote-binding/         # Provider：会话绑定 + isolate realm 组合行
│   ├── tool-remote/            # Consumer：remote_* 工具 + systemPrompt 段
│   └── skill-remote-dev/       # Consumer：bundled skill provider（学 dsh-skill-badge）
├── presets/
│   └── remote-dev/             # 可安装的 Agent Preset（agent.cordis.yml + README）
├── profiles/
│   └── example.yaml            # 连接配置模板（注意：与 DSH 的 profile 部署单元无关）
├── examples/
│   └── docker-sshd-demo/       # 一键演示（docker 起远端）
├── docs/                       # 本方案 + 用户指南 + 兼容矩阵
└── .github/workflows/          # CI + 发布流水线
```

依赖方向严格单向：`Consumer → Provider → Definition`；`remote-ssh` 是唯一碰 SSH 协议的包（ssh2 或 openssh 子进程），其余包只消费 `RemoteSession` 接口 —— 这保证"换 transport（docker/wsl）"不需要动任何其他包（§6）。

### 9.5 发行流程

**npm 发布清单**（对齐上游 package.json 不变式）：

- `publishConfig.access: public`、`type: module`、`main: lib/index.js`、`types: lib/types/index.d.ts`、exports map（含 `./invariant`、`./package.json`，**绝不发布 src/、map、声明 map**）；
- `files` 白名单精确到 `lib/index.js`、`lib/invariant.js`、`lib/types/**/*.d.ts`；
- peerDependencies 与 devDependencies 镜像；发布前跑 `pnpm publish --dry-run` + `publint` 检查产物。

**发布流水线**（GitHub Actions）：

1. `test`（单测 + 组合 snapshot + e2e + 上游矩阵）
2. `build`（tsdown）→ `publint` → `hygiene`
3. 打 tag → `npm publish`（可开 provenance）→ 生成 release notes
4. 可选：docs site 部署（镜像上游 `website/` 结构或独立静态站）

**兼容矩阵**（仓库内 `docs/compatibility.md`，随每个 release 更新）：

| DSH 版本 | remote 包版本 | 备注 |
|---|---|---|
| 0.1.x | 0.1.x | 当前基线 |
| master | 每夜 CI | 预览期破坏性变更在此暴露 |

**版本策略**：M1–M2 期间 0.1.x（接口可破）；M3 功能闭环后冻结接口、冲 1.0；1.0 后语义化版本。

### 9.6 让别人用：安装路径与一键装配

**路径 A —— Bundle（能力级，官方安装命令）**：每个 Provider 包同时是一个 bundle：`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，patch 文件里插入插件行（行内 `name` 引用**包名**而非源码路径，由 Node 解析到已安装代码）：

```yaml
# <pkg>/cordis.patch.yml
- insert:
    - id: remote
      name: 'dsh-remote-dev'
    - id: remote-fs
      name: '@tsja/fs-ssh'
```

用户安装（`dsh plugin` 首次使用会初始化 profile 并自动把 bundle 追加进 `dsh.profile.bundles`，`remove` 即卸载）：

```sh
dsh plugin --profile web add dsh-remote-dev          # npm 发布版（推荐，免构建权限）
dsh plugin --profile web add ./remote-ssh-0.1.0.tgz          # pnpm pack 产物
dsh plugin --profile web add github:you/dsh-remote#<sha>     # git 直装：需要 prepare 构建脚本 + allowBuilds 白名单
```

层叠顺序与覆盖规则见 §9.1（后层按 id 覆盖前层、整行替换）。

**路径 B —— Preset（开箱级，主推）**：`presets/remote-dev/` 目录即完整组合（含 remote-binding 行 + persona 段 + 工具行）。用户安装 = 拷贝目录到 `$DSH_HOME/.agent-presets/remote-dev/` —— roster 自动发现（实时读取、broken 健康检查兜底、`copy/remove` 可管理）。为降低手工拷贝，提供安装命令（见下）。

**路径 C —— Skill（知识级）**：`skill-remote-dev` npm 包按 `dsh-skill-badge` 模式注册 bundled skill（rank 低于用户目录，用户可覆盖）；同时仓库内保留 `skills/remote-dev/SKILL.md` 源文件，允许用户手动放到 `$DSH_HOME/skills` 或项目 `.dsh/skills`（本地发现的 6 级 rank 中用户根优先级高于 bundled）。

**路径 D —— Profile（配置级）**：`profiles/example.yaml` 只含主机/用户/绑定路径占位符，**绝不含密钥**；文档说明密钥走 ssh-agent 与 `~/.ssh/config`（每台本地机器自备），profile 可随仓库版本化、可分享。

**一键装配命令**（`@tsja/dsh-remote-cli` 或 `dsh remote setup`，M3 交付）：

```sh
npx @tsja/dsh-remote-cli setup            # 检测 DSH → 安装 preset → 打印组合建议行
npx @tsja/dsh-remote-cli setup --demo     # 附加：docker 起 sshd 容器，30 秒试跑全流程
npx @tsja/dsh-remote-cli doctor           # 诊断：ssh 连通性、agent、known_hosts、绑定目录权限
```

**社区通道**：GitHub topic `dsh-plugin`、Discussions（反馈/问题）、Discord、README 互链；成熟后可选收录到 [AI 原生全景图](https://landscape.jimmysong.io/zh/projects/deepseek-harness/) 这类生态列表。

### 9.7 部署到其他设备（两个方向）

**方向 A：把远程开发能力部署到任意远端设备（零安装）**。远端只需要 `sshd` + POSIX shell + 一个可写目录。这是本方案相对竞品的便携性卖点：

| 方案 | 远端需要装什么 |
|---|---|
| VS Code Remote-SSH | `vscode-server`（自动下载安装） |
| Claude Code remote | 整个 Claude Code CLI |
| Codex CLI remote | 远端运行时/容器 |
| **本方案** | **什么都没有（仅系统自带 sshd/shell）** |

**方向 B：把开发环境迁移到另一台本地电脑**。便携清单 = DSH（`npx @deepseek-ai/dsh web`）+ 插件包（npm 安装）+ preset 目录 + skills + profiles（yaml）+ `$DSH_HOME` 其余配置；密钥不迁移（各机 ssh-agent/ssh config 自备，这反而更安全）。

**多设备管理**：profiles 集合就是"开发环境清单"，随仓库版本化；新机器上 `git clone` + `setup` 即恢复全部远程开发环境 —— infra-as-code 风格，符合"便携性"的产品定位。

### 9.8 上游合并路径（双轨并存）

- **轨道 1（默认）**：独立仓库独立发行，代码风格保持"可上游合并"（§9.2 全部要求即为此）。
- **轨道 2（可选，功能成熟后）**：按 [CONTRIBUTING.md](https://github.com/deepseek-ai/DeepSeek-Harness) 与 `adding-a-package.md` 清单提 PR 合并进 `packages/remote/*`，获得官方 scope（`@deepseek-ai/dsh-*`）、官方文档站与 npm 分发。需要过上游全部门禁（constraints/typecheck/lint/build/hygiene + 测试策略 + README 校验脚本）。
- **双轨纪律**：合并后同步维护两处（独立包继续发版，上游同步）；README 与接口草案保持一致，避免双源漂移。

### 9.9 合规与披露

- **许可证**：MIT（与上游一致）。实现参考了 `fs-e2b`（MIT），代码保留出处注释即可，无传染性风险；若直接复制代码段，按上游 LICENSE 要求保留版权声明。
- **第三方依赖**：SSH 库（如 `ssh2`）与 SFTP 相关依赖的许可证核对后写入 THIRD_PARTY_NOTICES（上游惯例）。
- **仓库卫生**：禁止任何真实密钥、known_hosts、真实主机名入库；profile 示例全部占位符；CI 加 secret 扫描。
- **导出/合规**（如适用）：SSH 属通用技术，无特殊管制；不打包任何闭源组件。

### 9.10 发行前检查清单

- [ ] `LICENSE`、`package.json` 元数据、`dsh-plugin` topic、README（含 GIF demo）就位
- [ ] 五个 Provider 包独立可发布：`pnpm publish --dry-run` + publint 零告警
- [ ] CI 绿：单测 + 组合 snapshot + docker sshd e2e + **上游 master 矩阵**
- [ ] `presets/remote-dev/` 在全新 `$DSH_HOME` 上安装即用（roster 无 broken）
- [ ] Skill 在 6 级本地发现中正确出现且可覆盖
- [ ] `setup --demo` 在新机器上 30 秒跑通（docker 可用时）
- [ ] 兼容矩阵更新 + release notes 发布
- [ ] 无密钥/主机名泄露扫描通过

---

## 10. 附录 A：关键接口草案（TypeScript）

```ts
// packages/remote/ssh/src/index.ts —— ctx.remote 服务定义（节选）
interface Config {
  controlMaster: 'auto' | 'off'
  heartbeatMs: number
  reconnect: boolean
  reconnectBackoffMs: [number, number]  // 最小/最大退避
}

class Remote extends Service {
  static inject = ['storage']
  listProfiles(): RemoteProfile[]
  getProfile(id: string): RemoteProfile | undefined
  ensureSession(profileId: string, signal?: AbortSignal): Promise<RemoteSession>
  status(profileId: string): RemoteStatus
  onStatusChanged(listener: (profileId: string, status: RemoteStatus) => void): Disposable
}

// packages/fs/fs-ssh/src/index.ts —— 文件后端（实现 FileSystem）
class SSHFileSystem extends FileSystem {
  static inject = ['remote']
  // resolve 时：cwd 含 remote:// scheme → 查 ctx.remote 取会话 → realpath → FsTargetKey
  // 版本指纹：sha256(size|mtimeMs|mode|ino)；原子写：staging + rename（复刻 E2BFileSystem）
}

// packages/subprocess/subprocess-ssh/src/index.ts —— 进程后端（实现 SubprocessRuntime）
class SSHSubprocessRuntime extends SubprocessRuntime {
  static inject = ['remote']
  // exec/pty：单条 ssh 通道；pgid 阶梯信号；cwd = processPath(target)
}

// packages/session 扩展 —— 绑定事件
declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/remote-bound'(sessionId: SessionId, binding: { profileId: string; path: string }): void
    'remote/status'(profileId: string, status: RemoteStatus): void
    'remote/file-change'(binding: { profileId: string; path: string; kind: 'add' | 'change' | 'remove' }): void  // M4
  }
}
```

## 10. 附录 B：验证路径（M1 冒烟清单）

1. `remote_connect` 连上开发机，`bash` 跑 `uname -a` 返回远端内核。
2. `read` 远端仓库文件 → `edit` → `git diff` 在远端可见改动。
3. 模拟断网（`kill` 隧道进程）：写操作报 `remote/reconnecting`，重连后重试成功且无半写文件。
4. 另一会话保持本地工作区：同一进程内本地/远程会话并存，互不干扰。
5. 子代理 fork 后 `pwd` 仍在绑定目录。
