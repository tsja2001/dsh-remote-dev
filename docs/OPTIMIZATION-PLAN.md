# remote-ssh v0.2 开源化优化方案

> 状态：**已实施完成（v0.2.0，2026-08）** · 作者：coding agent · 范围：`packages/remote-ssh`（dsh-remote-ssh 插件）
> 目标：把 v0.1 的可用原型打磨到可以公开发布（npm + GitHub）的水准：认证体验、远程目录选择、稳定性、安全、UI/UX、开源卫生。
>
> 实施结果：M1–M5 全部落地并实测通过（两套测试全绿 + 3090 二号实例全链路冒烟 + CSRF/TOFU/凭据迁移验证）；明细见 docs/HANDOVER.md §5。
>
> **v0.3 追加（2026-08，用户后续需求“添加工作区可选远程目录”）**：directoryFlow 已在插件层接管（本机页签内嵌官方对话框 + 远程页签机器列表/自动连接/目录浏览），确认目录绑定为会话远程工作上下文（工具相对路径 / exec 默认 cwd / systemPrompt 动态段落）。`remote://` 成为 DSH 工作区条目仍需上游 seam——见 HANDOVER §5 v0.3 边界说明。

---

## 0. 结论摘要

本方案在用户提出的三点（删掉 ssh-agent 认证、认证方式联动表单、远程目录选择）之外，通过代码审查又发现 **4 个真实 bug、2 个安全缺口、若干体验短板**，归纳为六个工作包：

| # | 工作包 | 级别 |
|---|---|---|
| W1 | 认证体验重构（删 agent + 表单联动 + 保存语义） | P0 |
| W2 | 远程目录浏览器（SFTP 浏览弹窗，用于绑定目录选择） | P0 |
| W3 | 连接稳定性（状态机、断线检测、受限自动重连、错误分类） | P0 |
| W4 | 安全加固（host key TOFU 指纹校验、HTTP 桥防 CSRF、凭据迁入 ctx.credentials） | P0/P1 |
| W5 | UI/UX 全面翻新（设计令牌、中英双语、空态、删除确认、Toast） | P0 |
| W6 | 工具面与开源卫生（remote_connect 修正、文档、包元数据、测试、清 .bak） | P0 |

明确不做（见 §7）：把远程目录接入 GUI 顶部"添加工作区"入口（需要上游 remote:// workspace 支持）、跳板机、端口转发、known_hosts 互操作。

---

## 1. 现状盘点（代码审查发现的问题）

### 1.1 用户提出的三点

1. **认证方式里有 "ssh-agent / 默认密钥" 选项**（client.js:167、transport.js:43-58、tools.js:40）——要求删除，只留 密码 / 密钥 两种。
2. **表单不联动**：无论选什么认证方式，密码、密钥路径、密钥口令全部同时显示（client.js:157-173），无必填校验、无测试连接、无密码可见性切换。
3. **绑定目录只能手敲路径**（client.js:172），无法浏览远端目录。

### 1.2 审查发现的真实 bug

| # | 问题 | 位置 | 影响 |
|---|---|---|---|
| B1 | **编辑连接再保存会清空已存密码**：列表行数据来自 statusAll（不含 password），编辑回填 `p.password || ''` 恒为空，保存后把空串覆盖进 profiles.json | client.js:146-149 + profiles.js:57 | 用户改个名字密码就丢 |
| B2 | **密钥路径不支持 `~`**：placeholder 提示 `~/.ssh/id_ed25519`，但 transport 直接 `readFileSync(keyPath)`，`~` 不展开 → ENOENT | transport.js:40-41 | 照着提示填必然报错 |
| B3 | **remote_connect 临时连接丢 passphrase**：connectAdhoc 组装 profile 时没有带 passphrase 参数 | index.js:58-67 + tools.js:36-42 | 带口令的密钥在工具路径永远失败 |
| B4 | **port 以字符串入库**：表单 `e.target.value` 直接入 profile，`port` 变成 `"22"`，违反工具输出 schema（number），也给 ssh2 传了字符串端口 | client.js:103 + profiles.js:54 | schema 校验失败/连接异常 |

### 1.3 安全缺口（开源发布前必须补）

| # | 问题 | 说明 |
|---|---|---|
| S1 | **无 host key 校验**：ssh2 默认接受任意主机指纹（MITM 风险）。市面所有 SSH 产品（OpenSSH/VS Code/Termius）首连都做 TOFU + 指纹展示与变更告警 | transport.js |
| S2 | **HTTP 桥无 CSRF 防护**：`/dsh-remote/api/*` 接受任意 Origin 的 POST，恶意网页可向 127.0.0.1:3080 跨站提交 exec（等于远程 RCE 代理） | index.js:165-201 |
| S3 | 密码/口令明文存 profiles.json（0600，已知 tradeoff）。DSH 已有 `ctx.credentials` 凭据缝（base bundle 内置 credentials-local），应迁移：值不落 profile、不回传浏览器 | profiles.js |

### 1.4 稳定性短板

- **僵尸连接**：manager 不监听 ssh2 client 的 close/error，网络断开后 connections 表仍标记 connected；无重连、无 degraded 状态（设计文档 §5.1 未落地）。
- **错误信息是英文原始 dump**（`ssh connect to x failed: ...`）直接怼给用户，没有分类（认证失败/网络不可达/端口不通/DNS 失败/口令错误）。
- exec 超时只关 stream；keepalive 断连后下一次调用才知道。
- HTTP 桥 readJsonBody 无大小上限。

### 1.5 UI/UX 短板

- 样式用不存在的 `--dsh-border` 变量回退到写死的灰色，未使用 shell 的 `--dsw-alias-*` 设计令牌（CLIENT_NOTES 明确要求），深浅色主题下观感不一致。
- 中英混排：区块标题 "Remote Connections"、按钮 "测试/断开/连接"，无 i18n。
- **删除无确认**（一键即删，还断开连接）。
- 无空状态引导；message/out 是裸文本；busy 是全局单开关，一个操作禁用整页。
- 命令测试面板只对"第一个已连接主机"执行，多连接时不可选。

### 1.6 开源卫生

- `client.js.dynamic.bak`、`package.json.bak` 混在源码树；package.json 的 repository 还是 `<your-name>` 占位。
- 无 CHANGELOG / CONTRIBUTING / 安全说明；README 未覆盖新认证模型。
- CI（.github/workflows/ci.yml + sshd service 容器）已就绪，但测试没覆盖上述新语义。

---

## 2. 市场调研：对标产品的共识模式

| 产品 | 值得借鉴的点 |
|---|---|
| **VS Code Remote-SSH** | 认证=密码/密钥+口令；host key 首连 TOFU 弹指纹、变更强告警；连接状态常驻状态栏 |
| **JetBrains Gateway** | 配置对话框内嵌 **Check connection（测试连接）** 按钮，保存前可验证；指纹校验 |
| **Termius** | 主机卡片列表 + 状态点；**Keychain** 凭据保管（值不出库）；SFTP 目录浏览器；known-hosts TOFU |
| **Tabby** | 配置 profile + SFTP 侧栏浏览；错误分类提示 |
| **FileZilla 站点管理器** | **认证类型下拉联动表单**（匿名/询问/普通，字段随类型显隐）；快速连接条 |
| **WinSCP 登录对话框** | 站点存储 + 编辑时空白密码=保持原值；高级选项折叠 |
| **OpenSSH 本体** | 指纹用 SHA256 base64 展示；StrictHostKeyChecking 语义（accept-new ≈ TOFU） |

收敛出的共识（本方案全部采纳）：

1. 认证字段随类型显隐，必填项即时校验；
2. 表单内即可"测试连接"，成功再保存；
3. 编辑时空白密码 = 保持原密码（修 B1）；
4. 密码框带可见性切换（👁）；
5. 首连记录并展示 host key 指纹，之后每次校验，变更即硬错误；
6. 寙钥移入凭据保管（ctx.credentials），配置文件只留引用；
7. 连接状态可观测（状态点 + 最近错误），断线可恢复；
8. 错误分类 + 本地化文案，不暴露原始堆栈；
9. 危险操作（删除）二次确认；
10. 界面语言跟随应用语言（DSH locale 服务，zh/en）。

---

## 3. 设计原则

- **不破坏现有数据**：老 profiles.json 自动迁移（见 W1.3），不要求用户手工改文件。
- **纯 JSON RPC 边界**：所有新能力走 `remote.*` 方法（harness.handle + HTTP 桥双注册），参数/返回纯 JSON。
- **浏览器永不见密钥值**：statusAll/save 响应不含 password/passphrase；编辑时空白=保持。
- **主题一致**：CSS 全部用 `--dsw-alias-*` 令牌 + 少量 color-mix，两种配色方案下都正确。
- **单文件客户端不动摇**：client.js 仍是 classic script（ModuleLoader 契约），内部按 section 组织；不引入构建链（列入 §7 的可选项）。
- **每一步可验证**：npm test（docker sshd）+ 二号实例 GUI 冒烟（3090 端口），主线 3080 由你重启后生效（profile 是 link 安装，无需重装）。

---

## 4. 工作包详细设计

### W1 认证体验重构（P0）

**W1.1 认证方式只留两种**

- client.js：下拉删掉 agent 选项；用两枚 segmented 单选（密码 / 密钥）替代下拉，视觉更快。
- transport.js：删除 agent 分支与 `DEFAULT_KEY_CANDIDATES`；`auth` 仅认 `password` / `key`，其他值直接抛出可读错误。
- tools.js：remote_connect 的 `auth` 描述改为 `password | key`。

**W1.2 表单联动与校验**

- 选"密码"→ 显示：密码（带 👁 可见性切换、编辑时 placeholder "留空保持不变"）。
- 选"密钥"→ 显示：密钥路径（placeholder `~/.ssh/id_ed25519`，支持 `~` 与 `$HOME` 展开）+ 密钥口令（可空，带 👁）。
- 公共字段：名称（留空自动 `user@host`）、主机（必填）、端口（默认 22，校验 1–65535，数字入库修 B4）、用户（必填）。
- 保存前本地校验，未通过的字段即时红框 + 文案；服务端 upsertProfile 同样兜底校验。
- 按钮：**[测试连接]**（用当前表单值临时连一次，展示平台/指纹/耗时，不落库）+ **[保存]**；编辑时另有 [取消]。

**W1.3 数据迁移（agent → key）**

- profiles.js 读入时归一化：`auth:'agent'` → `'key'`，keyPath 取 `~/.ssh/id_ed25519 → id_rsa → id_ecdsa` 第一个存在的文件；找不到则留空并在 UI 上标"需要补填密钥路径"。
- 归一化同时做：port 强制 Number、字符串 trim、keyPath 展开 `~`（修 B2/B4）。
- 一次性把归一化结果写回文件（lazy：首次修改时持久化）。

**W1.4 保存语义（修 B1）**

- upsertProfile：`password === ''` 且已存 profile 有密码且 auth 未从 password 切走 → 保留旧值；passphrase 同理。
- 编辑回填时密码/口令留空（值本来就不下发），placeholder 提示"留空保持不变"。

### W2 远程目录浏览器（P0）

**W2.1 新 RPC：`remote.browse`**

- 入参 `{ id, path? }`；出参 `{ path, platform, home, entries: [{name,type,size,mtime}] }`。
- 行为：目标 profile 未连接则用存储凭据自动连接（复用 manager 连接表）；`path` 缺省取远端 HOME（SFTP realpath('.')）；返回排序后的目录（目录在前）+ 过滤隐藏文件可选。
- 配套 `remote.browseClose { id }`：浏览结束主动断开"仅为浏览而连"的连接（用户主动连接过的不动）。

**W2.2 浏览器弹窗组件（client.js 内）**

- 触发点：绑定目录字段的 [浏览…] 按钮（表单内），以及每张连接卡片的"浏览目录"动作。
- 交互：路径面包屑 + 返回上级；双击进入目录；单选目录后 [选择] 回填 bind_path；支持新建输入完整路径；Esc 关闭、焦点圈闭（a11y）。
- 未连接 profile 点浏览：先走连接（转圈 → 成功进根目录 / 失败给分类错误）。
- 顺带把 `remote_list` 工具的 render 对齐新条目结构（加 mtime）。

**W2.3 与"工作区"的关系（如实说明）**

- GUI 顶部"添加工作区"入口（directoryFlow 插槽）最终消费的是**本机绝对路径**（createWorkspace({path}) 走本机 fs.realpath），插件无法把 SSH 路径变成真正远程工作区——这需要上游 remote:// workspace seam（设计文档 M2/M4）。
- 本版本交付：插件内完整的远程目录选择（绑定目录）；选择完成后额外展示 `remote://user@host/path` 形态的引用串（可复制），供会话内 remote_* 工具使用。
- directoryFlow 插槽接入列入 §7 延后项，避免造出"看起来选中了、实际建了个坏的本地工作区"的假功能。

### W3 连接稳定性（P0）

- **连接对象状态机**：`connecting → connected → degraded(最近错误) → closed`；transport 监听 client 的 close/error/end，回调 manager。
- **manager 维护 lastError/lastSeenAt**；statusAll 输出加 `lastError`，UI 卡片副行显示（红色/黄色状态点）。
- **受限自动重连**：连接被远端/网络断开后，下一次 require（exec/read/…）先静默重连一次（凭据来自 profile，带 5s 超时）；连续失败 3 次内 60s 退避，超过则报 degraded 文案。不做后台无限重连。
- **错误分类表**（zh/en 双语）：ECONNREFUSED→"端口未开放或 sshd 未运行"、ETIMEDOUT→"连接超时（网络不可达/防火墙）"、ENOTFOUND→"主机名解析失败"、ENETUNREACH/EHOSTUNREACH→"网络不可达"、auth 类（All configured authentication methods failed）→"认证失败：检查用户名/密码/密钥"、Cannot parse privateKey→"密钥文件不存在、不可读或口令错误"。client 与工具 render 共用同一张映射（放 transport.js 导出，纯数据）。
- keepalive 15s/3 次（更快感知断线）；exec 超时后连接标记 degraded 供下次自愈。
- HTTP 桥请求体上限 1MB。

### W4 安全加固（P0：S1/S2；P1：S3）

- **S1 host key TOFU**：
  - profile 新增 `hostFingerprint`（sha256 base64，OpenSSH 同款格式）。
  - 首次连接：记录指纹 → UI 卡片/测试结果显示指纹（等宽字体）。
  - 之后连接：`hostVerifier` 比对，不匹配 → 硬错误，文案同时给出"记录的指纹/现在的指纹"，提示可能 MITM 或服务器重装。
  - 提供卡片菜单"重置指纹"（服务器重装后的显式重新信任）。
- **S2 HTTP 桥防 CSRF**：校验 `Origin` 头与请求 `Host` 同源（缺失 Origin 的同源/curl 放行），否则 403。
- **S3（P1）凭据迁移**：inject `['credentials']`（base bundle 必含）；密码/口令写入 `DSH_REMOTE_SECRET_<profileId>` 引用，profiles.json 只留 `passwordRef` 标记；resolve 按调用进行（连接时现取）。服务不可用的极简 headless 组合：回退现状（文件内字段），UI 显示存储模式徽标（"凭据库 / 本地文件"）。浏览器面永远只拿到 describe()（configured/writable），拿不到值。

### W5 UI/UX 翻新（P0）

- **设计令牌化**：全面换 `--dsw-alias-*`（bg-layer-1/2、border-l1/l2、label-primary/secondary/caption、state-success/error/warn-primary、interactive-bg-hover、state-business-primary 作主色、markdown-code-block 作输出底色），`color-scheme` 无关写法，深浅主题自动正确。
- **布局**：表单区（新增/编辑）与列表区分离；列表为卡片；移动端单列自适应（grid 1fr→minmax）。
- **连接卡片**：状态点（绿=connected / 灰=disconnected / 黄=degraded）+ 名称 + `user@host:port` + 认证徽标（密码=＊、密钥=🔑）+ 平台徽标 + 绑定目录；操作行：连接/断开（主/次按钮）、测试、浏览目录、编辑、删除（两步确认：再点一次"确认删除"，3s 恢复）。
- **命令测试面板**：加 profile 下拉（默认当前已连接项），输出带 stdout/stderr 分色与退出码徽标。
- **反馈**：操作结果用轻量 toast（右下角自动消失，成功/失败双色）；不再往页面堆 message 字符串。
- **空状态**：无 profile 时展示引导图示 + [添加第一个连接]。
- **i18n**：注册 `ctx.locale.register('settings.remoteConnections', { zh, en })`（服务缺失时回退 navigator.language）；settings.section 的 label 用 thunk 跟随语言；按钮/错误/占位符全部走字典。
- **a11y**：弹窗 role=dialog + 焦点圈闭 + Esc；表单 label 关联；图标按钮 aria-label。

### W6 工具面与开源卫生（P0）

- tools.js：remote_connect 补 `passphrase` 参数（修 B3）、auth 枚举更新、输出统一走错误分类；remote_status 输出加 lastError；remote_exec 增加默认 60s、上限 10min 约束说明。
- 代码整理：index.js 的 RPC 注册去重（harness.handle 与 HTTP 桥共用一张 method 表）；删除 `client.js.dynamic.bak`、`package.json.bak`。
- package.json：version 0.2.0、repository/bugs/homepage 补齐（`https://github.com/tsja2001/dsh-remote-ssh`）、engines.node>=18、description 去掉 agent 表述。
- 文档：README.md / README.zh.md 重写（新表单截图位、认证说明、**安全模型一节**：TOFU、CSRF 防护、凭据存储模式、明文回退的风险）、CHANGELOG.md（0.2.0 条目）、CONTRIBUTING.md（开发/测试如何跑）、docs/HANDOVER.md 增补 v0.2 记录。
- 测试（scripts/，node 原生 assert 风格保持一致）：
  - test-manager.js：迁移（agent→key）、空白密码保留、port 归一化、tilde 展开、错误分类映射、browse 自动连接与条目结构、browseClose。
  - test-ssh2.js：host key 指纹 pin 不匹配 → 拒绝；degraded 后自动重连一次成功。
  - CI 无需改动（sshd service 已有），新增用例自动进入。

---

## 5. 交付顺序与验收标准

按里程碑串行（每个完成后可独立验收）：

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | W1 全部 | 表单联动正确；编辑不改密码再保存→密码仍在；agent 老 profile 迁移后可连；npm test 绿 |
| M2 | W2 全部 | 浏览弹窗可导航/选择/回填 bind_path；未连接 profile 浏览时自动连接并关闭；GUI 冒烟通过 |
| M3 | W3 全部 | 手动 kill sshd → 卡片转 degraded + 中文原因；恢复 sshd → 下一次操作自动重连成功 |
| M4 | W4 S1/S2 + W5 | 首连显示指纹；改 known 指纹→硬错误带两个指纹；跨站 POST→403；深浅主题截图检查；语言切换生效 |
| M5 | W4 S3 + W6 | profiles.json 无明文密码（标准组合下）；npm pack 文件清单干净；CHANGELOG/README 完整；全量 npm test 绿 |

**验证环境说明**：docker 起临时 openssh-server（127.0.0.1:2222）跑 npm test；GUI 用二号实例（`--profile web-remote --port 3090`）冒烟；主线 3080 是 link 安装，你重启 `pnpm dsh web` + 刷新页面即生效（当前无 dev:web watcher，改动不会热更新）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| ssh2 hostVerifier 与重连交互复杂 | 指纹校验只在 connect 时做；重连走同一 connect 路径 |
| ctx.credentials 在某些组合缺失 | inject 失败时回退文件存储并显示存储模式徽标 |
| classic script 体量增长 | 按"常量→工具→子组件→页面"分节 + 注释目录；不引入构建链 |
| 老 profile 迁移引入数据损坏 | 迁移只增不改语义；先写迁移测试再动 loadProfiles；备份原文件一次（profiles.json.bak 于同目录，0600） |
| 删 agent 认证让依赖它的用户破防 | CHANGELOG 显著说明 + 迁移说明（转 key 显式路径） |

## 7. 明确不做 / 延后（v0.2 之外）

1. **directoryFlow 工作区接入**：上游 createWorkspace 只认本机路径，需要 remote:// workspace seam（原路线图 M2/M4），假接入弊大于利。
2. 跳板机（ProxyJump）、端口转发/预览隧道、远程终端面板、LSP —— 维持原路线图排期。
3. known_hosts 文件互操作（读系统 known_hosts 验证）—— P2 候选。
4. client.js 构建链（TS/esbuild 拆分）—— 现阶段单文件足够，发布后按反馈决定。
5. 密码/密钥的输入法加密存储（DPAPI/keychain 级别）—— ctx.credentials 已是 DSH 官方答案。
