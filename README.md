# pichamber

一个跑在 [pi](https://github.com/earendil-works/pi) 编码代理之上的、类 [openchamber](https://github.com/openchamber/openchamber) 界面的 Web 工作台。

核心思路:**vendor openchamber 的 UI 源码 + 一个 opencode 兼容适配层**,让 openchamber 的界面以为自己连的是 opencode,实际上底层是 pi。

## 架构

```
packages/ui       vendored openchamber UI(React 19 + Vite 7 + Tailwind 4)
                  ↓ 调 @opencode-ai/sdk
packages/web      opencode 兼容 HTTP + SSE 服务(Express)
packages/agent    pi → opencode Session/Message/Part 适配层(唯一 import pi SDK 的包)
                  ↓
pi SDK            底层引擎
```

- **bun** 仅作包管理器,**运行时 Node ≥ 22**(保证 pi SDK 兼容)
- 无数据库:会话用 pi 的 JSONL + 配置文件
- `packages/electron` 为占位(桌面壳后续再做)

## 快速开始

```bash
bun install
PORT=30142 bun run --filter @pichamber/web dev
```

打开 `http://localhost:30142`。

## Docker 部署

compose 直接拉取预构建的 GHCR 镜像(`ghcr.io/molicherry/pichamber:latest`),**不做本地构建**。CI 在 `v*` tag 上构建并推送镜像(同时打 `latest` + 版本 tag);main 分支的 push 只构建验证、不推送。

```bash
# 1. 准备 models.json(含 API key,不打包进镜像)
#    确保 ~/.pi/agent/models.json 存在,compose 会只读挂载到 /app/.pi-agent/models.json

# 2. (可选)复制环境变量模板,按需填 PICAMBER_PASSWORD / PICAMBER_TOKEN / PICAMBER_ALLOWED_ORIGIN
cp .env.example .env

# 3. 启动
docker compose up -d
```

打开 `http://localhost:8787`。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `PICAMBER_PASSWORD` | 可选。设置后浏览器打开会弹密码门(openchamber 的 desktop-ui-password 等价物),登录成功后种 session cookie;不设则密码门关闭 |
| `PICAMBER_TOKEN` | 可选。静态 bearer token,用于 API/自动化客户端(`Authorization: Bearer <token>` 或 `?token=`),不影响 UI 密码门;不设则开放 |
| `PICAMBER_ALLOWED_ORIGIN` | 可选。额外允许的跨域 origin(逗号分隔);默认只允许 localhost/127.0.0.1 |
| `PORT` | 服务端口,默认 `8787`;compose 固定映射宿主 8787 |
| `PI_CODING_AGENT_DIR` | pi 运行时目录(镜像内置插件 + 挂载 models.json),compose 已设为 `/app/.pi-agent` |

### 本地构建(不依赖 GHCR)

若 tag 尚未发布、或想用本地代码,给镜像打 compose 里同一个 tag 再启动:

```bash
docker build -t ghcr.io/molicherry/pichamber:latest .
docker compose up -d
```

## 文档

- [doc/ARCHITECTURE.md](doc/ARCHITECTURE.md) — 架构规范(分层边界、不偏移红线、git 提交范围)
- [doc/CAPABILITIES.md](doc/CAPABILITIES.md) — opencode 兼容端点/能力的实现状态清单(A–L 面域总览 + 端点明细 + 已知待办 + 同步 openchamber 流程)
- [doc/INDEX.md](doc/INDEX.md) — 文档目录索引
- 各任务的 PRD(`design.md`)由 Trellis 管理,在 `.trellis/tasks/archive/`

## 开发命令

```bash
bun run type-check   # 全包 tsc --noEmit
bun run test         # 全包 bun test
bun run lint         # 全包 oxlint
```

## 许可

本项目包含以下开源项目的代码,各自遵循其许可(详见 [NOTICE](NOTICE) 与各 LICENSE 文件):

- [openchamber](https://github.com/openchamber/openchamber)(MIT)— vendored UI
- [pi](https://github.com/earendil-works/pi)(见 LICENSE.pi)— 底层引擎
