# pichamber 架构规范

> 本文档是架构的**唯一事实来源**。任何修改必须遵守这里的边界,不得偏移。
> 每次改动后自检:我的改动是否让某一层越界了?

## 架构总览

```
packages/ui/src          openchamber 源码原样(仅 rebrand 品牌词,禁改结构/逻辑)
packages/ui/web-runtime  web 宿主实现(openchamber 预留的 hosted-surface 扩展点)
packages/web             opencode 兼容 HTTP + SSE(适配层·传输)
packages/agent           pi → opencode Session/Message/Part 模型(适配层·模型)
pi SDK                   后端引擎(createAgentSession)
```

## 各层职责与边界

| 层 | 职责 | 允许 | 禁止 |
| --- | --- | --- | --- |
| `packages/ui/src` | openchamber 源码(vendored) | **rebrand 品牌词**(OpenChamber→pichamber、OpenCode→pi) | 改组件结构/逻辑/store/sync;删功能 |
| `packages/ui/web-runtime` | web 宿主的 RuntimeAPIs 实现 | 实现/桥接 RuntimeAPIs 到 HTTP 后端 | 往 src/ 塞业务逻辑 |
| `packages/web` | opencode 兼容 HTTP+SSE 传输层 | 实现 opencode 端点形状、SSE 事件、git/terminal/github 面板后端 | import pi SDK(必须走 agent 包) |
| `packages/agent` | pi→opencode 模型映射 | **唯一允许 import pi SDK 的包** | 泄漏 pi 类型到契约(contracts 自包含) |
| pi SDK | 底层引擎 | — | — |

## 核心约束(不偏移红线)

1. **pi SDK 只出现在 `@pichamber/agent`**。web/ui 层一律通过 `@pichamber/agent` 的契约(`AgentClient`/`SessionStore`/`SessionRegistry`)间接访问。reviewer 验证过这条边界成立,不得破坏。

2. **前端 src/ 只 rebrand,不改逻辑**。openchamber 源码 1332 文件原样 vendor;唯一允许的改动是品牌词替换。同步 openchamber 新版本时:覆盖 src → 跑 `python3 scripts/rebrand.py`(从项目根)→ 对照 `doc/CAPABILITIES.md` diff 新端点补后端。

3. **适配层只做「诚实映射」,不伪造能力**。pi 有的能力 → 映射成 opencode 形状;pi 没有的 → 诚实返回空/降级(如 `/lsp` 返回空、`/mcp` 返回空),**绝不编造一个 pi 不存在的状态**(例:曾否决「把按需 LSP 诊断伪装成常驻 connected」)。

4. **前端是宿主无关的**。openchamber 通过 `window.__OPENCHAMBER_RUNTIME_APIS__` 注入 RuntimeAPIs;web 版由 `web-runtime/` 提供。这是 openchamber 架构预留的扩展点,不是适配层泄漏。

5. **适配层分两块,职责清晰**:
   - `packages/agent` = 模型映射(pi 事件流 → Session/Message/Part),不碰 HTTP
   - `packages/web` = 传输(opencode HTTP/SSE 形状 + 面板后端),不碰 pi SDK

## rebrand 规则(允许的品牌改动)

- 允许:用户可见的品牌词 `OpenChamber`→`pichamber`、`OpenCode`→`pi`(i18n value、组件字符串字面量、logo 文案)
- 禁止:改 i18n key 名(camelCase,`t()` 查找依赖)、代码标识符(如 `OpenChamberLogo`)、import 路径、注释(描述 opencode 真实行为的注释保留)
- 工具:`python3 scripts/rebrand.py`(幂等,固化上述规则)

## git 提交范围

### 提交(受版本控制)

```
packages/           # 全部源码(agent/ui/web/electron)
doc/                # 项目文档(CAPABILITIES/ARCHITECTURE/INDEX)
scripts/            # rebrand.py 等维护脚本
README.md           # 项目首页
bun.lock            # 依赖锁
package.json tsconfig.base.json .editorconfig .gitattributes .gitignore
LICENSE.openchamber LICENSE.pi NOTICE   # 许可与第三方声明
```

### 不提交(gitignored,本地/机器专属)

| 路径 | 原因 |
| --- | --- |
| `.trellis/` | Trellis 工作数据(spec/tasks/运行时/journal),机器专属 |
| `.pi/` `.agents/` `AGENTS.md` | pi agent 与 skills、agent 指令,本地环境 |
| `.pi-subagents/` | subagent 运行时数据 |
| `node_modules/` `dist/` `*.tsbuildinfo` | 依赖与构建产物 |
| `.env` `.env.*` | 密钥/机密 |

## 维护约定

- 架构偏移 → 更新本文档 + 对应的 `.trellis/spec/*` 规范。
- 补端点/能力 → 同步 `doc/CAPABILITIES.md`。
- 能力清单(✅/⚠️/❌)与「已知待办」是同步 openchamber 时的 diff 依据。
