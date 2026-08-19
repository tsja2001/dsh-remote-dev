# npm 与 GitHub 发布指南

本仓库的可发布包位于 `packages/remote-ssh`，包名为 `dsh-remote-dev`。根目录只是开发与测试工作区，已设置 `private: true`，不会被误发到 npm。

## 发布身份

当前配置使用以下公开身份：

- npm：`dsh-remote-dev`
- GitHub：`tsja2001/dsh-remote-ssh`
- 默认分支：`main`

首次发布前必须确认 `npm whoami` 返回 `tsja`；`@tsja/*` 是该 npm 用户自己的 scope，与 GitHub 用户名 `tsja2001` 相互独立。npm trusted publishing 要求 `package.json` 中的 `repository.url` 与实际 GitHub 仓库完全一致。

不要为了“先发出去”改用 `dsh-remote-ssh`：该无 scope 包名已经被其他项目占用。

## 已配置内容

- 包入口、exports 与明确的 `files` 白名单
- 根包防误发布（`private: true`）
- Node.js 18+ engine 约束
- npm 搜索关键词、description、homepage、repository、bugs
- scoped public package 的 `publishConfig.access=public`
- 包内 README、中文说明与 MIT LICENSE
- 发布前 JavaScript 语法检查
- GitHub Actions CI
- 基于 GitHub Release 的 npm trusted publishing 与 provenance

任何 npm token、密码或私钥都不应该写进 `.npmrc`、workflow 或仓库文件。

## 发行前本地检查

使用 Node.js 18 或更高版本：

~~~sh
node --version
npm --version
npm ci
~~~

启动一次性测试 SSH 服务：

~~~sh
docker run -d --name dsh-sshd-test -p 2222:2222 \
  -e PUID=1000 -e PGID=1000 -e TZ=UTC -e SUDO_ACCESS=true \
  -e USER_NAME=dev -e USER_PASSWORD=test1234 -e PASSWORD_ACCESS=true \
  linuxserver/openssh-server
~~~

运行完整检查：

~~~sh
npm run release:check
~~~

它会执行真实 SSH/SFTP 集成测试、源码语法检查和 `npm pack --dry-run`。打包清单应只包含：

~~~text
LICENSE
README.md
README.zh.md
client.js
cordis.patch.yml
index.js
package.json
profiles.js
tools.js
transport.js
~~~

还建议安装实际 tarball 做一次最终冒烟：

~~~sh
cd packages/remote-ssh
npm pack
dsh plugin --profile publish-smoke add ./tsja-dsh-remote-ssh-0.3.0.tgz
dsh --profile publish-smoke
~~~

确认 Web 设置页出现 **Remote Connections**，并实际完成：测试连接、保存、连接、执行命令、浏览目录、断开与删除。

## 第一次手动发布

先登录并确认 scope 权限：

~~~sh
npm login
npm whoami
npm access list packages @tsja
~~~

随后从包目录公开发布：

~~~sh
cd packages/remote-ssh
npm publish --access public
~~~

npm 的 scoped package 默认可能是 private，因此虽然 `package.json` 已配置 `publishConfig.access=public`，第一次发布仍显式写出 `--access public`，便于人工复核。

发布后验证元数据和安装路径：

~~~sh
npm view dsh-remote-dev
npm view dsh-remote-dev dist.tarball
dsh plugin --profile web add dsh-remote-dev
~~~

## 配置 trusted publishing

首次包创建成功后，在 npm 包设置中添加 GitHub Actions trusted publisher：

- Organization or user：`tsja2001`
- Repository：`dsh-remote-ssh`
- Workflow：`publish.yml`
- Environment：`npm`

GitHub 仓库中也创建名为 `npm` 的 Environment，建议开启必要的审批与分支/标签保护。

配置完成后不需要 `NPM_TOKEN`。发布 workflow 具有 `id-token: write` 权限，并执行：

1. 校验 Release tag 必须等于包版本（例如 `v0.3.0`）。
2. 安装依赖并运行 SSH 集成测试。
3. 检查 npm tarball 内容。
4. 通过 OIDC 发布 public package。
5. 为 npm 版本生成 provenance attestation。

## 日常发版

1. 更新 `packages/remote-ssh/package.json` 的版本号。
2. 同步更新 `CHANGELOG.md`，需要时更新 README。
3. 运行 `npm run release:check`。
4. 提交并推送到受保护的默认分支。
5. 创建与版本完全相同的 Git tag，例如 `v0.3.1`。
6. 在 GitHub 创建并发布该 tag 对应的 Release。
7. 等待 `.github/workflows/publish.yml` 完成。
8. 用 `npm view` 和全新 DeepSeek Harness profile 做安装验证。

注意：npm 包页面上的 README 只有在发布新版本时才会更新。

## GitHub 可发现性与 SEO

README 和 npm keywords 已覆盖 DeepSeek Harness、DSH plugin、AI coding agent、SSH、SFTP、remote development、remote execution、Linux、Windows 与 DevOps 等真实能力。仓库创建后还需要在 GitHub 页面完成：

- Description：`AI-native SSH remote development plugin for DeepSeek Harness — remote exec, file operations, and connection management without a remote agent.`
- Website：`https://www.npmjs.com/package/dsh-remote-dev`
- Topics：`dsh-plugin`、`deepseek-harness`、`deepseek`、`ai-agent`、`ai-coding-agent`、`ssh`、`sftp`、`remote-development`、`devops`
- 启用 Issues 与 Discussions
- 设置与 README 首屏一致的 Social preview
- 发布首个 GitHub Release

[DeepSeek Harness 官方 README](https://github.com/deepseek-ai/DeepSeek-Harness) 明确建议插件仓库添加 `dsh-plugin` topic，这是生态发现入口，不要遗漏。

## 发布失败排查

### 403 或 scope 权限不足

确认 `npm whoami` 返回 `tsja`，且 2FA、granular token 或 trusted publisher 策略允许发布。不要通过关闭安全设置来绕过。

### trusted publishing 拒绝仓库

核对 npm 设置中的 owner、repository、workflow filename、environment，以及 `package.json.repository.url`，大小写和路径都必须匹配。

### tag 与版本不一致

workflow 会主动拒绝。例如包版本为 `0.3.1` 时只接受 `v0.3.1`。

### 包能发布但 DSH 加载失败

先检查：

~~~sh
npm run package:check
dsh --profile web --dump-config
~~~

确认 tarball 含 `cordis.patch.yml`、所有 JavaScript 入口和 README；再核对当前 DeepSeek Harness developer preview 版本是否引入了插件 API 破坏性变化。
