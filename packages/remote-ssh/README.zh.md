# dsh-remote-dev

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提供 AI 原生 SSH 远程开发能力：把远程机器上的目录直接添加为工作区，在它下面新建会话开发，和本地工作区完全一样；远端无需安装 Agent。

## 安装

一条命令装好：

~~~sh
npx dsh-remote-dev@latest setup          # 默认安装到 web profile
~~~

随后启动 Harness（`dsh --profile web`），打开 **设置 → 远程连接**，添加密码或私钥配置，先测试再保存并连接。

安装器做的事：`dsh plugin add` 内部调用 pnpm，而 pnpm 11 遇到任何带构建脚本的依赖都会直接失败（`ERR_PNPM_IGNORED_BUILDS`），此时 `dsh` 不会把插件登记进 profile——包下载了却不会加载。本插件唯一依赖 `ssh2` 带两个**可选**原生编译脚本（它自身的 `install` 与可选依赖 `cpu-features` 的 node-gyp），而 ssh2 是纯 JavaScript 实现、没有原生模块时自动回退到 Node crypto，因此这两个构建被明确拒绝——不需要本机编译环境。安装器把这个决定写进 profile 后再执行安装并校验结果：

~~~yaml
# ~/.dsh/profiles/web/pnpm-workspace.yaml
allowBuilds:
  ssh2: false
  cpu-features: false
~~~

有了这两行，直接执行 `dsh plugin --profile web add dsh-remote-dev` 也能成功。

## 远程工作区

在左侧工作区栏点击 **添加工作区 → 远程机器**，选择设备、浏览到目录并确认。

该目录会变成一个普通的工作区（显示为 `app [SSH: buildbox]`）。在它下面新建的每个会话，
read/write/edit/glob/grep/bash 都直接作用在**那台机器的那个目录里** —— 工具、卡片、相对路径
都与本地工作区一致；远端不需要装任何东西，也不需要每次手动切换预设，重新打开旧会话仍然回到
同一个远程世界。

实现方式：DSH 的工作区必须是宿主上真实存在的目录（注册表用 `fs.realpath` 归一化，并按会话
header 的 `cwd` 分组），因此 `remote://` 永远不可能成为工作区。插件为每个远程根目录保留一个
空的本地**锚点目录**（只用于给侧边栏一个稳定身份），真正的执行世界则来自自动生成的 **agent
预设**：预设里 `fs` 与 `shell` 两个服务被 `isolate` 成本插件的 SSH 实现。预设由你的默认预设
派生而来，因此远程会话保留本地会话的全部能力（persona、AGENTS.md、skills、todo、plan 模式、
上下文压缩、子智能体等）；会落到本机的行（宿主文件系统 / 宿主 shell / 本地 pty）在该 realm 内
被禁用，`{{cwd}}` 也指向远程目录。改动默认预设后，远程预设会在下次使用时自动重新生成。

移除远程工作区只删除侧边栏条目并保留生成的预设（这样历史会话仍能打开）；如需彻底清理，在
**设置 → 远程连接** 的移除确认里勾选「同时删除生成的预设」。

插件提供 `remote_status`、`remote_connect`、`remote_disconnect`、`remote_exec`、`remote_read`、`remote_write` 与 `remote_list` 七个模型工具，并包含连接管理、SFTP 目录浏览、主机指纹固定、凭据保护、受限重连、错误分类和中英双语界面。

完整使用说明、安全模型、Windows 指南与本地测试方法请阅读仓库的[中文 README](https://github.com/tsja2001/dsh-remote-dev/blob/main/README.zh.md)。

本项目采用 [MIT License](https://github.com/tsja2001/dsh-remote-dev/blob/main/LICENSE)，是社区维护插件，并非 DeepSeek AI 官方产品。
