# @dsh-remote/remote-ssh

为 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 提供 AI 原生 SSH 远程开发能力：让模型连接远程设备、执行命令，并通过 SFTP 读取、写入或浏览文件；远端无需安装 Agent。

## 安装

~~~sh
dsh plugin --profile web add @dsh-remote/remote-ssh
dsh --profile web
~~~

随后打开 **设置 → 远程连接**，添加密码或私钥配置，先测试再保存并连接。

插件提供 `remote_status`、`remote_connect`、`remote_disconnect`、`remote_exec`、`remote_read`、`remote_write` 与 `remote_list` 七个模型工具，并包含连接管理、SFTP 目录浏览、主机指纹固定、凭据保护、受限重连、错误分类和中英双语界面。

完整使用说明、安全模型、Windows 指南与本地测试方法请阅读仓库的[中文 README](https://github.com/tsja2001/deepSeek-harness-remote-ssh/blob/main/README.zh.md)。

本项目采用 [MIT License](https://github.com/tsja2001/deepSeek-harness-remote-ssh/blob/main/LICENSE)，是社区维护插件，并非 DeepSeek AI 官方产品。
