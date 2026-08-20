# Changelog

## Unreleased

### 发布可靠性
- npm 发布身份统一为用户 scope `dsh-remote-dev`，并同步插件清单、客户端模块 ID、Preset、安装命令与发布验证。
- 根项目正式声明 npm workspace，使本地 `link:` 开发安装能够从插件的生产依赖声明构建完整依赖树。
- `package:check` 现在会把真实 tarball 安装进全新的临时消费者并导入公开入口，发布前验证 `ssh2` 等运行时依赖确实可用。
- CI 与发布工作流改为等待真实 SSH 握手，避免端口刚监听但 sshd 尚未就绪时提前启动集成测试。

## 0.6.1

### 一条命令装好（修复 pnpm 拦下安装的问题）

- **问题**：`dsh plugin add dsh-remote-dev` 在 pnpm 11 上以 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cpu-features@0.0.10, ssh2@1.17.0` 失败。pnpm 11 的 `strictDepBuilds` 默认开启：依赖树里**任何**带构建脚本的包，只要没在 `allowBuilds` 里表态，就是硬错误。更要命的是 `dsh plugin` 只在 pnpm 退出码为 0 时才执行 `dsh.profile.bundles` 的登记——所以包已经下载进 `node_modules`、`dependencies` 也写好了，但插件**根本不会被加载**（本地实测复现：`bundles` 里只有 base 与 web-app）。
- **判断**：`ssh2` 的两个构建脚本都是**可选**的原生加速（它自己的 `install` 编译 crypto binding，可选依赖 `cpu-features` 走 node-gyp）。ssh2 是纯 JavaScript 实现，没有原生模块时回退到 Node 自带 crypto——本仓库的 `node_modules/ssh2` 从来就没有编译产物，而所有真实 SSH 测试一直通过。因此正确答案是**明确拒绝**这两个构建：功能零损失，还免掉了对 C++ 编译工具链的要求。
- **`setup.js`（新增，发布为 `bin`）**：`npx dsh-remote-dev@latest setup` 一条命令完成安装——
  1. 准备 profile 目录与 `pnpm-workspace.yaml`（缺失时按 dsh 的模板创建）；
  2. 写入 `allowBuilds: { ssh2: false, cpu-features: false }`，并把 pnpm 失败时留下的 `set this to true or false` 占位符改成明确的 `false`；已有的人工决定（包括 `true`）一律不覆盖；
  3. 调用 `dsh plugin --profile <名称> add <包>`（自动探测 `dsh`：PATH → 本地 `node_modules/.bin` → Harness 检出下的 `pnpm dsh`；也可 `--dsh "<命令>"` 指定），找不到 dsh 时回退到 `pnpm add` 并自行补齐 profile 清单（含该 profile 的出厂 bundle 列表）与 `dsh.profile.bundles` 登记；
  4. 校验 profile 真的登记了这个 bundle，再打印下一步。
  幂等：可以直接在失败留下的半成品状态上重跑修复。选项：`--profile` / `--package` / `--dsh` / `--home` / `--allow-native`（改为编译原生加速）/ `--dry-run` / `--lang` / `--help`；输出跟随 `LANG` 中英双语。
- **`scripts/install.sh`** 改为调用同一个安装器（源码安装：`./scripts/install.sh`）。
- **文档**：README（中/英）与 npm 页面的「快速开始」改为一条命令，并新增「安装遇到问题？」小节，把上面的报错原文、成因与手动两行 YAML 的做法都写清楚（便于搜索到）。
- **测试**：新增 `scripts/test-setup.js`（52 项）覆盖参数解析、`allowBuilds` 改写（占位符归位、已有决定不覆盖、其他包与注释不受影响、行内映射、`dangerouslyAllowAllBuilds`、含冒号的 dep-path 键、版本限定键）、profile 清单补齐与端到端安装（含失败退出码与幂等重跑）；`npm test` / `npm run test:offline` 以它开头。
- **真实验证**（本地 pnpm 11.9.0 + 真实 dsh CLI）：`dsh plugin add <tarball>` 复现出与用户完全一致的报错并确认 `bundles` 未登记；运行安装器后同一 profile 安装成功、`bundles` 含 `dsh-remote-dev`、启动后 `/dsh-remote/api/profiles` 正常响应（插件已加载）。同时验证「拒绝构建」的语义确实是**包照常安装、脚本不执行**。

## 0.5.0

### 远程目录 = 侧边栏工作区（本次要解决的核心问题）

- **添加工作区 → 远程机器 → 选目录 → 直接开工**：确认后侧边栏立刻多出一个普通工作区行（标题 `app [SSH: buildbox]`），并像本地工作区一样直接打开一个会话。在它下面新建的每个会话，`read/write/edit/glob/grep/bash` 全部作用于那台机器的那个目录——**不再需要手动去选「SSH · …」预设**，这是 v0.4 遗留的最后一道手工步骤。
- **锚点目录（anchor）**：DSH 的工作区注册表走宿主 `fs.realpath` + `stat`，并按会话 header 的 `cwd` 分组，`remote://` 结构上不可能成为工作区记录。因此每个远程根目录在 `$DSH_HOME/remote-workspaces/<机器>/<目录>-<hash6>/` 有一个空的本地锚点目录，只用来提供稳定身份（含 `.dsh-remote-workspace.json` 说明文件）；真正的文件与命令世界全部在远端。
- **自动组合（agent/created + agent/pre-step）**：Host 插件监听 `agent/created`，会话 cwd 命中锚点时用 `agentPresets.recompose()` 把该会话换到远程预设，并向会话日志追加 `agent-preset/selected`——因此**冷启动恢复旧远程会话时无需再次介入**（`resolveSessionPreset` 从日志读取）。`agent/pre-step` 会等待进行中的切换，堵住「创建后立刻发消息」的毫秒级竞态。
- **预设由默认预设派生，而不是写死行清单**：读取当前默认预设（`agentPresets.resolve()`）的 `agent.cordis.yml`，整体缩进进 `isolate: {fs, shell}` 组（纯缩进位移，块标量/注释/`!!js` 表达式逐字节保留），再做三处外科手术式改写：① 嵌套 `isolate:` 中的 `fs`/`shell` 键移除（`minimal` 这类自带 fs realm 的预设不会再遮蔽远程世界）；② 本机世界提供者行（`fs-local`/`fs-sandbox`/`fs-e2b`/`bash-local`/`bash-sandbox`/`pwsh-*`/`terminal-bash`/`tool-bash-persistent`/`tool-terminal`）加 `disabled: true`——只禁用「后端」与「消费者」，绝不禁用别的行 inject 的服务，因此不会出现挂起的行导致挂载失败；③ 相对 `name:` 说明符按基础预设目录绝对化。远程会话由此保留 persona、AGENTS.md、skills、todo、plan 模式、压缩、子智能体等**全部本地能力**。
- **基础预设变更自动跟随**：生成目录里写入 `source.json`（生成器版本 + 基础预设 id/路径/内容哈希），每次创建工作区与每次远程会话组合前比对，基础预设改了就重新生成（预设服务发现文件戳变化后会启用新一代挂载）。无可用预设 roster 时回退到内置行清单。
- **`{{cwd}}` 说真话**：新增 `remote-context.js` 预设行，在该预设作用域内用 `systemPrompt.variable('cwd')` 遮蔽全局 cwd（渲染为远程目录），并加一段说明告诉模型「文件与命令都在远端，别推理本机环境」。
- **移除语义**：在侧边栏删除工作区行是操作者的决定——重启后**不会**被重新创建（`reconcile()` 只修锚点/预设并同步 workspaceId，不重新注册）；生成的预设默认保留，因为历史会话按 id 组合它，删了就打不开旧会话。彻底清理在 **设置 → 远程连接 → 远程工作区** 里勾选「同时删除生成的预设」。
- **新 RPC**：`remote.workspace.create` / `.list`（含 presetPresent/registered 健康位）/ `.remove`（`deletePreset`）/ `.refresh`；`remote.workspace` 保留为 `create` 的兼容别名。
- **设置页新增「远程工作区」区块**：机器、远程目录、预设、基础预设、健康标记与两步移除。
- **降级路径**：`workspaceRegistry` 或 `agentPresets` 不在组合里时（headless/ACP/极简组合）只是没有远程工作区，插件其余部分照常工作。
- **测试**：新增 `scripts/test-workspaces.js`（77 项，无需 SSH 与宿主进程）——基础预设改写（含真实 `standard`/`minimal`/`code` 三个出厂预设的往返解析）、生成文档的 YAML 结构、预设幂等与陈旧检测、记录存储、注册与标题、自动组合（含已组合/本地会话/无 cwd/坏预设降级）、attach 接线、reconcile 不复活已删行、移除与彻底清理。`npm test` 现以它开头；`npm run test:offline` 只跑这一套。

## 0.4.0

### 远程工作区：像本地一样在远程机器上开发
- **远程会话执行世界（VSCode Remote 式体验）**：确认远程目录时自动生成 agent 预设（`$DSH_HOME/.agent-presets/remote-ssh-*/`），组合内用 `cordis:group + isolate {fs, shell}` 挂载插件的远程 `fs`/`shell` Provider，并把标准工具行（tool-fs / tool-fs-search / tool-bash）放进同一 realm——作用域注册遮蔽全局同名工具，因此选该预设的新会话里 `read/write/edit/glob/grep/bash` 全部直接作用于远程机器，路径就是远程机器的绝对路径。
- **`remote-fs.js`**：完整 FileSystem 契约的 SFTP 实现——resolve/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText，含守卫写（createIfAbsent / replaceIfVersion）、字面量编辑（唯一性/replaceAll）、CRLF 保留、二进制拒绝、体积上限、FS_* 错误码映射。
- **`remote-shell.js`**：ShellExecutor 契约的 SSH 实现——resolve 默认 workdir=所选目录；run 支持 env 导出（POSIX 单引号转义）、stdin 管道、超时与 abort 双通道、输出截断（lossy 标记）；start 后台句柄增量读取（stderr 标记段）、幂等 kill。
- **transport**：`startExec` 会话化（stdin/abort/增量回调/超时统一），SFTP 通道连接级缓存复用（此前每次操作新开通道会耗尽 MaxSessions），`writeFileAtomic` 暂存+rename（目标已存在时 unlink 后重试，Windows 同策略），新增 statPath/lstatPath/readDirRaw/openReadHandle/readFileBytes。
- **RPC**：`remote.workspace`（绑定+生成预设，幂等）、`remote.workspace.remove`、`remote.workspace.list`；选择目录的确认按钮改走 `remote.workspace`，成功提示直接给出“新建会话时选 SSH · … 预设”的指引。
- **管理器进程内注册**：apply 时把 RemoteManager 挂到 `Symbol.for('dsh-remote-ssh.manager')`，预设世界插件经它取共享连接（UI、remote_* 工具、会话世界共用一条 SSH 连接），卸载时撤销。
- **systemPrompt** 段落告知模型：远程会话里标准工具已在远程世界，优先用它们而非 `remote_*`。
- **路径语义（实测修正）**：fs 工具会注入会话的宿主 cwd——远程世界里相对路径一律以绑定 root 为基准（VSCode Remote 心智模型），宿主 cwd 不泄漏；bash 的 workdir 在远程存在时采纳、不存在时回退 root（真远程机器上宿主路径不存在→自然落到所选目录）。
- **连接获取修正**：`manager.connect(id)` 返回的是状态快照而非连接对象——新增 `manager.connection(id)` 供世界插件取真正的 RemoteConnection（真实会话 E2E 中发现并修复）。
- **测试**：新增 `scripts/test-world.js`（52 项）覆盖 FileSystem/ShellExecutor 全契约、cwd 回退语义与预设生成（真实 sshd），`npm test` 三套全绿（传输层 + 管理器 32 + 世界 52）；3090 实例真实会话 E2E 验证（bash 经 SSH 执行、相对路径 read 命中远程 root）。

### 边界（诚实标注）
- 工作区侧栏按宿主 `cwd` 分组会话：远程工作区以 agent 预设（芯片 + 会话头部标签）呈现，不出现为工作区列表文件夹；这是上游注册表的可扩展点。

## 0.3.0

### 添加工作区 → 选择远程目录
- **接管“选择工作区目录”弹窗**（directoryFlow 插槽，priority -50）：本机页签原样内嵌官方浏览对话框（零回退），底部悬浮按钮切换到远程页签；卸载插件即还原官方弹窗。
- **远程页签**：左侧列出全部已配置机器（状态点/地址/当前绑定），未连接的机器点击即自动连接并浏览目录；面包屑导航、目录优先排序、键盘可达。
- **确认目录 = 绑定远程工作上下文**：`remote_read/write/list` 的相对路径以它为基准，`remote_exec` 默认 cd 进去执行，systemPrompt 动态段落告知模型哪个远程目录是主工作目录（最近绑定优先）。
- 新增 `remote.bind` RPC 与绑定时间戳（`boundAt`）；设置页表单手填绑定目录同样生效并按时间排序。
- 明确边界：DSH 工作区注册表本身只认本机路径（`createWorkspace` 走 Host 本地 `fs.realpath`），远程选择成为上述会话级上下文；真正的 `remote://` 工作区需上游 `ctx.fs`/`ctx.subprocess` Provider 缝。

### 其他
- HTTP 桥 `remote.exec` 与模型工具 `remote_exec` 一致地尊重绑定目录（命令里显式 `cd` 优先）。
- 测试新增 10 项绑定语义用例（绑定/重载/相对路径拼接/绝对路径直通/Windows 盘符直通/cd 包装/顺序/解绑），全套 32 项 + 传输层全绿。

## 0.2.0

### 认证体验
- **移除 ssh-agent / 默认密钥认证**：认证方式只剩 **密码** 与 **密钥**（显式路径，支持 `~` 展开）。旧 `agent` profile 自动迁移为显式密钥路径（迁移前自动备份 `profiles.json.pre-v02.bak`）。
- **认证方式联动表单**：选密码只显示密码字段；选密钥显示密钥路径 + 口令。必填即时校验（红框 + 文案）。
- **保存语义修复**：编辑连接时空白密码/口令 = 保持原值（修复 v0.1 编辑后密码被清空的 bug）。
- **测试连接（probe）**：保存前用表单当前值临时连一次，展示平台 / 指纹 / 延迟。
- **端口规范化**：一律存为数字（修复 v0.1 字符串端口违反工具 schema 的 bug）。
- **密钥路径 `~` 展开**（修复 v0.1 照 placeholder 填写必然 ENOENT 的 bug）。
- **remote_connect 补 passphrase**（修复 v0.1 临时密钥连接永远失败的 bug）。

### 远程目录浏览器
- 新增 `remote.browse` / `remote.browseClose` RPC：自动连接、SFTP realpath、目录条目（name/type/size/mtime）目录优先排序。
- 新增浏览弹窗：面包屑导航、返回上级、回主目录、键盘可达（Enter/Space/Esc/焦点圈闭）；绑定目录字段与连接卡片均可唤起。
- 卡片浏览时提供 `remote://user@host/path` 会话引用一键复制。

### 稳定性
- 连接状态机：`connecting → connected → closed`，close/error 后连接从管理表移除（消灭僵尸"已连接"）。
- **受限自动重连**：下一次操作前静默重连一次（60 秒窗口内最多 3 次），凭据来自 profile。
- **错误分类**（zh/en 双语）：AUTH / KEYFILE / DNS / TIMEOUT / REFUSED / UNREACH / RESET / HOSTKEY；UI 与工具共用一张映射，不再暴露原始英文 dump。
- keepalive 15s/3 次更快感知断线；exec 超时上限 10 分钟；`remote_status` 输出 `lastError`。

### 安全
- **主机指纹 TOFU**：首连记录（SHA256 base64，OpenSSH 格式），后续每次校验；不匹配硬失败并列出两个指纹；卡片提供"重置指纹"。
- **HTTP 桥 CSRF 防护**：Origin 与 Host 同源校验（跨站 403）；请求体上限 1 MiB。
- **凭据迁入 DSH 凭据库**（`ctx.credentials`，标准组合自动启用并一次性迁移文件内旧密钥）；极简组合回退本地文件并在 UI 显示存储模式徽标。
- **浏览器面永不下发密钥**：save/list 响应剥离 password/passphrase。

### UI / UX
- 全面改用 shell 设计令牌（`--dsw-alias-*`），深浅色主题均正确渲染。
- 连接卡片：状态点（绿/黄/灰）、认证徽标、平台徽标、绑定目录、指纹、最近错误；操作行含连接/断开、测试、浏览、编辑、重置指纹、删除（两步确认，3 秒恢复）。
- 表单内 `测试连接` 结果面板（成功显示指纹与延迟，失败显示分类原因）。
- 命令测试面板可选目标主机（不再只打第一个已连接的）；stdout/stderr 分色、退出码徽标。
- Toast 通知（右下角，成功/失败双色）取代裸文本 message；空状态引导；i18n（跟随 DSH 应用语言，zh/en，服务缺失回退浏览器语言）。
- 密码/口令可见性切换（👁）；a11y：弹窗 role=dialog、焦点圈闭、label 关联、图标按钮 aria-label。

### 工具面 / 内部
- RPC 注册去重：`harness.handle` 与 HTTP 桥共用一张方法表（新增 probe/browse/browseClose/resetFingerprint）。
- `remote_list` 条目新增 mtime、目录优先排序。
- 测试参数化：`DSH_TEST_HOST/PORT/USER/PASSWORD` / `DSH_TEST_KEY` / `DSH_TEST_NO_PASSWORD=1`，可对任意 sshd 跑（新增指纹校验、迁移、空白保留、错误分类、browse 等用例）。

### 开源卫生
- 删除遗留 `.bak` 文件；包元数据补齐（repository/bugs/engines/description）；新增 CHANGELOG / CONTRIBUTING / 安全模型文档（README）。
- 已知限制更新见 docs/HANDOVER.md。

## 0.1.0

初始版本：SSH 连接管理（密码/密钥/agent）、`remote_*` 工具、SFTP 读写、HTTP 桥、设置页。
