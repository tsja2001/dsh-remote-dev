# Changelog

## Unreleased

### 发布可靠性
- npm 发布身份统一为用户 scope `@tsja/dsh-remote-ssh`，并同步插件清单、客户端模块 ID、Preset、安装命令与发布验证。
- 根项目正式声明 npm workspace，使本地 `link:` 开发安装能够从插件的生产依赖声明构建完整依赖树。
- `package:check` 现在会把真实 tarball 安装进全新的临时消费者并导入公开入口，发布前验证 `ssh2` 等运行时依赖确实可用。
- CI 与发布工作流改为等待真实 SSH 握手，避免端口刚监听但 sshd 尚未就绪时提前启动集成测试。

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
