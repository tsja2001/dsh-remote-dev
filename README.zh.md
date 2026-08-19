<h1 align="center">DeepSeek Harness Remote Dev</h1>

<p align="center">
  <strong>连接远程 SSH 服务器，像在本地环境一样开发</strong><br>
  在 DeepSeek Harness 中浏览、编辑、执行命令和运行测试；远端无需安装任何 Agent。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-remote-dev"><img alt="npm 版本" src="https://img.shields.io/npm/v/dsh-remote-dev?logo=npm&color=CB3837"></a>
  <a href="https://github.com/tsja2001/dsh-remote-dev/actions/workflows/ci.yml"><img alt="CI 状态" src="https://img.shields.io/github/actions/workflow/status/tsja2001/dsh-remote-dev/ci.yml?label=CI"></a>
  <a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/license-MIT-2ea44a"></a>
</p>

<p align="center">
  <a href="README.en.md">English</a> · 简体中文 ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#远程工作区">远程工作区</a> ·
  <a href="#安全边界">安全边界</a>
</p>

<p align="center">
  <img src="截图1.png" alt="在 DeepSeek Harness 中配置 SSH 远程连接" width="100%">
</p>

<p align="center">
  <img src="截图2.png" alt="在远程 SSH 工作区中像本地一样开发" width="100%">
</p>

## 这是什么？

DeepSeek Harness Remote Dev 是一个 SSH 远程开发插件：连接任意可访问的 SSH 服务器，把远程目录直接加入 DeepSeek Harness 工作区。像 VS Code Remote Development、Claude Code 和 Codex 的远程开发一样，界面运行在本机，但文件、命令和测试可以直接作用于远程机器。

无需在远程服务器安装任何服务，目标机器只需要提供 SSH Server 和一个可登录账户；Node.js、DeepSeek Harness 和插件都运行在本机。

## 核心体验

- **SSH 直连**：支持 Linux、macOS、WSL 和 Windows SSH 服务器。
- **像本地一样开发**：选择远程目录后，read、write、edit、glob、grep、bash 等标准工具自动在远端运行。
- **完整 Web 管理**：在设置中添加、测试、编辑、连接和浏览远程设备，无需手改配置文件。
- **密码或密钥认证**：支持密码、显式私钥、私钥口令和主机指纹校验。
- **AI 原生工具**：可使用 remote_connect、remote_exec、remote_read、remote_write、remote_list 处理临时任务。

## 快速开始

在你的 DeepSeek Harness 项目根目录下运行：


~~~sh
# 推荐方式：通过 pnpm 一键安装并注册插件
pnpm dsh plugin --profile web add dsh-remote-dev

# 若已将 dsh 安装为系统全局命令：
dsh plugin --profile web add dsh-remote-dev
~~~

### 连接远程机器

1. 打开 **设置 → 远程连接**。
2. 填写主机、端口、用户名和认证方式，点击 **测试连接** 后保存。
3. 打开 **添加工作区 → 远程机器**，选择远程目录。

确认后，远程目录会出现在左侧工作区列表中。该工作区下新建的会话会自动使用远程文件和 Shell。

## 远程工作区

远程工作区是本插件的主要使用方式：

- 远程目录显示为普通工作区，例如 app [SSH: buildbox]；
- read、write、edit、glob、grep 通过 SFTP 操作远程文件；
- bash 通过 SSH 在远程目录中执行命令；
- 相对路径以远程目录为基准，宿主机路径不会泄漏给模型；
- persona、AGENTS.md、skills、todo、plan 和子 Agent 等其他会话能力继续保留。

如果只需要临时执行远程命令，也可以直接调用 remote_* 工具，不必创建工作区。

## 支持的工具

| 工具 | 用途 |
| --- | --- |
| remote_status | 查看连接配置、状态、平台和最近错误 |
| remote_connect | 连接已保存的配置或临时主机 |
| remote_disconnect | 断开连接 |
| remote_exec | 通过 SSH 执行命令 |
| remote_read / remote_write | 通过 SFTP 读写 UTF-8 文本 |
| remote_list | 通过 SFTP 浏览远程目录 |

## 安全边界

- 首次连接记录并校验 SSH 主机指纹；
- 凭据由 DeepSeek Harness 凭据库保存，浏览器不会回显密码或私钥口令；
- 远程命令使用 SSH 账户本身的权限；
- 绑定目录是工作区语义，不是操作系统沙箱；
- 高风险任务请使用专用账户、容器或虚拟机。

## 本地开发

~~~sh
npm ci
npm run test:offline
npm run check
npm run package:check
~~~

把当前源码安装到 Web profile：

~~~sh
dsh plugin --profile web add ./packages/remote-ssh
~~~

更多信息：

- [远程开发设计](docs/remote-development-design.md)
- [npm 与 GitHub 发布指南](docs/PUBLISHING.md)
- [维护交接文档](docs/HANDOVER.md)
- [变更日志](CHANGELOG.md)
- [MIT License](LICENSE)
