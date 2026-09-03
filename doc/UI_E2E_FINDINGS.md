# UI 界面功能自测：问题汇总

> 本文记录 pichamber Web UI 层级 0（发布阻断型 E2E）自测的完整结果：测试框架、通过/失败清单、**测试发现并修复的真实产品 bug**、以及最终修复的跨层时序问题。
> 测试规范见 `doc/UI_E2E_CASES.md`，测试项逐项梳理见 `doc/RELEASE_TESTS.md`。

## 一、结论速览

| 项 | 结果 |
| --- | --- |
| 层级 0 P0 用例 | **19 / 19 通过** |
| 失败用例 | 无 |
| 测试发现并修复的真实产品 bug | **6 个** |
| 已修复的跨层时序问题 | 2 个（P0-03 密码模式配置不重载、P0-17 发送失败不恢复输入） |

---

## 二、测试框架

为「测真实界面，而不是假 DOM」搭了一套确定性 E2E 框架：

- `scripts/release/e2e/harness.cjs` — 真实 server（packed UI）+ 固定浏览器参数（1440×900 / en-US / UTC / dark / reducedMotion）+ 出站网络强制（只允许 loopback server origin，外网请求判失败）+ 断言（pageerror / console.error / 非预期 4xx/5xx / egress 均为空）。
- `scripts/release/e2e/fake-agent.cjs` — 确定性假 AgentClient + 假 Registry，走真实 SessionStore → HTTP → SSE → UI reducer 链路（只脚本化模型调用，不 mock 浏览器 fetch、不直接写 DOM）。
- `scripts/release/e2e/cases/p0-*.cjs` — 19 个层级 0 用例。
- `scripts/release/e2e/run.cjs` — 批量运行 + 汇总。

**关键约束（来自规范）**：禁止 `page.evaluate(fetch)` 绕过 UI；禁止 known-red/xfail；外网请求判失败；证据只留本机。

---

## 三、测试发现并修复的真实产品 bug

这是本次自测最重要的产出——**测试不是走过场，而是真的抓住了产品缺陷**：

| # | Bug | 影响 | 根因 | 修复 |
| --- | --- | --- | --- | --- |
| 1 | **`fs/mkdir`、`fs/write` 端点缺失** | **发送消息直接失败**（UI 建草稿/会话目录时 404） | `packages/web` 只实现了 `fs/list/home/read`，缺写操作 | 补 `fs/mkdir`、`fs/write`（HOME 边界 + 敏感路径拒绝） |
| 2 | **`messageID/partID` 跨会话冲突** | **多会话切换时消息串线**（session A 显示 session B 的回复） | `SessionStore` 用实例级计数器 `msg-1`，每个会话都从 1 开始，UI 按 messageID 全局匹配导致覆盖 | ID 改为 `msg-<sessionId>-<seq>` |
| 3 | **session `PATCH/DELETE` 路由缺失** | 重命名 / 归档 / 删除全 404 | UI 用 `PATCH/DELETE /api/session/:id`，web 只实现了 GET/POST | 补 `rename`/`setArchived`/`remove`（`session_info` + `pichamber:archive` custom entry 持久化） |
| 4 | **question `reply/reject` 路由不匹配** | 问题卡片提交/驳回 404 | SDK v1 用 `/api/question/:id/reply`，web 实现的是 `/api/session/:id/question/:id/reply` | 补 SDK v1 路径（不带 session） |
| 5 | **`git/identities` 端点缺失** | UI bootstrap 时 `Failed to load git identity profiles` | web 只实现了 `git/current-identity`、`git/global-identity`，UI 探测的是 `git/identities` | 补 `/git/identities`（诚实返回空列表） |
| 6 | **归档语义未定义** | 归档/恢复无法持久化 | opencode 的 `time.archived` 正数=归档、`0`=活动（falsy sentinel），pichamber 未实现 | 归档存 `pichamber:archive` custom entry，恢复写 `0` |

> 其中 #1、#2 是 P0 级别的**产品缺陷**：一个让消息发不出去，一个让消息串线。这正是「单测绿 ≠ 界面能用」的直接证明。

---

## 四、已修复的跨层时序问题（2 个，现已转绿）

这两个失败**不是测试写错**，而是暴露了 vendored openchamber UI 的两个时序/失败恢复问题。按架构红线（`packages/ui/src` 只 rebrand 不改逻辑），修复以最小侵入方式落位——优先在 web adapter 层解决，仅对 vendored UI 的 bootstrap/恢复路径做必要的最小改动。

### P0-03 密码模式下配置不重载

- **现象**：启用 `PICAMBER_PASSWORD` 后，登录成功进入主界面，但**发送消息失败**，console 报 `Cannot send message: provider or model not selected`。
- **根因（已核实）**：在全新浏览器（无本地缓存项目）下，登录前共享 settings 同步请求 401，登录后 settings 重同步又和 `initializeApp` 竞态；`useProjectsStore.projects` 为空导致 `initializeApp` 走 `noProjectConfigDirectory` 提前返回（`isInitialized: true` 但**从未请求 `/api/config/providers` 与 `/api/agent`**），`activeDirectoryKey` 未设置，重试/恢复循环无法补救。因此 `currentProviderId/currentModelId` 恒为空，`ChatInput` 拒绝发送。
- **性质**：vendored UI 的 bootstrap 缺陷（密码模式下配置/项目从未在登录后加载），不是测试时序问题。
- **修复**（已实施，转绿）：`SessionAuthGate` 新增 `bootstrapReady` 门——登录（`authenticated`）后等待 settings/project bootstrap 重同步完成才挂载 App，避免 `initializeApp` 在 `useProjectsStore.projects` 为空时提前走 `noProjectConfigDirectory`；settings 失败也用 `finally` 兜底释放门，不会留空白屏。

### P0-17 发送失败不恢复输入

- **现象**：真实 HTTP 503 后，用户已输入的内容**丢失**，composer 变回 placeholder。
- **根因（已核实）**：原 harness 的 `failNextPrompt(503)` 并未产生 HTTP 503（只返回 204 + 异步 status error），这一**测试框架缺陷已修复**——现在通过注入的 `nextPromptFailure` 钩子在 web 层真实返回 503。但修复后 composer **仍不恢复**：`ChatInput` 的实际发送委托给 `useSessionUIStore.sendMessage`，乐观清空在失败回填前生效，草稿恢复路径没有真正把文本放回 composer（新建草稿与既有会话均复现）。
- **性质**：vendored UI 的「乐观清空 + 失败恢复」缺陷；测试框架的 503 注入缺陷已修复并验证。
- **修复**（已实施，转绿）：web 层新增 `nextPromptFailure` 注入钩子真实返回 HTTP 503；`client.ts` 检测 `prompt_not_dispatched`/`accepted:false` 并把错误标记为「确认未派发」；`ChatInput`/`session-actions` 仅对这类确定性失败回填 composer（并处理新建草稿已物化为真实会话时的恢复目标），避免歧义传输失败被静默重排导致重复调用。

---

## 五、vendored UI 单测的已知失败（另一层，非产品缺陷）

`scripts/release/e2e/scenarios/ui-isolated-tests.cjs` 将 326 个 vendored UI 测试文件**逐个隔离进程**跑，结果 321 通过 / 5 个已知失败。这 5 个是 vendored 上游或 rebrand 副作用，**不是 pichamber 产品 bug**：

| 文件 | 根因 |
| --- | --- |
| `SessionAuthGate.behavior.test.tsx` | 上游：手写 React mock 缺 `useSyncExternalStore` |
| `MarkdownRendererImpl.performance.test.tsx` | 上游：缓存计数断言脆弱 |
| `desktopRecoveryConfig.test.ts` | rebrand 副作用：断言 `OpenCode`，产品已改 `pi` |
| `shortcuts.test.ts` | 上游：旧测试断言 `mod`，上游已改 `mod+alt` |
| `document-attachments.test.ts` | rebrand 副作用：断言 `OpenChamber`，产品已改 `pichamber` |

（同步 openchamber 新版本时需重新评估这 5 项，流程见 `doc/RELEASE_TESTS.md`。）

---

## 六、明确不测（诚实声明，非缺陷）

以下能力在 `release-scenarios.json` 标为 `unsupported`，**不出现在 required 场景里，绝不报告为通过**：

| 能力 | 原因 |
| --- | --- |
| 真实模型网络调用 | 不消耗 provider 凭据、不做计费调用（UI 用确定性假 agent） |
| 多 workspace | 每进程单工作区 |
| Electron / 移动端 | 未打包 |

---

## 七、后续建议

1. **层级 1（扩展 smoke）**：`doc/UI_E2E_CASES.md` 里还有 12 个 P1 用例（Git diff/stage/commit、Terminal 完整生命周期、文件树、设置/主题、命令面板、MCP 状态、键盘/焦点等），稳定后经评审可提升为层级 0。
2. **层级 2（真实模型）**：`UI-M-01` 真实 provider 端到端，需操作者确认计费，属人工检查。

---

## 八、运行方式

```bash
# 全部 19 个层级 0 用例
bun scripts/release/e2e/run.cjs

# 单个用例
bun scripts/release/e2e/cases/p0-01.cjs

# 隔离跑全部 vendored UI 单测（321 通过 / 5 已知失败）
node scripts/release/scenarios/ui-isolated-tests.cjs
```

前置：`bunx playwright install chromium`（浏览器二进制只留本机）。
