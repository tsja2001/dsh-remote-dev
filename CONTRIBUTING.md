# 贡献指南 / Contributing

感谢关注 dsh-remote-ssh！/ Thanks for your interest!

## 开发环境 / Setup

```sh
git clone https://github.com/tsja2001/dsh-remote-ssh.git
cd dsh-remote-ssh
npm install
```

要求：Node ≥ 18；本地验证建议有 docker（跑一次性 sshd），但不是必须 —— 测试脚本可用环境变量指向任意可达 sshd。

## 测试 / Testing

```sh
# 首选：docker 起一次性 sshd（密码 + 密钥认证都有）
docker run -d --name dsh-sshd-test -p 2222:2222 \
  -e PUID=1000 -e PGID=1000 -e TZ=UTC -e SUDO_ACCESS=true \
  -e USER_NAME=dev -e USER_PASSWORD=test1234 -e PASSWORD_ACCESS=true \
  -e PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)" \
  linuxserver/openssh-server
npm test

# 无 docker：指向任意 sshd（示例：仅密钥认证）
DSH_TEST_HOST=127.0.0.1 DSH_TEST_PORT=22 DSH_TEST_USER=$USER \
DSH_TEST_NO_PASSWORD=1 DSH_TEST_KEY=$HOME/.ssh/id_ed25519 npm test
```

两个测试面：`scripts/test-ssh2.js`（传输层）与 `scripts/test-manager.js`（管理器/存储语义）。CI（`.github/workflows/ci.yml`）在 GitHub Actions 里用同样方式跑。

改传输层（`transport.js`）或存储语义（`profiles.js`）前，请先确认本地 `npm test` 绿。

## 代码结构 / Code map

```
packages/remote-ssh/
├── index.js      # Host 插件：RemoteManager + RPC 表（harness.handle 与 HTTP 桥共用）
├── transport.js  # ssh2 传输层（唯一碰 SSH 协议的文件；状态机 + 错误分类 + TOFU）
├── profiles.js   # profile 存储（规范化/迁移/空白保留语义）
├── tools.js      # remote_* 模型工具
├── client.js     # 浏览器设置页（classic script；设计令牌 + zh/en）
└── cordis.patch.yml
```

约定：
- RPC 方法名以 `remote.` 为前缀，参数/返回值必须纯 JSON，且**不得包含密钥值**。
- 浏览器面 client.js 是 CLASSIC script：不能用 `export` / `import`；样式只用 `--dsw-alias-*` 设计令牌；文案进 DICT（zh/en 双语都要有）。
- 新增用户可见错误时，先在 `transport.js` 的 `ERROR_TEXT` / `classifyError` 里给分类码与双语文案。

## GUI 冒烟 / Manual smoke

```sh
# 主仓库（DSH checkout）内：
dsh plugin --profile web-remote add <本仓库>/packages/remote-ssh
dsh plugin --profile web-remote add <DSH>/packages/bundle/web-app   # 本地 link
dsh --profile web-remote --port 3090
```

然后浏览器打开 http://127.0.0.1:3090 → 设置 → Remote Connections，验证：保存（空白密码编辑保留）、测试连接、连接/断开、浏览目录、命令测试、删除两步确认、深浅主题、中英切换。

## 提交 / PR

- 一个 PR 一件事；描述里附测试输出。
- 涉及行为变化请更新 CHANGELOG.md 与 README（中英两份如有）。
- 安全相关改动（认证、指纹、CSRF、凭据）请在 PR 里显式说明影响面。
