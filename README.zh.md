<h1 align="center">DeepSeek Harness Remote SSH</h1>

<p align="center">
  <strong>让 AI 编程 Agent 安全地跨过 SSH，直接抵达你的任意一台设备。</strong><br>
  在 DeepSeek Harness 会话里执行远程命令、查看工程、读写文件；远端无需安装任何 Agent。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dsh-remote/remote-ssh"><img alt="npm 版本" src="https://img.shields.io/npm/v/%40dsh-remote%2Fremote-ssh?logo=npm&color=CB3837"></a>
  <a href="https://www.npmjs.com/package/@dsh-remote/remote-ssh"><img alt="npm 下载量" src="https://img.shields.io/npm/dm/%40dsh-remote%2Fremote-ssh?logo=npm&color=CB3837"></a>
  <a href="https://github.com/tsja2001/dsh-remote-ssh/actions/workflows/ci.yml"><img alt="CI 状态" src="https://github.com/tsja2001/dsh-remote-ssh/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-2ea44f"></a>
  <a href="packages/remote-ssh/package.json"><img alt="Node.js 18 或更新版本" src="https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=nodedotjs&logoColor=white"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · 简体中文 ·
  <a href="#三分钟开始使用">快速开始</a> ·
  <a href="#给模型的远程工具">工具列表</a> ·
  <a href="#安全模型">安全模型</a>
</p>

<p align="center">
  <img src="docs/images/remote-connections.png" alt="DeepSeek Harness Remote SSH 连接设置界面，通过 Tailscale 连接远程设备" width="100%">
</p>

## 这是什么？

DeepSeek Harness Remote SSH 是一款开源的 **[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) SSH 远程开发插件**。它为模型提供 `remote_connect`、`remote_exec`、`remote_read`、`remote_write` 等 7 个原生工具，并提供一套完整的 Web 连接管理界面，可连接 Linux、macOS、WSL 与 Windows SSH 设备。

模型仍然运行在 DeepSeek Harness 中，但源码、构建环境、GPU 服务器、家庭实验室、云主机或边缘设备可以在任何 SSH 可达的位置。

> 装好一个插件，保存一条连接，然后直接让 AI 去远端排查、修改、构建、测试或运维。

## 为什么值得用？

| 能力 | 带来的体验 |
| --- | --- |
| **为 AI 设计的 SSH 工具** | 模型通过结构化工具连接设备、执行命令、查看状态，并读写远程文本文件和目录。 |
| **远端零安装** | 目标机只需要 SSH Server 和一个可登录账户，不必部署守护进程、运行时或专有 Agent。 |
| **完整 Web 管理界面** | 新建、测试、编辑、连接、浏览、删除连接都能在设置页完成，无需手改 JSON。 |
| **密码与密钥认证** | 支持密码、显式私钥路径、加密私钥口令和 `~` 路径展开。 |
| **理解 Linux 与 Windows** | 自动判断 POSIX 或 Windows 默认 shell，给模型正确的命令语境。 |
| **失败时保持克制** | 主机指纹固定、受限重连、错误分类、同源 API 保护，浏览器端永不回显凭据。 |
| **中英双语** | 界面跟随 DeepSeek Harness 的应用语言切换简体中文或英文。 |

## 三分钟开始使用

### 环境要求

- Node.js 18 或更高版本
- [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 及 `dsh` CLI
- 一台网络可达、支持密码或私钥登录的 SSH 设备

### 1. 安装插件

~~~sh
dsh plugin --profile web add @dsh-remote/remote-ssh
dsh --profile web
~~~

如果通过 `npx` 使用 DeepSeek Harness，在两条命令前加上 `npx @deepseek-ai/dsh` 即可。

### 2. 添加连接

打开 **设置 → 远程连接**，填写主机、端口、用户名与认证方式。建议先点 **测试连接**，确认平台、主机指纹与延迟后再保存。常用工程目录还可以通过内置 SFTP 浏览器进行绑定。

### 3. 直接用自然语言安排远程任务

例如：

> 连接 staging 配置，检查 `/srv/app` 里的项目，运行测试并解释失败原因；暂时不要修改文件。

> 读取服务器上最新的 nginx 错误日志，判断最可能的根因并给出排查顺序。

> 去 Windows 构建机列出项目目录，然后执行仓库中现有的构建命令。

插件会自动向系统提示词注入工具使用说明，模型知道如何发现连接配置以及怎样组合 `remote_*` 工具。

## 给模型的远程工具

| 工具 | 作用 |
| --- | --- |
| `remote_status` | 列出已保存配置、连接状态、远端平台与最近一次分类错误。 |
| `remote_connect` | 使用已保存配置，或临时的主机凭据建立 SSH 连接。 |
| `remote_disconnect` | 关闭指定配置的活动连接。 |
| `remote_exec` | 执行远程命令，返回 stdout、stderr、退出状态；超时上限 10 分钟。 |
| `remote_read` | 通过 SFTP 读取 UTF-8 文本文件。 |
| `remote_write` | 通过 SFTP 写入完整的 UTF-8 文本内容。 |
| `remote_list` | 列出目录项及类型、大小、修改时间，并将目录优先返回。 |

设置页和模型工具共用同一个连接管理器：

~~~text
DeepSeek Harness 会话 / Web 设置页
                 │
           remote_* 工具或 RPC
                 │
        RemoteManager + 连接配置
                 │
          SSH 命令 + SFTP 文件
                 │
      Linux · macOS · WSL · Windows
~~~

## 远程目录浏览器

连接卡片和绑定目录字段旁都可以点击 **浏览…**，直接通过 SFTP 查看远端目录。浏览器支持面包屑、返回上级、回到主目录、目录优先排序和键盘操作。选中路径后，还能复制 `remote://user@host/path` 引用，把准确位置带进会话上下文。

## 添加工作区时选择远程目录

插件还会接管“选择工作区目录”弹窗（工作区入口的添加目录对话框）。弹窗保留原有的本机浏览体验，并新增远程一侧：

- 底部悬浮按钮 **选择远程机器上的目录…** 切到远程页签；
- 远程页签列出所有已配置机器（状态点、地址、当前绑定）；未连接的机器点击即自动连接并浏览其目录；
- 确认目录后即绑定为该机器的 **远程工作上下文**：`remote_*` 工具的相对路径以它为基准、`remote_exec` 默认在其中执行，系统提示会告诉模型哪个远程目录是主工作目录（最近绑定优先）。

卸载插件即恢复原生的本机目录弹窗。

> 边界说明：DSH 工作区注册表本身只认本机路径（`createWorkspace` 在 Host 本机解析路径），因此远程选择成为上述会话级远程工作上下文，而不是一条工作区记录。真正的 `remote://` 工作区需要上游 `ctx.fs`/`ctx.subprocess` Provider 缝（见 `docs/remote-development-design.md` 路线图）。

## 安全模型

远程执行能力很强，因此本项目把安全边界写得尽量明确：

- **首次使用信任（TOFU）：** 首次握手成功后保存 OpenSSH 风格的 SHA256 主机指纹；后续若发生变化会立即拒绝连接并展示新旧指纹。重要设备建议通过另一条可信渠道核对首次指纹。
- **凭据保护：** 标准 DeepSeek Harness 组合通过 `ctx.credentials` 保存密码与私钥口令，配置文件只留引用；极简组合才会回退到权限为 `0600` 的 `~/.dsh/remote/profiles.json`。
- **密钥不回显：** API 响应不会包含密码或口令；编辑时将凭据留空会保留原值。
- **浏览器同源保护：** `/dsh-remote/api/*` 拒绝跨源请求，请求体限制为 1 MiB。
- **密钥路径必须显式指定：** 插件不会静默尝试 `~/.ssh` 下的所有密钥。
- **仍应遵守最小权限：** 命令拥有 SSH 账户本身的权限；“绑定目录”只是易用性设置，并不是操作系统级沙箱。高风险任务请使用专用账户、容器或虚拟机。

## 连接稳定性

- Keepalive 会检测失效连接，下一次操作可使用保存的配置自动恢复。
- 每个连接配置在 60 秒内最多尝试重连 3 次，避免无限重试。
- 认证失败、密钥文件、DNS、超时、拒绝连接、网络不可达、连接重置和主机指纹错误都有中英双语分类文案。
- 命令默认超时 30 秒，最高 10 分钟。
- 命令和 SFTP 操作复用同一条连接；连接关闭后会从活动表中移除，不留下“假在线”状态。

## Windows、局域网与 Tailscale

Windows 目标机需要启用 [OpenSSH Server](https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse)，并在防火墙中放行 SSH 端口。原生 Windows SSH 默认通常是 `cmd.exe`；如果登录后进入 WSL，则会被识别为 POSIX 环境。

主机地址可以是域名、局域网 IP、公网 IP、VPN 地址，也可以是 Tailscale 一类私有组网地址。唯一要求是：运行 DeepSeek Harness 的机器能够访问对应 SSH 地址与端口。

## 本地开发与测试

先启动一个一次性的 SSH 测试容器：

~~~sh
docker run -d --name dsh-sshd-test -p 2222:2222 \
  -e PUID=1000 -e PGID=1000 -e TZ=UTC -e SUDO_ACCESS=true \
  -e USER_NAME=dev -e USER_PASSWORD=test1234 -e PASSWORD_ACCESS=true \
  linuxserver/openssh-server

npm ci
npm test
npm run package:check
~~~

把本地代码安装进 Web profile：

~~~sh
dsh plugin --profile web add ./packages/remote-ssh
~~~

集成测试支持 `DSH_TEST_HOST`、`DSH_TEST_PORT`、`DSH_TEST_USER`、`DSH_TEST_PASSWORD`、`DSH_TEST_KEY` 与 `DSH_TEST_NO_PASSWORD=1`，因此也可以使用任意一次性 SSH 测试机。

## 当前限制

- 添加工作区时选择的远程目录是 *远程工作上下文*（`remote_*` 工具与系统提示的绑定目录），不是一条 DSH 工作区记录：工作区注册表本身在 Host 本机解析路径。
- `remote_read` 与 `remote_write` 目前面向 UTF-8 文本，不是二进制传输工具。
- 暂不支持 ProxyJump、端口转发、远程终端、LSP 和 `known_hosts` 互操作。
- Windows 传输层与默认 shell 命令执行已经支持，但目前最完整的集成测试覆盖仍在 POSIX 目标上。
- DeepSeek Harness 尚处于 developer preview，未来可能出现插件 API 的破坏性变更。

## 常见问题

<details>
<summary><strong>这是 SSH MCP Server 吗？</strong></summary>

不是。它解决了相似的 AI 访问 SSH 场景，但本项目是原生 DeepSeek Harness bundle；工具、设置界面、凭据服务和系统提示词都直接参与 Harness 插件架构。
</details>

<details>
<summary><strong>远端必须安装 Node.js 或 DeepSeek Harness 吗？</strong></summary>

不需要。远端只需要 `sshd`、SFTP 和可登录账户；Node.js 与 DeepSeek Harness 都运行在本地主机。
</details>

<details>
<summary><strong>连接配置存在哪里？</strong></summary>

默认位于 `~/.dsh/remote/profiles.json`，设置了 `$DSH_HOME` 时则位于 `$DSH_HOME/remote/profiles.json`。凭据服务可用时，敏感值由它单独保管。
</details>

<details>
<summary><strong>支持 Tailscale、WireGuard、VPN 或局域网吗？</strong></summary>

支持。只要 DeepSeek Harness 所在机器能够访问 SSH 地址和端口，传输层并不限制具体网络形态。
</details>

## 更多文档

- [架构设计与路线图](docs/remote-development-design.md)
- [npm 与 GitHub 发布指南](docs/PUBLISHING.md)
- [维护交接文档](docs/HANDOVER.md)
- [优化方案](docs/OPTIMIZATION-PLAN.md)
- [变更日志](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)

## 项目状态

这是一个社区维护项目，并非 DeepSeek AI 官方产品；DeepSeek Harness 本身目前仍处于 developer preview。

欢迎提交可复现的 SSH 兼容性报告、Windows 测试结果、安全审查意见和范围清晰的 Pull Request。参与前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开源许可

[MIT](LICENSE) © 2026 dsh-remote contributors
