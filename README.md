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
