# pichamber 文档

本目录集中存放 pichamber 的项目文档(能力清单、维护约定等)。

## 文档列表

| 文件 | 用途 |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | **架构规范(唯一事实来源)**:分层边界、不偏移红线、rebrand 规则、git 提交范围 |
| [CAPABILITIES.md](./CAPABILITIES.md) | opencode 兼容端点/能力的实现状态清单(✅/⚠️/❌),用于同步更新 openchamber 时 diff。含面域总览(A–L)、端点明细、已知待办、同步流程 |

## 其他文档位置

- **design.md** — 各任务的 PRD,由 Trellis 管理,位于 `.trellis/tasks/archive/<日期>/<任务>/design.md`
- **AGENTS.md** — Trellis 生成的 agent 指令,位于项目根目录
- **.trellis/workflow.md** — Trellis 开发流程说明

## 维护约定

- 能力清单(`CAPABILITIES.md`)在每次补端点/能力后同步更新
- 同步 openchamber 的 4 步流程记录在 `CAPABILITIES.md` 末尾
- rebrand 脚本在 `scripts/rebrand.py`(从项目根运行)
