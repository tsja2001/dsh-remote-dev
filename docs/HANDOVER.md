# 交接文档（HANDOVER）

> 版本：v0.1（2026-08）
> 项目：deepseek--harness-remote —— DeepSeek Harness 的 SSH 远程开发插件

---

## 1. 一句话总结

给 DSH 装上"远程开发"能力：Web 设置页配置 SSH 连接（密码/密钥），会话内用 `remote_*` 工具在远端设备上执行命令、读写文件（SFTP）。**远端设备零安装**，只需要 `sshd` + 可登录账户。

## 2. 代码地图

```
deepseek--harness-remote/
├── package.json                  # 根（npm，type: module；npm test 跑传输层验证）
├── LICENSE                       # MIT
├── README.md                     # 快速开始
├── packages/remote-ssh/          # ★ 插件 bundle（可发布、可安装）
│   ├── package.json              # @dsh-remote/remote-ssh；dsh.bundle + dsh.client 声明
│   ├── index.js                  # Host 插件：RemoteManager + RPC（harness.handle）+ 工具注册
│   ├── transport.js              # ★ ssh2 传输层：connect/exec/SFTP/平台探测（唯一碰 SSH 协议的文件）
│   ├── profiles.js               # profile 存储：~/.dsh/remote/profiles.json（0600）
│   ├── tools.js                  # remote_status/connect/disconnect/exec/read/write/list + prompt 段
│   ├── client.js                 # 浏览器设置页（settings.section → Remote Connections）
│   └── cordis.patch.yml          # bundle 的插件行（dsh plugin add 后自动生效）
├── presets/remote-dev/           # Agent Preset（复制到 ~/.dsh/.agent-presets/ 即用）
├── scripts/
│   ├── test-ssh2.js              # 传输层验证脚本（npm test）
│   └── ssh2-cli.js               # ★ ssh2 桥接 CLI（动态插件经 ctx.shell 调用，JSON 行输出）
└── docs/
    ├── remote-development-design.md   # 完整设计方案（§1–§10）
    ├── HANDOVER.md                    # 本文档
    └── PUBLISHING.md                  # 开源发布教程
```

### 数据流

```
Web 设置页 (client.js)
  └─ host.call('remote.*') ──► Host (index.js: harness.handle)
        ├─ remote.save/delete ──► profiles.js（~/.dsh/remote/profiles.json）
        └─ remote.connect/test/exec ──► RemoteManager
              └─ RemoteConnection (transport.js, ssh2)
                    ├─ exec()    —— 远端 shell（POSIX 登录 shell / Windows cmd）
                    ├─ readFile / writeFile / listDir —— SFTP
                    └─ detectPlatform() —— uname -s / ver
```

模型侧：`remote_*` 工具（tools.js）走同一条 `RemoteManager` 路径，与 UI 共用连接。

## 3. 关键设计决策（为什么这么做）

| 决策 | 理由 |
|---|---|
| 传输层用 `ssh2`（纯 JS）而非系统 ssh 子进程 | 密码认证程序化可用（系统 ssh 需 sshpass）；无原生依赖，跨平台可发布 |
| 单连接多 channel（一个 profile 一条 TCP） | exec/SFTP 复用同一连接，ControlMaster 语义内建 |
| profile 存 `~/.dsh/remote/profiles.json`（0600） | 简单可审计；v0.1 密码明文存储是**已知 tradeoff**，M2 迁移 `ctx.credentials` |
| `dsh.bundle` + `dsh.client` manifest | 官方分发机制：`dsh plugin --profile <name> add <pkg>` 一条命令安装，浏览器面自动被发现 |
| 动态插件用 `ctx.shell` 调 `ssh2-cli.js` 桥 | 动态 Host 沙箱没有 import/子进程；桥接后 GUI 内演示走的是**真实产品传输层**（含密码） |
| 平台自动探测（posix/windows） | 一套代码支持 Windows 远端（cmd 语法提示） |

## 4. 测试记录（2026-08，全部通过）

`npm test`（`scripts/test-ssh2.js`，目标：docker `linuxserver/openssh-server`，127.0.0.1:2222）：

```
PASS  password auth + connect  (platform=posix)
PASS  exec echo                (exit=0, HELLO_FROM_SSH2)
PASS  sftp list /              (29 entries)
PASS  sftp write+read          (hello remote world)
PASS  exit code propagation    (code=42)
PASS  key auth + exec          (exit=0)
PASS  wrong password rejected
```

`ssh2-cli.js` 桥：password exec / test 均返回 `ok:true`。

`npm test` 现包含两层（`scripts/test-ssh2.js` + `scripts/test-manager.js`，后者用独立临时 `DSH_HOME` 隔离状态）：

```
PASS  saveProfile            PASS  connect (password / key)
PASS  exec via manager       PASS  sftp write+read via manager
PASS  test()                 PASS  statusAll (connected / after disconnect)
PASS  wrong password rejected
```

**官方安装路径实测**（`dsh plugin --profile remote-test add ./packages/remote-ssh`）：profile 初始化成功、pnpm link 安装、`dsh.profile.bundles` 自动追加，`--dump-config` 输出 `# == @dsh-remote/remote-ssh` 层与 `remote-ssh` 插件行 —— bundle 组合机制验证通过。

**健壮性守卫**（2026-08 补充）：`index.js` 与 `client.js` 对 `harness`/`host`/`styles` 做了存在性守卫——动态插件环境走 RPC 桥；打包安装环境（M2 前）优雅降级：工具可用、UI 显示"RPC bridge unavailable"提示，不崩溃。

**打包模式全链路实测**（2026-08，第二个 web 实例，3090 端口）：

- 建 `web-remote` profile（`@deepseek-ai/dsh-web-app` in-box + `@dsh-remote/remote-ssh`），`dsh --profile web-remote --port 3090` 启动成功，HTTP 200
- 过程中抓出并修复两个真实打包 bug：① `ctx.tools` 未声明 `inject` 被 Guard 拦截（`index.js` 补 `export const inject = ['tools']`）；② `defineTool` 要求 `output: { schema, render }`（tools.js 全部补齐，含 JSON schema 输出与文本渲染）
- 页面 boot payload 中出现 `remote-ssh/client.js` —— **`dsh.client` 扫描正确把 bundle 的浏览器面编入 Web 组合**

**你的 Windows 机器（work-windows / 100.64.0.9）实测记录（2026-08，Windows 侧已放行 22 端口后）**：

- 系统 ssh（密钥）：`ssh work-windows` 成功，用户 `t`
- **产品传输层（ssh2）实测成功**：exec（`whoami` → `t`，`pwd` → `/home/t`）、SFTP 列目录（`/home/t` 下 .dotnet / nacos / .jdks / .oh-my-zsh / .bun 等）
- **重要发现：该机的 SSH 默认 shell 落在 WSL 环境**（`uname -s` → `Linux`，shell 为 zsh，家目录 `/home/t`）——命令一律按 POSIX 语法（`ls`/`pwd`），不是 cmd；平台探测返回 `posix`，语义正确（命令是 POSIX 风格）
- 若以后想探测"远端是 WSL"，可在 detectPlatform 里加 `wsl.exe` 探测或读 `/proc/version`——v0.1 不区分（posix 已够用）

**持久化自动启动（2026-08，已就绪）**：

- `dsh plugin --profile web add ./packages/remote-ssh` 已把 bundle 装进真实 web profile（`dsh.profile.bundles` 含 `@dsh-remote/remote-ssh`）——**每次 GUI 启动自动加载**，动态插件方案（进程内、重启即失）不再需要
- **打包模式 HTTP 桥**（M2 前过渡方案）：Host 用 `ctx.inject(['webServer'], ...)` 在 webServer 服务可用后注册 `POST /dsh-remote/api/*` 路由（激活时序无关、服务重载自动重注册）；Client 在 `host` RPC 桥不可用时回退 `fetch('/dsh-remote/api/...')`
- 打包模式实测（3090 实例）：profiles → save → connect（connected · posix）→ exec（exit 0）→ test 全链路通过；client 模块照常编入 boot payload
- 教训：`ctx.get('webServer')` 在 apply 时可能拿到 undefined（激活顺序竞态）——**可选但可能晚到的服务要用 `ctx.inject` 而非 get**

## 5. 版本记录

### v0.3 增量（添加工作区选远程目录）

- **接管选择弹窗**：注册 `conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow` 两个 single 插槽条目（priority -50；单格最低优先级者渲染，卸载插件即还原官方弹窗）。
- **本机页签零回退**：`ctx.slots.entries(hole)` 找官方 BrowseDirectoryFlow 条目 → `entry.inject()` 拿 `listDirectory/createDirectory/t` 注入面 → 原组件内嵌；官方组合无 browse 条目时回退纯路径输入。
- **远程页签**：机器列表（`remote.list`）→ 点击未连接机器自动连接（`remote.browse` 自动建连）→ SFTP 目录树（面包屑/上级/主目录/键盘可达）→ 确认绑定。
- **绑定语义**：新 RPC `remote.bind` 持久化 `bindPath` + `boundAt`；`resolveBound` 拼相对路径（绝对 POSIX/Windows 盘符/UNC 直通）；`withDefaultCwd` 给 `remote_exec` 与桥 `remote.exec` 包 cd（显式 cd 优先）；systemPrompt `tool:remote` 段落改函数 text + `ctx.inject(['systemPrompt'])` 兜底，每次组装读 `boundContexts()`（最近绑定优先，告知模型主工作目录）。
- **边界（已验证）**：DSH `createWorkspace` 走 Host 本机 `fs.realpath`，`remote://` 不可能注册为工作区——绑定是会话级远程开发上下文；真 remote workspace 需上游 `ctx.fs`/`ctx.subprocess` Provider 缝（设计文档 M4）。
- **实测**：manager 32 项（新增 10 项绑定用例）+ 传输层全绿；3090 实例端到端（表单手填绑定 → exec 生效；RPC bind/解绑；boot payload 含新 client 60KB）；systemPrompt 段落在模拟 cordis 环境验证注入正确。

### v0.2 记录（2026-08 开源化优化，方案见 docs/OPTIMIZATION-PLAN.md）

**已落地**（全部实测通过）：

- **认证重构**：仅剩 密码/密钥 两种；表单联动显隐 + 即时校验 + `remote.probe` 测试连接（平台/指纹/延迟）；编辑空白=保持原密；旧 `agent` profile 自动迁移（备份 `.pre-v02.bak`）
- **修复 v0.1 四个真实 bug**：编辑清空密码（B1）、密钥路径不支持 `~`（B2）、remote_connect 丢 passphrase（B3）、port 字符串入库（B4）
- **远程目录浏览**：`remote.browse/browseClose`（自动连接、realpath、目录优先排序、mtime）；弹窗（面包屑/上级/主目录/键盘可达）；`remote://user@host/path` 引用复制
- **稳定性**：连接状态机 + close/error 监听（消灭僵尸连接）；受限自动重连（60s 窗口 ≤3 次）；错误分类表（zh/en：AUTH/KEYFILE/DNS/TIMEOUT/REFUSED/UNREACH/RESET/HOSTKEY）；keepalive 15s/3
- **安全**：host key TOFU（SHA256 pin，不匹配硬失败 + 双指纹展示 + 显式重置）；HTTP 桥同源校验（跨站 403）+ 1MiB 体上限；`ctx.inject(['credentials'])` 迁密（标准组合自动启用并一次性迁移，极简组合回退文件 + UI 徽标）；RPC 响应剥离密钥
- **UI**：全面 `--dsw-alias-*` 设计令牌（深浅主题正确）；连接卡片（状态点/徽标/指纹/最近错误）；删除两步确认；toast；空态；命令面板可选目标；zh/en i18n（跟随 DSH 语言，回退 navigator）
- **工程**：RPC 表去重（harness.handle 与 HTTP 桥共用）；测试参数化（DSH_TEST_*，无 docker 可跑）+ 新用例（指纹/迁移/空白保留/分类/browse/probe）；删 `.bak`；包元数据补齐；README（含安全模型）/ CHANGELOG / CONTRIBUTING

**实测记录**：本地 sshd（2223 端口，密钥认证）两套测试全绿；3090 二号实例（web-remote profile）HTTP 桥全链路：save → connect（TOFU pin）→ exec → browse（47 条目）→ browseClose → probe → delete；CSRF 跨站 403；boot payload 含新 client（66 处设计令牌）。过程中抓到并修复：schema 编译器要求嵌套对象显式 `additionalProperties`（tools.js lastError）。

## 6. 已知限制（v0.2）

- 极简组合（无 credentials 服务）下密钥仍落 profiles.json（0600，UI 有徽标提示）
- 自动重连是"下次操作时"而非后台主动；无 degraded 期间的重试队列
- GUI 顶部"添加工作区"（directoryFlow 插槽）尚未接入远程目录 —— 需要 DSH 上游 remote:// workspace seam（createWorkspace 走本机 fs.realpath），假接入弊大于利，已列入下一步
- Windows 远端仅验证传输层可连；cmd 语法由平台探测提示
- 无 LSP、无端口转发预览、无跳板机（ProxyJump）、无 known_hosts 互操作

## 7. 下一步（按设计文档 §7 路线图）

| 阶段 | 内容 |
|---|---|
| M1.1 | bundle 打包安装实测（`npm pack` → `dsh plugin add` → 重启 GUI 验证 UI+工具）；发布 npm（PUBLISHING.md）—— **v0.2 已达发布标准，剩 npm pack 终检** |
| M2 | 会话绑定（`remote://` cwd）、沙箱模式映射、审批上下文扩展、Typert RPC 定案 |
| M3 | directoryPicker remote capability 接入 GUI 工作区流、终端面板（terminals-ssh）、端口预览、跳板机 |
| M4 | fs-ssh / subprocess-ssh 作为 `ctx.fs`/`ctx.subprocess` 的 seam 后端（工具零重写）、文件事件、LSP、known_hosts 互操作 |

## 8. 维护须知

- 改传输层前先跑 `npm test`（真实 sshd 容器）
- `harness.handle`/`host.call` 契约：方法名以 `remote.` 为前缀，参数/返回值必须纯 JSON
- 发布：`cd packages/remote-ssh && npm publish`（先 `npm pack` 检查 files 清单）
- 与上游 DSH 的兼容性：peer 依赖 `@deepseek-ai/dsh-tools`（npm 0.0.1-rc.1）；DSH 处于 developer preview，接口可能破坏性变更——升级后跑 `npm test` + GUI 冒烟
