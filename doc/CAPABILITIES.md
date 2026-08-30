# pichamber 能力清单

> opencode 兼容端点/能力的实现状态,用于同步 openchamber 时 diff。
> **每行带 `文件:行号`,可 `grep`/`read` 自行核验,不信任何人嘴上的结论。**
> 状态:✅ 真实现 · ⚠️ 部分/近似 · ❌ stub/空

> 审计口径(诚实声明):本轮对 **web 层端点(index.ts / opencode.ts / gitRoutes.ts / githubRoutes.ts / terminalRoutes.ts)** 逐端点核对过;对 **agent 层域(B 消息、D 权限、E todo、K subtask)** 只确认了文件存在 + 核心链路可跑,未逐行重审其完整性——这本身仍是一项欠账。

## 面域总览(诚实三档)

| 面域 | 状态 | 说明 + 代码位置 |
| --- | --- | --- |
| **认证(本轮新增)** | ✅ | 密码门 + session cookie + url token(`PICAMBER_PASSWORD`) | `index.ts:131-193`、`auth.ts` |
| A 会话 | ✅ | 多会话 + 持久化,CRUD 真实现 | `opencode.ts`(session 路由) |
| B 消息/part | ✅* | 核心 + reasoning/tool/patch part 重建(未逐行重审) | `packages/agent/src/pi/mapEvent.ts` |
| C 事件流 SSE | ✅ | 聊天 + permission + question + mcp.tools.changed + panel 广播 | `opencode.ts`(sseHandler) |
| D 权限/提问 | ✅* | 危险 bash + write/edit 运行时询问;question.asked(未逐行重审) | `packages/agent/src/permission.ts` |
| E todo | ✅* | 自定义 todo 工具 + 持久化(未逐行重审) | `packages/agent/src/todo.ts` |
| F git | ✅ | 完整 git 面板端点 + PR(gh CLI) | `gitRoutes.ts`、`githubRoutes.ts` |
| G lsp | ❌ | `/lsp` 返回空,无常驻 server | `opencode.ts:406` |
| H terminal | ✅ | 真 PTY(node-pty);但 shells 硬编码、touch/appearance 为 stub | `terminalRoutes.ts:337/366/394` |
| I project/worktree | ✅ | project 从 settings 动态读;worktree 走 git 端点 | `opencode.ts`(project) |
| J mcp | ⚠️ | agent 工具并集通;但 **管理面板端点空** | `opencode.ts:411/414` |
| K subtask | ✅* | 只读子代理,深度 1(未逐行重审) | `packages/agent/src/subtask.ts` |
| L provider/model | ✅ | `/config/providers` + `/config`(model + agent)均已接上 | `opencode.ts` |
| 用量统计 | ✅ | session tokens + 消息 tokens 已接上(累计 + 重启还原) | `SessionStore.ts`、`sessionRegistry.ts` |

`✅*` = 核心链路已验证,但该域的 agent 层完整性未在本轮逐行重审。

## 端点明细(带 file:line)

### packages/web/src/index.ts(认证)

| 端点 | 状态 | 位置 |
| --- | --- | --- |
| requireAuth 中间件 | ✅ | `index.ts:93`(接受 bearer / url token / session cookie) |
| GET /auth/session | ✅ | `index.ts:131`(无密码→200;有密码→按会话 200/401) |
| POST /auth/session | ✅ | `index.ts:148`(校验密码→种 cookie,per-IP 限流) |
| POST /auth/url-token | ✅ | `index.ts:183`(密码模式仅认证会话可 mint) |

### packages/web/src/opencode.ts

| 端点 | 状态 | 位置 |
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
| GET /event · /global/event | ✅ | SSE |
| GET /global/health | ⚠️ | `{ok:true}`,shape 未对齐 | `opencode.ts:347` |
| GET /opencode/health | ✅ | `{healthy:true}` |
| GET /global/config | ✅ | 真实 config(model + agent) | `opencode.ts:356` |
| GET /config | ✅ | 真实 config(model + agent) | `opencode.ts:359` |
| GET /agent | ✅ | 单个 build agent + 真实 permission(write/edit ask,bash allow) | `opencode.ts:397` |
| GET /config/providers | ✅ | pi models 映射 | `opencode.ts:381` |
| GET/PUT /config/settings | ✅ | `~/.config/openchamber/settings.json` | `opencode.ts:394/397` |
| GET /lsp | ❌ | 空 `[]`(pi 无常驻 LSP server) | `opencode.ts:406` |
| GET /mcp | ❌ | 空 `{}`(MCP 状态未接 pi-mcp-adapter) | `opencode.ts:411` |
| GET /config/mcp | ❌ | 空 `[]` | `opencode.ts:414` |
| GET /project | ✅ | 从 settings 动态读 |
| GET /project/current | ✅ | 动态解析当前 cwd |
| GET /path | ✅ | config→`.config/openchamber`(与 settings 一致),state→pi agent dir | `opencode.ts:449` |
| GET /fs/list · /fs/home · /fs/read | ✅ | HOME 边界 |
| POST /permission/:id/reply | ✅ | |
| POST /session/:id/question/:requestId/reply | ✅ | |

### packages/web/src/gitRoutes.ts

| 端点 | 状态 | 位置 |
| --- | --- | --- |
| GET /git/check · status · diff · file-diff · branches · log · remotes | ✅ | |
| POST /git/stage · unstage · commit | ✅ | |
| GET /git/current-identity | ✅ | |
| GET /git/global-identity | ⚠️ | 空(未读 global config) | `gitRoutes.ts:369` |
| worktrees / stash / branch / merge / rebase / cherry-pick / reset / push / pull / fetch / commit-message / pr-description | ✅ | 已实现,ref 已做选项注入校验(`isSafeRef`) |

### packages/web/src/githubRoutes.ts(本轮补入明细,之前清单漏列)

| 端点 | 状态 | 位置 |
| --- | --- | --- |
| GET /github/pr/status | ✅ | `githubRoutes.ts:119` |
| POST /github/pr/create | ✅ | `githubRoutes.ts:149` |
| GET /github/pulls/list | ✅ | `githubRoutes.ts:212` |
| issues / search / commits / 其它 GitHub 面板端点 | ❌ | 未实现(仅上述 3 个) |

### packages/web/src/terminalRoutes.ts

| 端点 | 状态 | 位置 |
| --- | --- | --- |
| GET /terminal/shells | ⚠️ | 硬编码 bash/zsh/fish/sh,不检测实际安装 | `terminalRoutes.ts:337` |
| POST /terminal/create | ✅ | node-pty 真 PTY |
| GET /terminal/sessions | ✅ | |
| POST /terminal/touch | ❌ | 空 204 stub | `terminalRoutes.ts:366` |
| POST /terminal/:id/restart | ✅ | |
| POST /terminal/:id/appearance | ✅ | 204 no-op(dead code — 当前 UI 未调用,外观由前端主题直接应用) | `terminalRoutes.ts:394` |
| POST /terminal/:id/resize | ✅ | pty.resize 真生效 |
| DELETE /terminal/:id | ✅ | |
| POST /terminal/force-kill | ✅ | |
| /terminal/ws (WebSocket) | ✅ | tagged-JSON 协议,鉴权与 HTTP 对齐 | `terminalRoutes.ts:80-113` |

## 已知缺口(诚实版,按优先级)

1. **✅ 认证** — v0.1.1 已实现(密码门 + session + url token)。
2. **J mcp 管理面板** — `/mcp`、`/config/mcp` 空;agent 能用 MCP 工具,但 UI 面板看不到/配不了。
3. **G lsp 面板** — `/lsp` 空;要实时诊断面板需在 web 层自造常驻 LSP server(重)。
4. **L config** — ✅ 已修(`/config`、`/global/config` 返回真实 model + agent;commands/snippets 仍空,无 pi 等价物)。
5. **用量统计** — ✅ 已修(列表 + 单会话 + 消息 tokens 均返回真实值,重启可还原)。
6. **/agent** — ✅ 已修(permission 反映 write/edit ask;单 agent 是 pi 的真实状态)。
7. **GitHub 面板** — 仅 3 端点,issues/search/commits 等未接。
8. **/path** — ✅ 已修(config→`.config/openchamber`,state→pi agent dir)。
9. **terminal shells/touch/appearance** — 仅 shells 硬编码(appearance/touch 是 no-op,无实际影响)。
10. **agent 层 B/D/E/K 完整性** — 未逐行重审。

## 同步 openchamber 的流程

1. 覆盖 `packages/ui/src/`(新版本源码)。
2. 跑 `python3 scripts/rebrand.py`(品牌词替换,从项目根运行)。
3. 对照本清单 diff 新版本调用的新端点 → 在 `packages/web`/`packages/agent` 增量补后端。
4. 更新本清单(含行号)。
