# pichamber 能力清单

> opencode 兼容端点/能力的实现状态,用于同步更新 openchamber 时 diff。
> 状态:✅ 真实现 · ⚠️ 部分 · ❌ stub/空

## 面域总览(design.md A–L)

> 差异类型:🔧 适配层欠账(pi 有底层能力,可补) · 🚫 pi 能力边界(底层模型如此,补不了)

| 面域 | 状态 | 类型 | 关键差异 |
| --- | --- | --- | --- |
| A 会话 | ✅ | — | 多会话+持久化;重开还原 reasoning/tool/patch part |
| B 消息/part | ✅ | — | 核心+reasoning/tool/patch part 完整重建 |
| C 事件流 SSE | ✅ | — | 聊天核心+permission+question+vcs.branch+lsp.updated+mcp.tools.changed 已推 |
| D 权限/提问 | ✅ | — | 危险 bash+受保护路径+write/edit 运行时询问(卡片);其余仍是 allowlist |
| E todo | ✅ | — | 自定义 todo 工具 + 持久化 |
| F git | ✅ | — | 完整:git 面板全端点+PR 创建/列表(gh CLI)+LLM 生成 |
| G lsp | ✅ | 🚫 | pi-lens 按需诊断,非常驻 server(设计如此) |
| H terminal | ✅ | — | 真 PTY(node-pty),resize/job control/交互程序可用 |
| I project/worktree | ✅ | — | project 列表从 settings 动态读取;worktree 通过 git 端点管理 |
| J mcp | ✅ | — | MCP server 连接+工具原生注册已通(directTools:true + activeTools 并集) |
| K subtask | ✅ | — | 自定义 subtask 工具,只读子代理,深度 1 |
| L provider/model | ✅ | — | pi models.json 映射(40+ 内置 provider,多数用户未配) |

## 端点明细

### packages/web/src/opencode.ts

| 端点 | 状态 | 说明 |
| --- | --- | --- |
| GET /session | ✅ | 多会话列表 |
| GET /experimental/session | ✅ | 同上 |
| POST /session | ✅ | 创建会话 |
| GET /session/status | ✅ | |
| GET /session/:id | ✅ | |
| GET /session/:id/message | ✅ | |
| GET /session/:id/todo | ✅ | |
| POST /session/:id/prompt | ✅ | |
| POST /session/:id/prompt_async | ✅ | |
| POST /session/:id/abort | ✅ | |
| GET /event | ✅ | SSE(store 变更 + permission 提示) |
| GET /global/event | ✅ | |
| GET /global/health | ⚠️ | 返回 {ok:true}(shape 未对齐) |
| GET /opencode/health | ✅ | {healthy:true} |
| GET /global/config | ❌ | 空 {} |
| GET /config | ❌ | 空 {} |
| GET /config/providers | ✅ | pi models 映射 |
| GET/PUT /config/settings | ✅ | ~/.config/openchamber/settings.json |
| GET /config/mcp | ❌ | 空 [] |
| GET /lsp | ❌ | 空[](pi 无托管 LSP server) |
| GET /mcp | ❌ | 空 {}(MCP 状态未接 pi-mcp-adapter) |
| GET /project | ✅ | 从 settings 动态读取多项目 |
| GET /project/current | ✅ | 从 settings 动态解析当前 cwd 对应 project |
| GET /path | ✅ | |
| GET /fs/list | ✅ | HOME 边界 |
| GET /fs/home | ✅ | |
| GET /fs/read | ✅ | HOME 边界 |
| POST /permission/:id/reply | ✅ | |

### packages/web/src/index.ts

| 端点 | 状态 | 说明 |
|---|---|---|
| POST /auth/url-token | ✅ | 固定 token(无真认证) |

### packages/web/src/gitRoutes.ts

| 端点 | 状态 | 说明 |
| --- | --- | --- |
| GET /git/check | ✅ | |
| GET /git/status | ✅ | -z 解析 |
| GET /git/diff | ✅ | |
| GET /git/file-diff | ✅ | |
| GET /git/branches | ✅ | |
| GET /git/log | ✅ | |
| POST /git/stage | ✅ | |
| POST /git/unstage | ✅ | |
| POST /git/commit | ✅ | |
| GET /git/current-identity | ✅ | |
| GET /git/global-identity | ⚠️ | 空(未读 global config) |
| GET /git/remotes | ✅ | |
| — worktrees/stash/branch/merge/rebase/cherry-pick/reset/push/pull/fetch/commit-message/pr-description | ✅ | 已实现 |
| — PR 创建/列表/状态 | ✅ | gh CLI(已登录) |

### packages/web/src/terminalRoutes.ts

| 端点 | 状态 | 说明 |
| --- | --- | --- |
| GET /terminal/shells | ✅ | |
| POST /terminal/create | ✅ | node-pty 真 PTY |
| GET /terminal/sessions | ✅ | |
| POST /terminal/touch | ✅ | |
| POST /terminal/:id/resize | ✅ | pty.resize 真生效 |
| POST /terminal/:id/restart | ✅ | |
| POST /terminal/:id/appearance | ✅ | |
| DELETE /terminal/:id | ✅ | |
| POST /terminal/force-kill | ✅ | |
| /terminal/ws (WebSocket) | ✅ | opencode tagged-JSON 协议 |

## 已知待办

1. **G lsp · 常驻实时诊断面板** — 🚫 pi-lens 按需诊断,无常驻 server;/lsp 返回空。要实时面板需在 web 层自造常驻 LSP server(重,接近 opencode 核心后端)。

## 同步 openchamber 的流程

1. 覆盖 `packages/ui/src/`(新版本源码)。
2. 跑 `python3 scripts/rebrand.py`(品牌词替换,从项目根运行)。
3. 对照本清单 diff 新版本调用的新端点 → 在 `packages/web`/`packages/agent` 增量补后端。
4. 更新本清单。
