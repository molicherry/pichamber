# pichamber Web UI E2E 测试规范

> **用途**：把 pichamber Web 界面测试拆成可执行、可复现、可判定的分层用例，供后续 AI 或人工测试者直接执行，不依赖本次对话上下文。
> **结论**：只有“层级 0：发布阻断型确定性 E2E”全部通过，才能把浏览器 UI 记为发布资格通过；扩展 smoke 和真实模型检查不能替代层级 0。
> **架构边界**：测试代码必须位于 `scripts/release/`、独立测试目录或宿主运行时测试层；不得为了 pichamber 测试向 vendored `packages/ui/src` 添加专用逻辑或专用 `data-testid`。

## 1. 支持范围与明确排除

### 1.1 本规范覆盖的发布环境

| 维度 | 固定值 | 说明 |
| --- | --- | --- |
| 操作系统 | Linux x64 | 与当前 release matrix 一致 |
| Node.js | 22.x | 必须实际在 Node 22 下执行，不接受仅在更高版本推断兼容 |
| Bun | 1.4.0 | 与仓库固定版本一致 |
| 浏览器 | Playwright 驱动的 headless Chromium | 浏览器可执行文件由 `PICAMBER_RELEASE_BROWSER_EXECUTABLE` 指定 |
| UI surface | Desktop Web | 固定桌面 viewport，不覆盖移动壳 |
| workspace | 单 workspace | 每个 server process 只配置一个隔离 workspace |
| 语言 | English (`en`) | 所有基于可见文案的 locator 都以英文为准 |
| 时区 | UTC | 防止时间、日期和相对时间断言漂移 |

### 1.2 不在自动发布资格范围内

以下项目不得被报告为自动发布资格“已通过”：

- macOS、Windows、Linux arm64；
- Firefox、WebKit 或跨浏览器兼容；
- Electron；
- 手机/平板 Web shell、原生移动端；
- 多 workspace / 多 server 并发隔离；
- 真实 provider/model 网络调用；
- 需要生产凭据、生产服务或用户真实工作区的场景。

真实模型调用只允许作为“层级 2：可选人工检查”，详见 `UI-M-01`。

## 2. 测试分层

| 层级 | 名称 | 是否进入发布资格 | 失败含义 |
| --- | --- | :---: | --- |
| 层级 0 | 发布阻断型确定性 E2E（P0） | ✅ | 任一 `failed`、`blocked`、`skipped` 或 `unsupported` 都阻断浏览器发布资格 |
| 层级 1 | 扩展功能 smoke（P1） | 暂不进入 | 暴露面板或降级问题；稳定后可经评审提升为层级 0 |
| 层级 2 | 可选人工检查（P2/Manual） | ❌ | 只提供补充证据，不得改变自动资格结果 |

`RISK-*` 只是失败归因标签，不是可接受状态。当前实现已知会让部分 P0 case 变红时，正确结论就是 `Release browser qualification: FAIL`，直到产品契约被修复且这些 case 真实变绿；禁止引入 `known-red`/xfail 来绕过发布阻断。

### 2.1 执行 profile

#### `qualification-ui`

- 必须使用本次资格流程生成的精确 tarball；
- UI 文件和 server/CLI 都必须来自该 tarball 的 clean install；
- 不得用 workspace 源码 server 替代 packed server；
- 若 packed artifact 尚无可注入确定性 AgentClient 的受支持测试 seam，profile 状态必须是 `blocked`，不得降级后记为 `passed`。

#### `diagnostic-ui`

- 允许使用 packed UI + workspace source composition harness；
- 允许注入确定性 `SessionRegistry` / `AgentClient`；
- 用于定位 UI、HTTP、SSE、store 和面板问题；
- 结果必须记录 `artifactScope: "packed-ui-source-harness"`；
- 此 profile 通过不能授予发布资格。

#### `manual-real-model`

- 仅执行 `UI-M-01`；
- 需要操作者明确确认计费、模型、token 上限和日志边界；
- 不属于自动资格。

## 3. 共享夹具契约

每条测试必须独立创建夹具，不得依赖其他用例执行结果。

### 3.1 隔离目录

每条 case 创建唯一的 `CASE_ROOT`，至少包含：

```text
CASE_ROOT/
  home/                 # HOME
  pi-agent/             # PI_CODING_AGENT_DIR
  workspace/            # PICAMBER_WORKSPACE
  install/              # clean-installed tarball
  browser-profile/      # 独立 browser context/profile
  git-repo/             # Git 用例专用仓库
  artifacts/            # screenshot/trace/DOM snapshot
  logs/                 # server/browser/network logs
```

硬性要求：

- `HOME=$CASE_ROOT/home`；
- `PI_CODING_AGENT_DIR=$CASE_ROOT/pi-agent`；
- `PICAMBER_WORKSPACE=$CASE_ROOT/workspace`；
- server 仅绑定 `127.0.0.1` 和动态端口 `0`；
- 每条 case 使用新的 browser context；
- 不读取或修改用户真实 `~/.pi`、session、Git index、npm 配置或 workspace；
- Git、Terminal、server、SSE、WebSocket 和 browser 必须在 `finally` 中清理；
- runner 必须为 SIGINT/SIGTERM 注册同一 teardown；
- 每个启动进程写入 case-local PID 记录，teardown 后验证 PID 已退出且绑定端口已释放；
- 证据采集必须先于 teardown，teardown 失败另行记录，不能覆盖原始测试失败。

### 3.2 固定浏览器参数

```text
viewport: 1440 x 900
locale: en-US
timezoneId: UTC
colorScheme: dark（除主题切换用例）
reducedMotion: reduce
deviceScaleFactor: 1
```

除非用例明确要求，否则：

- 禁止复用 cookie/localStorage；
- 禁止复用 browser context；
- 禁止依赖系统主题、系统语言或宿主时区。

### 3.3 固定 provider/model/agent

确定性 UI 用例必须提供以下配置：

```text
providerID = e2e
modelID    = deterministic
agent      = build
```

配置端点必须至少返回：

- 一个 provider：`e2e`；
- 一个 model：`deterministic`；
- 默认 model 为 `e2e/deterministic`；
- 一个可发送消息的 primary agent：`build`。

只有假 AgentClient 不够：如果 UI 没有 provider/model，`ChatInput` 会拒绝发送。

### 3.4 可脚本化假 AgentClient

假 AgentClient 必须走真实 SessionStore → HTTP → SSE → UI reducer/render 链路；不得 mock 浏览器 fetch 或直接向 DOM 写文本。

以用户输入文本选择确定性行为：

| 输入文本 | 假 Agent 行为 | 预期最终文本/结果 |
| --- | --- | --- |
| `E2E:STREAM` | 依次发送 3 个 delta，每个间隔至少 200ms | `PICHAMBER_STREAM_OK` |
| `E2E:SESSION_A` | 正常单轮回复 | `PICHAMBER_SESSION_A_OK` |
| `E2E:SESSION_B` | 正常单轮回复 | `PICHAMBER_SESSION_B_OK` |
| `E2E:SLOW_ABORT` | 发送 `PICHAMBER_ABORT_PARTIAL` 后等待；收到 abort 后停止 | 不得出现 `PICHAMBER_ABORT_FORBIDDEN_TAIL` |
| `E2E:PERMISSION_ALLOW` | 触发 select permission 并等待 | 允许后回复 `PICHAMBER_PERMISSION_ALLOWED` |
| `E2E:PERMISSION_REJECT` | 触发 select permission 并等待 | 拒绝后回复 `PICHAMBER_PERMISSION_REJECTED` |
| `E2E:QUESTION` | 触发 input question 并等待 | 回答 `release answer` 后回复 `PICHAMBER_QUESTION_release answer` |
| `E2E:QUESTION_DISMISS` | 触发 input question 并等待 | dismiss 后回复 `PICHAMBER_QUESTION_DISMISSED` |
| `E2E:TODO` | 创建 todo `release browser todo`，priority=`high` | UI 可见该 todo |
| `E2E:AFTER_RECONNECT` | 正常单轮回复 | `PICHAMBER_RECONNECTED_OK` |

额外 fault controls 由测试 harness 调用，而不是从页面 `evaluate(fetch)` 调用：

- `failNextPrompt(503, "E2E_PROMPT_FAILURE")`；
- `dropAllSseConnections()`；
- `invalidateAuthSession()`；
- `waitUntilAgentBlocked(caseSessionId)`。

### 3.5 固定文件夹具

普通 workspace 至少包含：

```text
workspace/
  README.md              # 内容：PICHAMBER_FILE_PREVIEW_OK\n
  fixtures/
    nested.txt           # 内容：PICHAMBER_NESTED_FILE_OK\n
```

Git 用例使用独立仓库：

1. `git init`；
2. 配置 case-local identity；
3. `tracked.txt` 初始内容为 `line 1\n`；
4. 创建基线 commit；
5. 修改为 `line 1\nline 2\n`；
6. 创建未跟踪文件 `untracked.txt`，内容为 `untracked\n`。

## 4. 全局判定、可观测性与证据

### 4.1 默认通过条件

除用例明确列出的 allowlist 外，每条 case 必须同时满足：

- 所有步骤和精确断言成立；
- `pageerror` 数组为空；
- `console.error` 数组为空；
- `requestfailed` 数组为空；
- 没有非预期 HTTP 4xx/5xx；
- server stderr 中没有未 allowlist 的 error；
- 没有未关闭的 browser、server、SSE、WebSocket 或 PTY；
- 没有修改真实工作区或用户配置。

错误密码的 401、限流的 429、故障注入的 503 等必须逐 case allowlist；不得全局忽略所有 4xx/5xx。

### 4.2 出站网络强制

自动 profile 默认只允许访问当前 case 的 loopback server origin、`data:` 和 `blob:` URL：

- 对 HTTP(S) 使用 Playwright route 拦截；URL origin 不是当前 case 的精确 server origin 时立即 abort，并记录到 `egressViolations`；
- 对 WebSocket/SSE 记录实际 URL；URL origin 不是当前 case 的精确 server origin 时立即判失败；
- server 子进程使用脱敏后的最小环境，不继承 token/password/API-key 类环境变量；
- preflight 必须执行一次被 route 拦截的 `https://example.invalid/pichamber-e2e-probe`，证明外网 guard 生效；
- 只有 `manual-real-model` 可以额外放行操作者明确确认的单一 provider origin。

任何非 allowlist origin 请求都会使 case `failed`，即使 UI 最终文本断言通过。

### 4.3 失败时必须保存

每个失败 case 至少保存：

```text
artifacts/<case-id>/failure.png
artifacts/<case-id>/trace.zip
artifacts/<case-id>/dom.html
logs/<case-id>/browser-console.log
logs/<case-id>/network.jsonl
logs/<case-id>/server.stdout.log
logs/<case-id>/server.stderr.log
logs/<case-id>/result.json
```

日志要求：

- 先保留原始 assertion/error 作为 primary failure，再采集证据；
- screenshot、trace、DOM 或日志采集自身失败只能追加 secondary error，不能替换 primary failure；
- 所有证据采集完成后才执行 teardown；
- 对 token、password、Authorization、Cookie、API key 和已知 secret 值做脱敏；
- 不记录真实模型凭据；
- 自动用例只使用本规范中的固定无敏感对话文本；
- 证据仅保留在本地 `.release-evidence/` 或 case 临时目录，不上传。

### 4.4 状态值

只允许以下结果状态：

- `passed`；
- `failed`；
- `blocked`：必要夹具或基础设施无法建立；
- `unsupported`：仅可用于明确不在支持矩阵的层级 1/2 case；
- `skipped`：仅可用于非必需层级 1/2 case。

层级 0 中只有 `passed` 可接受。已知缺陷仍必须记为 `failed`，不得用 xfail、known-pass 或空成功替代。

## 5. Locator 与用户交互规则

### 5.1 已确认 locator

| 元素 | locator 规则 | 注意 |
| --- | --- | --- |
| Chat composer host | `page.getByTestId('chat-input')` | 这是 CodeMirror host，不是原生 input |
| Chat 可编辑区 | `getByTestId('chat-input').locator('[contenteditable="true"]')` | 先 click，再用 `keyboard.insertText()` 或 `keyboard.type()` |
| 主 New session 按钮 | `page.getByText('New session', { exact: true }).locator('..')`，并断言元素 tag 为 `BUTTON` | 主 CTA 只有可见文本，没有 aria-label |
| 次级 New session 加号 | `getByRole('button', { name: 'New session', exact: true })`，必须先限定到 Chats section | 默认可能 opacity=0，不作为主 locator |
| Header 会话标签 | `getByRole('tablist').getByRole('tab', { name: <title> })` | `role=tab` 属于 Header tab，不代表侧边栏 row |
| 侧边栏会话 row | `[data-session-row="<session-id>"]` 或限定 sidebar 后按唯一标题定位 | 不得用全局 `role=tab` 替代 |
| Dialog | `getByRole('dialog')` + 精确标题 | Archive 与 Delete 标题不同 |
| Panel rail | `getByRole('button', { name: <panel label> })` | 激活状态用 `aria-pressed=true` 断言 |
| Stop | `getByRole('button', { name: 'Stop generating' })` | 只在 streaming/busy 时出现 |
| Work status | `getByRole('button', { name: 'Toggle work-status panel' })` | 用于 todo 可见性 |

### 5.2 禁止的交互方式

除初始化 fixture 或 fault injection 外，禁止：

- 用 `page.evaluate`、`page.request`、`context.request`、浏览器内 fetch/XHR/WebSocket 直接调用产品 API；
- 用 `page.evaluate` 修改 DOM、store、localStorage、sessionStorage、cookie 或 runtime globals；
- `page.evaluate` 只允许读取无法由 locator 直接取得的只读属性，例如 `document.activeElement`、computed style 或 `Node.isConnected`，且回调中不得产生任何副作用；
- 直接调用 store action 代替用户点击；
- 直接写 DOM 或 localStorage 制造通过状态；
- 因 locator 不稳定而修改 vendored `packages/ui/src` 添加 pichamber-only test ID。

fixture 准备和 fault injection 必须在浏览器用户操作阶段之外，通过 case-local harness API 完成并写入 harness 日志。

## 6. 单个 case 的统一格式

后续 AI 执行任何 case 时，都必须输出以下字段：

- **层级/优先级**；
- **目标**；
- **专用夹具**；
- **用户操作**；
- **精确断言**；
- **网络契约与 allowlist**；
- **失败证据**；
- **清理**。

以下 case 中未单独扩展的“失败证据”和“清理”，仍必须执行第 4 节和第 3.1 节的全局要求。

# 层级 0：发布阻断型确定性 E2E

## UI-P0-01 开放模式启动与主界面 bootstrap

- **层级/优先级**：层级 0 / P0。
- **目标**：无密码模式下，packed Web UI 可直接进入桌面主界面。
- **专用夹具**：不设置 `PICAMBER_PASSWORD`/`PICAMBER_TOKEN`；提供确定性 provider/model/agent。
- **用户操作**：打开 server URL；等待主界面 ready；不进行 API 注入。
- **精确断言**：密码输入框 `#openchamber-ui-password` 不存在；主 New session 按钮可见；chat composer 可见且 `contenteditable=true`；Panel rail 可见；30 秒内不能停留在 loading 或 Startup failed。
- **网络契约与 allowlist**：`GET /auth/session` 为 200；`GET /api/opencode/health` 为 200 且 body 含 `healthy:true`；config/provider/agent bootstrap 请求均为 2xx；SSE 建连为 200；无 allowlist 4xx/5xx。
- **失败证据**：保存首屏、DOM、全部 bootstrap 请求和 server stderr。
- **清理**：关闭 SSE、browser context 和 server。

## UI-P0-02 密码错误、正确登录与 cookie 恢复

- **层级/优先级**：层级 0 / P0。
- **目标**：密码门拒绝错误密码，接受正确密码，并通过 cookie 保持会话。
- **专用夹具**：`PICAMBER_PASSWORD=e2e-password`；新 browser context。
- **用户操作**：打开页面；在 `#openchamber-ui-password` 输入 `wrong-password` 并提交；再输入 `e2e-password` 并提交；进入主界面后执行 page reload。
- **精确断言**：初始密码框自动聚焦；错误密码后仍在 locked 页面并显示 `Incorrect password`；正确密码后密码门消失、主界面出现；reload 后不再次显示密码框。
- **网络契约与 allowlist**：初始 `GET /auth/session` 允许 401；错误 `POST /auth/session` 允许 401；正确 POST 必须 200 且有 `Set-Cookie`；reload 的 `GET /auth/session` 必须 200。
- **失败证据**：保存错误态、成功态、cookie 属性摘要（不保存 cookie 值）及 auth 请求序列。
- **清理**：销毁 browser context，确保 cookie 不泄漏到其他 case。

## UI-P0-03 密码模式下 SSE 与 Terminal WebSocket 鉴权

- **层级/优先级**：层级 0 / P0。
- **目标**：证明登录成功不仅能打开页面，也能使用需要 URL token 的 SSE 和 Terminal WebSocket。
- **专用夹具**：密码模式；确定性 Agent；真实 `node-pty`；POSIX `sh`。
- **用户操作**：在本 case 内完成正确密码登录；通过 UI 创建 draft 并发送 `E2E:STREAM`；收到回复后打开 Terminal，输入 `printf 'PICHAMBER_PASSWORD_WS_OK\n'`。
- **精确断言**：聊天出现 `PICHAMBER_STREAM_OK`；Terminal 出现 `PICHAMBER_PASSWORD_WS_OK`；页面没有重新回到密码门。
- **网络契约与 allowlist**：`POST /auth/url-token` 必须 200；`/api/event` 或 `/api/global/event` SSE 必须 200；`/api/terminal/ws` 必须成功升级为 101；不得出现 401/403。
- **失败证据**：保存 auth-token 请求的脱敏元数据、SSE endpoint、WS handshake 和终端截图。
- **清理**：关闭 terminal tab，确认 PTY 已结束，再关闭 server。

## UI-P0-04 New session draft 到正式 session

- **层级/优先级**：层级 0 / P0。
- **目标**：验证真实产品语义：点击 New session 先打开 draft，首次成功发送后才创建正式 session。
- **专用夹具**：空 session store；确定性 provider/model/agent。
- **用户操作**：点击主 New session 按钮；在 composer 输入 `E2E:STREAM`；按 Enter 发送。
- **精确断言**：点击后 Header 出现选中的 transient draft tab；此时没有新增 `[data-session-row]`；composer 内容为空且可编辑；发送后只创建 1 个正式 session；Header 选中正式 tab；侧边栏出现对应 row；用户消息和最终回复均可见。
- **网络契约与 allowlist**：点击 New session 本身不得发 `POST /api/session`；首次发送时恰好一个 `POST /api/session` 返回 201，随后 prompt 请求返回 2xx；不得重复创建。
- **失败证据**：保存点击前、draft 态、发送后截图，以及 session create/prompt 请求计数。
- **清理**：删除 case state；不得让 session 进入下一个用例。

## UI-P0-05 多 delta 增量流式渲染

- **层级/优先级**：层级 0 / P0。
- **目标**：证明回复通过真实 SSE 被逐段渲染，而不是一次性显示最终文本。
- **专用夹具**：`E2E:STREAM` 必须发送 `PICHAMBER_`、`STREAM_`、`OK` 三个 delta，每段间隔至少 200ms。
- **用户操作**：从独立 draft 输入 `E2E:STREAM` 并发送。
- **精确断言**：先观察到 `PICHAMBER_` 且尚未出现完整 `PICHAMBER_STREAM_OK`；随后观察到中间文本；最终出现且只出现一次 `PICHAMBER_STREAM_OK`；streaming 时 `Stop generating` 可见，结束后消失；composer 发送后精确为空。
- **网络契约与 allowlist**：1 个 session create、1 个 prompt、持续同一 SSE 连接；无 4xx/5xx。
- **失败证据**：开启 Playwright trace；保存每个 delta 时间戳和 DOM 文本快照。
- **清理**：等待 agent_end 后再关闭，以免把正常结束误判为资源泄漏。

## UI-P0-06 多会话切换与内容隔离

- **层级/优先级**：层级 0 / P0。
- **目标**：证明会话内容不串线，Header tab 和侧边栏选择一致。
- **专用夹具**：fixture 预置两个独立 session，标题分别为 `E2E Session A`、`E2E Session B`，内容分别包含 `PICHAMBER_SESSION_A_OK`、`PICHAMBER_SESSION_B_OK`。
- **用户操作**：点击侧边栏 A；再点击 B；再点击 Header tab A。
- **精确断言**：选 A 时只显示 A 文本且 B 文本不存在；选 B 时相反；Header 中只有一个 tab `aria-selected=true`；对应侧边栏 row 为 active；切换不得新增 session 或 prompt。
- **网络契约与 allowlist**：允许各 session 的 GET/list/message 请求 2xx；不得发 prompt、update 或 delete。
- **失败证据**：保存每次选择后的 DOM 和 session/message 请求。
- **清理**：关闭所有 session tabs/context。

## UI-P0-07 会话重命名与刷新持久化

- **层级/优先级**：层级 0 / P0；后端路由已修复（原 `RISK-SESSION-ROUTES`）。
- **目标**：通过 UI 重命名，并由 server 持久化。
- **专用夹具**：预置 session 标题 `E2E Rename Before`。
- **用户操作**：打开该 session 的上下文菜单；选择 Rename；输入 `E2E Rename After`；保存；reload 页面。
- **精确断言**：保存前输入框含旧标题；保存后侧边栏和 Header 均显示新标题；旧标题不存在；reload 后仍为新标题。
- **网络契约与 allowlist**：必须有 `PATCH /api/session/:id`，body 含 `title:"E2E Rename After"`，响应 2xx 且返回同一标题；404 不得 allowlist。
- **失败证据**：保存菜单、编辑态、响应 body 和 reload 后截图。
- **清理**：删除隔离 session state。

## UI-P0-08 归档、取消、恢复与永久删除

- **层级/优先级**：层级 0 / P0；后端路由已修复（原 `RISK-SESSION-ROUTES`）。
- **目标**：验证当前真实语义：活动会话先 Archive，永久 Delete 只在 Archive 页面发生。
- **专用夹具**：预置 session `E2E Archive Target`。
- **用户操作**：第一次打开菜单选 Archive，在 `Archive session?` 对话框点击 Cancel；第二次重新 Archive 并确认；打开 Archive 页面并 Restore；再次 Archive；在 Archive 页面选 Delete，先 Cancel，再次 Delete 并确认。
- **精确断言**：Cancel 后普通列表仍存在；Archive 确认后普通列表消失、Archive 页面出现；Restore 后普通列表恢复；活动列表中不得出现 `Delete session?`；永久删除 Cancel 后仍存在；最终确认后 Archive 页面不存在该 session；reload 后也不存在。
- **网络契约与 allowlist**：Archive/Restore 必须通过 `PATCH /api/session/:id` 2xx；永久删除必须通过 `DELETE /api/session/:id` 2xx；任何 404/unsupported 都是失败。
- **失败证据**：保存每个 dialog 标题、按钮动作、PATCH/DELETE 请求与最终 reload。
- **清理**：确认最终 session 已删除；若 case 中途失败，由 fixture 删除隔离目录。

## UI-P0-09 页面 reload 后会话、消息和选择恢复

- **层级/优先级**：层级 0 / P0。
- **目标**：验证同一 server process 下的页面刷新恢复。
- **专用夹具**：本 case 自行创建 session 并发送 `E2E:STREAM`，不得依赖 UI-P0-04/05。
- **用户操作**：等待最终回复；记录 session id；page reload。
- **精确断言**：reload 后同一 session row 和 Header tab 存在；同一 session 被选中；用户消息和 `PICHAMBER_STREAM_OK` 各出现一次；不得创建新 session。
- **网络契约与 allowlist**：reload 只允许 list/get/message/config/SSE bootstrap；不得出现新的 POST session/prompt。
- **失败证据**：保存 reload 前后 session id、请求计数和 DOM。
- **清理**：关闭 context/server。

## UI-P0-10 真实 server process 重启恢复

- **层级/优先级**：层级 0 / P0。
- **目标**：验证进程重启，而不是仅 page reload。
- **专用夹具**：必须使用可持久化的真实 SessionRegistry/session store；不得使用只存在内存中的 DeterministicRegistry；server A 和 server B 复用同一 `HOME`、`PI_CODING_AGENT_DIR` 和 workspace。
- **用户操作**：在 server A 中创建 session、发送 `E2E:STREAM` 并等待结束；完整停止 server A；在新端口启动新进程 server B；浏览器导航到 B。
- **精确断言**：server A 进程确实退出；server B PID 与 A 不同；B 中恢复相同 session id、标题、用户消息和 `PICHAMBER_STREAM_OK`；不得靠 fixture 重新 seed 消息。
- **网络契约与 allowlist**：B 的 list/get/message 请求均为 2xx；不得出现新的 create/prompt；旧 SSE/WS 关闭产生的预期断连只在重启窗口 allowlist。
- **失败证据**：保存两次 PID、端口、启动日志、持久化文件列表和恢复截图。
- **清理**：停止 B；确认 A/B 均无残留进程。

## UI-P0-11 Permission Allow Once 的 UI 回流

- **层级/优先级**：层级 0 / P0。
- **目标**：permission 必须在界面显示，并由用户点击回流到 PermissionBroker。
- **专用夹具**：`E2E:PERMISSION_ALLOW` 触发标题 `Allow release browser action?` 的 select permission。
- **用户操作**：输入并发送 `E2E:PERMISSION_ALLOW`；等待 PermissionCard；点击 `Allow Once`。
- **精确断言**：卡片显示请求标题；点击前最终回复不存在；点击后卡片消失；broker 解析为允许，且网络记录该决定仅为 `once`；出现 `PICHAMBER_PERMISSION_ALLOWED`。
- **网络契约与 allowlist**：必须由 UI 发 `POST /api/permission/:id/reply`，body `reply:"once"`，响应 200/body true；禁止 `page.evaluate(fetch)`。
- **失败证据**：保存卡片、点击后的请求 body、broker 结果和最终回复。
- **清理**：确认没有 pending permission。

## UI-P0-12 Permission Reject 的 UI 回流

- **层级/优先级**：层级 0 / P0。
- **目标**：拒绝权限不会卡住 session。
- **专用夹具**：`E2E:PERMISSION_REJECT`。
- **用户操作**：发送 prompt；在 PermissionCard 点击 `Deny`。
- **精确断言**：卡片消失；broker 解析为拒绝；session 最终回到 idle；出现 `PICHAMBER_PERMISSION_REJECTED`；不得出现 allowed 文本。
- **网络契约与 allowlist**：`POST /api/permission/:id/reply` body `reply:"reject"`，响应 200/body true。
- **失败证据**：保存请求、session 状态和卡片消失后的 DOM。
- **清理**：无 pending permission。

## UI-P0-13 Question 提交答案

- **层级/优先级**：层级 0 / P0；后端路由已修复（原 `RISK-QUESTION-ROUTES`）。
- **目标**：QuestionCard 的输入和 Submit 必须通过 SDK 预期路由回流。
- **专用夹具**：`E2E:QUESTION` 触发问题 `Release browser question`。
- **用户操作**：发送 prompt；在 `Your answer` 输入 `release answer`；点击 `Submit`。
- **精确断言**：卡片显示 `Input needed` 和问题文本；提交前最终回复不存在；提交后卡片消失；出现精确文本 `PICHAMBER_QUESTION_release answer`。
- **网络契约与 allowlist**：UI 必须发送 `POST /api/question/:requestId/reply`，body `answers:[["release answer"]]`，响应 2xx；使用另一条测试专用路径绕过 SDK 不算通过。
- **失败证据**：保存 QuestionCard、实际 URL/body、server route 日志和最终回复。
- **清理**：无 pending question。

## UI-P0-14 Question Dismiss

- **层级/优先级**：层级 0 / P0；后端路由已修复（原 `RISK-QUESTION-ROUTES`）。
- **目标**：Dismiss 必须正式 reject question，而不是只隐藏 DOM。
- **专用夹具**：`E2E:QUESTION_DISMISS`。
- **用户操作**：发送 prompt；等待 QuestionCard；点击 `Dismiss`。
- **精确断言**：卡片消失；broker/question state 不再 pending；session 回到 idle；出现 `PICHAMBER_QUESTION_DISMISSED`。
- **网络契约与 allowlist**：必须发送 SDK 的 question reject 请求（预期 `POST /api/question/:requestId/reject`）并返回 2xx；404 不 allowlist。
- **失败证据**：保存实际 reject URL、response、question state 和最终 DOM。
- **清理**：无 pending question。

## UI-P0-15 Todo 的用户可见渲染

- **层级/优先级**：层级 0 / P0。
- **目标**：todo 不只在 API 返回，还必须在用户可见界面出现。
- **专用夹具**：`E2E:TODO` 创建 `release browser todo`，priority=`high`。
- **用户操作**：发送 `E2E:TODO`；点击 `Toggle work-status panel`；展开 Tasks/Todo section（若默认折叠）。
- **精确断言**：work-status panel 可见；出现且只出现一次 `release browser todo`；section summary 为 `0/1`，该未完成项没有删除线；切换到另一个无 todo session 后该文本不存在，切回后恢复。
- **网络契约与 allowlist**：todo 获取请求 2xx；不得用 `page.evaluate(fetch('/todo'))` 代替 UI 断言。
- **失败证据**：保存 panel、session 切换前后 DOM 和 todo 请求。
- **清理**：关闭 work-status panel。

## UI-P0-16 Stop/abort 后立即再次发送

- **层级/优先级**：层级 0 / P0。
- **目标**：用户停止慢回复后，尾部内容不再渲染且 session 可立即复用。
- **专用夹具**：`E2E:SLOW_ABORT`；fake 在 partial delta 后阻塞。
- **用户操作**：发送慢 prompt；等 `PICHAMBER_ABORT_PARTIAL`；点击 `Stop generating`；随后输入并发送 `E2E:STREAM`。
- **精确断言**：abort 请求后 `PICHAMBER_ABORT_FORBIDDEN_TAIL` 永不出现；Stop 按钮消失；session 回到 idle；第二次发送成功并出现 `PICHAMBER_STREAM_OK`。
- **网络契约与 allowlist**：第一次 prompt 2xx；点击 Stop 必须 `POST /api/session/:id/abort` 返回 204；第二次 prompt 2xx；不得出现 busy 409。
- **失败证据**：保存 partial、abort 请求时间、所有后续 delta 和第二轮回复。
- **清理**：确认 fake agent 未继续运行。

## UI-P0-17 Prompt 失败后输入恢复

- **层级/优先级**：层级 0 / P0。
- **目标**：发送失败时不丢失用户输入，也不能伪装为成功。
- **专用夹具**：调用 harness `failNextPrompt(503, "E2E_PROMPT_FAILURE")`。
- **用户操作**：在 composer 输入精确文本 `E2E UNSENT CONTENT`；按 Enter。
- **精确断言**：出现可见错误提示；没有 assistant 回复；composer 最终恢复为精确 `E2E UNSENT CONTENT`；不得重复文本；reload 后 draft 仍可恢复；session 不得停在 busy。
- **网络契约与 allowlist**：只 allowlist 1 个 prompt 503 和与该失败对应的 `Message send failed` console error；其他 4xx/5xx 或 requestfailed 仍失败。
- **失败证据**：保存发送前后 composer 文本、503 response、toast、reload 后 draft。
- **清理**：清除 fault control，避免影响下一 case。

## UI-P0-18 SSE 断开、自动重连与后续消息

- **层级/优先级**：层级 0 / P0。
- **目标**：SSE 断开后 UI 自动重连，不丢已有消息，也不重复事件。
- **专用夹具**：先建立正常 session；harness 提供 `dropAllSseConnections()`。
- **用户操作**：先发送 `E2E:STREAM` 并等待完成；触发 SSE 断开；等待新的 SSE GET 建立；通过 UI 发送 `E2E:AFTER_RECONNECT`。
- **精确断言**：已有 `PICHAMBER_STREAM_OK` 保留且只出现一次；断开后 10 秒内出现新的 SSE 连接；第二条回复 `PICHAMBER_RECONNECTED_OK` 出现且只出现一次；session 不被清空。
- **网络契约与 allowlist**：仅 allowlist 被主动丢弃的 EventSource requestfailed；后续 SSE 必须 200；prompt 必须 2xx；禁止无限重连，10 秒内连接尝试不得超过 5 次。
- **失败证据**：保存 SSE 连接时间线、message DOM 和 reconnect 次数。
- **清理**：关闭最终 SSE。

## UI-P0-19 Context panel 客观切换

- **层级/优先级**：层级 0 / P0。
- **目标**：Git、Terminal、Files 切换时只能有一个 active surface，不能用主观“看起来没错位”判定。
- **专用夹具**：Git repo、PTY 和文件夹具均可用。
- **用户操作**：依次点击 Files、Git、Terminal rail 按钮；最后点击 Close panel。
- **精确断言**：每次只有被点击按钮 `aria-pressed=true`；其他 rail 按钮均为 false；对应 surface 标题/根节点可见，前一 surface 不可见；Context panel 宽度大于 0；关闭后所有 rail 按钮 `aria-pressed=false`，panel 不可见，chat composer 仍可见。
- **网络契约与 allowlist**：Files、Git、Terminal 的 panel bootstrap 请求必须全部为 2xx；本 case 不允许任何 404/unsupported。
- **失败证据**：保存每次切换后的 aria 状态、bounding box 和截图。
- **清理**：关闭 panel 和 terminal。

# 层级 1：扩展功能 smoke

## UI-P1-01 密码错误限流

- **层级/优先级**：层级 1 / P1。
- **目标**：连续错误密码后显示 rate-limit 状态。
- **专用夹具**：密码模式、新 IP/独立 server。
- **用户操作**：连续提交 6 次 `wrong-password`。
- **精确断言**：前 5 次显示 Incorrect password；第 6 次进入 rate-limit error screen，页面提供 retry 操作且不进入主界面。
- **网络契约与 allowlist**：前 5 个 POST 允许 401，第 6 个允许 429 且 body 含正数 `retryAfter`。
- **失败证据**：保存全部 auth 状态码和 rate-limit 页面。
- **清理**：销毁 server，避免限流 map 污染。

## UI-P1-02 登录过期与重新认证

- **层级/优先级**：层级 1 / P1。
- **目标**：运行中凭据失效后阻止发送并可重新登录。
- **专用夹具**：已登录密码模式；harness 可 `invalidateAuthSession()`。
- **用户操作**：创建 draft 并输入 `E2E AUTH EXPIRED DRAFT`；使 session 失效；点击 Files rail 触发受保护的 `GET /api/fs/list`；尝试发送；重新输入正确密码。
- **精确断言**：Files 请求 401 后出现 Auth expired/re-login UI；失效期间不发 prompt；draft 文本精确保留；重新登录后文本仍在且可成功发送。
- **网络契约与 allowlist**：只 allowlist 触发过期的一个 401；重新登录 POST 必须 200；之后 prompt 2xx。
- **失败证据**：保存 banner/gate、输入保留和网络序列。
- **清理**：销毁 context。

## UI-P1-03 Git diff、stage、unstage 与 commit

- **层级/优先级**：层级 1 / P1。
- **目标**：验证 Git panel 对 disposable repo 的完整基础操作。
- **专用夹具**：第 3.5 节 Git repo。
- **用户操作**：打开 Git；选择 `tracked.txt`；查看 diff；stage；unstage；再次 stage；输入 commit message `test: ui e2e commit` 并 commit。
- **精确断言**：初始 changes 包含 `tracked.txt` 和 `untracked.txt`；diff 精确包含 `+line 2`；stage 后文件进入 staged；unstage 后回到 unstaged；commit 后 `tracked.txt` 不再 dirty；Git log 最新 subject 为 `test: ui e2e commit`。
- **网络契约与 allowlist**：status/diff/stage/unstage/commit 全部 2xx；不得访问远程网络。
- **失败证据**：保存每阶段 UI、Git API、最终 `git status --porcelain` 和 `git log -1`。
- **清理**：删除 disposable repo。

## UI-P1-04 非 Git 工作区的明确状态

- **层级/优先级**：层级 1 / P1。
- **目标**：非 repo 不能显示成功形状的空 Git 状态。
- **专用夹具**：普通目录，不执行 `git init`。
- **用户操作**：打开 Git panel。
- **精确断言**：显示精确文案 `This directory is not a Git repository`；不显示 staged/commit 成功状态；commit 控件不可用。
- **网络契约与 allowlist**：Git check 可返回表示非 repo 的受支持响应；不允许 500 或未知 endpoint 404。
- **失败证据**：保存 empty state 和 Git check response。
- **清理**：关闭 panel。

## UI-P1-05 Terminal create、I/O、restart、resize、close

- **层级/优先级**：层级 1 / P1。
- **目标**：验证真实 PTY 完整生命周期。
- **专用夹具**：真实 `node-pty`、`/bin/sh`。
- **用户操作**：打开 Terminal；输入 `printf 'PICHAMBER_TERMINAL_OK\n'`；调整 panel 宽度触发 resize；restart terminal；再次输入 `printf 'PICHAMBER_TERMINAL_RESTART_OK\n'`；关闭 tab。
- **精确断言**：两次文本分别可见；resize 请求 cols/rows 均为正数；restart 后 session id 更新或 server 确认新 PTY；关闭后 tab 消失且 server sessions 不含旧/新 id。
- **网络契约与 allowlist**：create/list/resize/restart/delete/WS 均成功；无 404/500。
- **失败证据**：保存 terminal output、PTY id、resize payload 和 cleanup 结果。
- **清理**：确认无残留 PTY process。

## UI-P1-06 文件树与文本预览

- **层级/优先级**：层级 1 / P1。
- **目标**：验证当前明确支持的目录浏览和文本读取。
- **专用夹具**：第 3.5 节固定文件。
- **用户操作**：打开 Files；展开 `fixtures`；点击 `nested.txt`；再打开 `README.md`。
- **精确断言**：树中路径和 fixture 一致；预览精确显示 `PICHAMBER_NESTED_FILE_OK` 和 `PICHAMBER_FILE_PREVIEW_OK`；切换文件不会串内容。
- **网络契约与 allowlist**：`GET /api/fs/list`、`GET /api/fs/read` 为 2xx；不得读取 workspace/HOME 外路径。
- **失败证据**：保存文件树、preview 和实际请求 path。
- **清理**：关闭文件 tab。

## UI-P1-07 文件搜索/写入类操作的诚实契约

- **层级/优先级**：层级 1 / P1；当前静态审计标记 `RISK-FILES-ROUTES`。
- **目标**：当前 server 只明确支持文件 list/home/read；UI 暴露的 search/create/write 类动作必须显示明确 unsupported，不能静默成空结果或成功。
- **专用夹具**：固定 workspace；记录操作前文件树和所有文件 hash。
- **用户操作**：按 `Control+P` 搜索唯一文件名 `nested.txt`；随后打开 Files tree，点击 `New File`，输入 `e2e-new.txt` 并确认。
- **精确断言**：搜索请求若命中当前未注册路由，Command Palette 必须显示精确错误文本 `unsupported endpoint`，不得显示“0 results”；创建文件必须显示包含 `unsupported endpoint` 的可见提示；`e2e-new.txt` 不得出现在 UI 或磁盘；原文件 hash 不变。
- **网络契约与 allowlist**：本 case 只 allowlist `GET /api/find/file` 与 `POST /api/fs/write` 的 explicit 404；两者 response body 都必须含 `error:"unsupported endpoint"`、method、path；任何 200 空数组/空对象、无可见错误或磁盘变化均失败。
- **失败证据**：保存控件状态、请求 URL/response、toast 和操作前后文件 hash。
- **清理**：恢复/删除 case fixture。

## UI-P1-08 设置页与主题持久化

- **层级/优先级**：层级 1 / P1。
- **目标**：设置不只渲染，还能保存一个受支持的持久设置。
- **专用夹具**：初始 dark theme；空设置文件。
- **用户操作**：按 `Control+,` 打开 Settings；确认导航包含 Appearance、Providers、Shortcuts；在 Appearance 切换到 light；关闭设置；reload。
- **精确断言**：Settings dialog 可见；切换后根元素/computed color scheme 变为 light；reload 后仍为 light；设置文件中保存对应值；无 Startup failed。
- **网络契约与 allowlist**：`GET/PUT /api/config/settings` 必须 2xx；PUT response 含保存后的值；无 404。
- **失败证据**：保存设置页、主题前后 computed style、PUT body 和 reload。
- **清理**：删除 case settings。

## UI-P1-09 Command Palette 默认快捷键

- **层级/优先级**：层级 1 / P1。
- **目标**：验证 Linux 默认绑定 `Control+P`，而不是 `Control+K`。
- **专用夹具**：默认快捷键，无自定义 override。
- **用户操作**：按 `Control+P`；输入 `Settings`；选择 Settings 候选；按 Escape 关闭。
- **精确断言**：Command Palette dialog 打开并自动聚焦搜索框；候选包含精确 Settings；选择后 Palette 关闭且 Settings dialog 打开；按 Escape 后 Settings dialog 关闭；`document.activeElement` 必须仍连接在 document 中、可见，并且不位于已关闭 dialog 内。
- **网络契约与 allowlist**：搜索本地命令不应产生非预期 4xx/5xx；若选择 Settings 触发配置读取必须 2xx。
- **失败证据**：保存键盘事件、dialog、focus activeElement 和候选列表。
- **清理**：关闭所有 overlay。

## UI-P1-10 缺失或损坏 model 配置

- **层级/优先级**：层级 1 / P1。
- **目标**：缺失/损坏配置不能导致白屏、假模型或静默发送。
- **专用夹具**：分别执行两个独立变体：无 `models.json`；无法解析的 `models.json`。
- **用户操作**：打开页面；打开 Providers/Model selector；尝试输入并发送 `E2E:NO_MODEL`。
- **精确断言**：页面仍可操作；Providers 同时显示精确文案 `No providers found` 和 `Check your pi configuration`；model selector 显示 `No models found`；不得出现伪造默认模型；尝试发送不得产生 prompt 请求，输入仍保留。
- **网络契约与 allowlist**：config/providers 可以返回明确空状态或结构化错误；不得返回伪造 provider；无未知 endpoint。
- **失败证据**：保存两种变体的页面、配置响应和 prompt 请求计数。
- **清理**：删除损坏配置。

## UI-P1-11 MCP 状态与降级

- **层级/优先级**：层级 1 / P1。
- **目标**：MCP 面板必须区分 connected、disabled、unknown/failed，不能把没有实时状态当成功。
- **专用夹具**：配置两个 server：`cached-server` 有缓存元数据；`disabled-server` 配置 `disabled:true`；不得连接外网。
- **用户操作**：打开 Settings → MCP；选择两个 server；刷新状态。
- **精确断言**：cached server 显示 Connected；disabled server 显示 disabled 描述；未实现 connect/disconnect/oauth 动作不得显示为已成功；刷新失败必须可见。
- **网络契约与 allowlist**：`GET /api/config/mcp`、`GET /api/mcp` 2xx；未实现动作若被触发必须返回明确 unsupported，并在 UI 可见，不得静默。
- **失败证据**：保存状态页、config/status response 和任何 unsupported action。
- **清理**：删除 case MCP 配置/缓存。

## UI-P1-12 键盘、焦点与 Dialog 可访问性 smoke

- **层级/优先级**：层级 1 / P2。
- **目标**：验证主要交互可用键盘完成，Dialog 有基本 focus trap/恢复。
- **专用夹具**：开放模式；默认快捷键。
- **用户操作**：用 Tab 聚焦主 New session 并按 Enter；用 Control+P 打开 Command Palette；用 Escape 关闭；打开 Archive dialog 后连续 Tab；按 Escape/Cancel 关闭。
- **精确断言**：Enter 与点击产生相同 draft；Palette 打开时焦点在搜索框；关闭任一 dialog 后 `document.activeElement` 必须仍连接在 document 中、可见且位于已关闭 dialog 外；Archive dialog 打开期间连续 Tab 不得把焦点移出 dialog；每个被遍历到的 icon button 都有非空 accessible name。
- **网络契约与 allowlist**：键盘导航本身不得产生非预期请求。
- **失败证据**：记录每步 `document.activeElement`、可访问名称和 dialog aria 属性。
- **清理**：关闭所有 dialog/overlay。

# 层级 2：可选人工真实模型检查

## UI-M-01 真实 pi SDK → 真实模型 → UI

- **层级/优先级**：层级 2 / Manual。
- **目标**：提供一次真实 provider 网络链路的补充证据，不授予发布资格。
- **专用夹具**：操作者显式提供 provider/model；不得在文档或脚本硬编码默认 provider/model；使用独立无敏感 workspace。
- **执行前确认**：操作者确认模型名、预计计费、最大输出 token（建议不超过 32）、超时（建议 60 秒）和日志脱敏。
- **用户操作**：通过 UI 新建 draft；输入 `Reply with exactly: UI-E2E-OK`；发送一次。
- **精确断言**：只发生一次模型调用；最终 assistant 可见文本去除首尾空白后精确等于 `UI-E2E-OK`；不是仅断言非空；记录是否观察到多 delta。
- **网络契约与 allowlist**：只允许操作者确认的 provider endpoint；不得访问其他模型/provider；凭据值不得写日志。
- **失败证据**：只保存脱敏请求摘要、UI 截图和最终文本；不得保存 Authorization、Cookie 或 models.json 内容。
- **清理**：关闭 session/server；删除人工 case 临时 workspace；不得修改用户模型配置。

## 7. 能力覆盖矩阵

| 支持能力域 | 浏览器 case | 其他资格场景说明 |
| --- | --- | --- |
| Web bootstrap / packed UI | UI-P0-01、02 | production build、artifact clean install 仍由独立场景验证 |
| Authentication | UI-P0-02、03；UI-P1-01、02 | HTTP auth contract 由 web tests 补充 |
| Session creation / draft | UI-P0-04 | agent/session unit contract 补充 |
| Session isolation | UI-P0-06 | 单 workspace 边界由 backend 场景补充 |
| Rename/archive/delete | UI-P0-07、08 | 当前存在 route contract 风险，不能靠 capability 文档宣称通过 |
| Message + SSE rendering | UI-P0-05、18 | SSE framing/cleanup 由 web tests 补充 |
| Reload/restart persistence | UI-P0-09、10 | packed CLI restart 由 artifact smoke 补充 |
| Permission | UI-P0-11、12 | broker contract 由 agent/web tests 补充 |
| Question | UI-P0-13、14 | 当前存在 SDK/server route 风险 |
| Todo | UI-P0-15 | todo persistence 由 agent tests 补充 |
| Abort | UI-P0-16 | HTTP abort contract 由 web tests 补充 |
| Failure/degradation | UI-P0-17、18；UI-P1-01、02、04、07、10 | corrupt state/unknown endpoint 由 backend 场景补充 |
| Git | UI-P1-03、04 | disposable Git runtime 场景仍是发布必需 |
| Terminal | UI-P0-03；UI-P1-05 | real node-pty lifecycle 场景仍是发布必需 |
| Filesystem | UI-P1-06、07 | HOME confinement/sensitive path 由 web tests 补充 |
| Config/provider | 全部 P0 的固定模型夹具；UI-P1-08、10 | damaged config/pi compatibility 由 backend 场景补充 |
| MCP | UI-P1-11 | connect/disconnect/oauth 当前不声明支持 |
| Panel/keyboard/a11y | UI-P0-19、UI-P1-09、UI-P1-12 | 不等同完整 WCAG 审计 |
| Real model network | UI-M-01 | 当前 release matrix 明确 unsupported，不进入资格 |

静态验证、lint、完整 UI isolated suite、发布证据、publish enforcement 等不属于 UI E2E case，本规范不重复这些场景。

## 8. 已知当前实现风险（测试必须保持红）

### RISK-SESSION-ROUTES（已修复）

已补齐后端路由契约：

- 实现 `PATCH /api/session/:id`（rename/archive/restore）与 `DELETE /api/session/:id`（永久删除）；
- `SessionRegistry` 新增 `rename`/`setArchived`/`remove`，`SessionStore` 新增 `setTitle`/`setArchived`；
- 归档语义：`time.archived` 正数 = 归档，`0` = 活动（falsy sentinel，与 SDK/UI 的 truthiness 判断一致）；
- archived 通过 `pichamber:archive` custom entry 持久化，title 通过 `session_info` 持久化；
- 契约测试：`packages/web/src/server.test.ts`。

影响 case：`UI-P0-07`、`UI-P0-08`。后端不再返回 404，但仍需真实 UI 操作验证（层级 0）。
### RISK-QUESTION-ROUTES（已修复）

已补齐 SDK v1 路由契约：

- 实现 `POST /api/question/:requestId/reply` 与 `POST /api/question/:requestId/reject`（不带 session）；
- 旧的 `/api/session/:id/question/:requestId/reply` 保留兼容；
- 契约测试：`packages/web/src/server.test.ts` 验证 reply/reject 正确回流到 `PermissionBroker`。

影响 case：`UI-P0-13`、`UI-P0-14`。后端路由已补齐，但仍需通过真实 QuestionCard/SDK 路径验证（不得用 `page.evaluate(fetch)` 代替）。

### RISK-FILES-ROUTES

`packages/ui/web-runtime/api/files.ts` 暴露：

- `/api/find/file`；
- `/api/fs/mkdir`；
- `/api/fs/stat`；
- `/api/fs/write`；
- `/api/fs/upload`；
- `/api/fs/delete`；
- `/api/fs/rename`；
- `/api/fs/reveal`；
- `/api/fs/raw`。

当前 `packages/web/src/opencode.ts` 明确注册的 fs route 仅包括 list/home/read。

影响 case：`UI-P1-07`。必须验证明确失败或补齐真实实现，不能把空结果算通过。

### RISK-CURRENT-BROWSER-RUNNER

当前 `scripts/release/scenarios/browser-critical.cjs`：

- 使用 workspace source Agent/Web composition；
- 多项操作通过 `page.evaluate(fetch)` 绕过用户 UI；
- fake reply 只有一个完整 delta，不能证明增量流式；
- page reload 不是 server process restart。

因此现有 browser scenario 的通过结果不能替代本规范层级 0。

## 9. 面向其他 AI 的执行协议

### 9.1 执行前 preflight

开始任何 case 前，执行 AI 必须逐项记录：

1. `process.platform === "linux"` 且 `process.arch === "x64"`；
2. `node --version` 的 major 为 22；
3. `bun --version` 精确为 1.4.0；
4. Chromium executable 存在且可启动；
5. `qualification-ui` 的 tarball 存在，记录 SHA-256，并确认 clean install 的 server/UI 均来自该 tarball；
6. 当前 git HEAD、tree、manifest hash 和 tarball hash 已写入 run metadata；
7. 临时 HOME、agent、workspace、端口和 browser context 均可创建；
8. 确定性 provider/model/agent 与全部 fake/fault controls 可用；
9. 外网 probe 被出站 guard 拦截并写入 preflight 日志；
10. 静态 route inventory 已记录；缺少 P0 需要的产品 route 属于该 P0 case 的 `failed`，不是基础设施 `blocked`。

任一环境/产物前置无法建立时，按第 9.6 节处理，不得继续后把 diagnostic 结果升级为 qualification。

### 9.2 权限边界

执行测试的 AI：

- 可以创建/删除本 case 新建的临时目录、进程和测试日志；
- 可以读取仓库代码和文档以确认 locator/route；
- 不得修改源文件、vendored UI、用户配置或真实工作区；
- 不得自动修复产品缺陷，除非用户另外明确授权；
- 不得调用真实模型，除非执行 `UI-M-01` 且操作者明确确认；
- 不得把失败 route 替换成直接 fetch workaround 后报告通过。

### 9.3 推荐执行顺序

用例彼此独立，顺序只用于尽快定位基础设施问题：

1. 夹具 preflight；
2. UI-P0-01；
3. UI-P0-02、03；
4. UI-P0-04、05；
5. UI-P0-06～10；
6. UI-P0-11～18；
7. UI-P0-19；
8. 层级 1；
9. 经操作者确认后，才可执行 UI-M-01。

P0 case 失败后仍应继续执行与其独立的其他 P0 case，以获得完整失败清单；但最终资格立即确定为失败。

### 9.4 `result.json` 最小结构

```json
{
  "schemaVersion": 1,
  "caseId": "UI-P0-05",
  "layer": 0,
  "priority": "P0",
  "profile": "qualification-ui",
  "status": "passed",
  "releaseImpact": "blocking",
  "artifactScope": "exact-packed",
  "startedAt": "ISO-8601",
  "durationMs": 0,
  "gitHead": "<sha>",
  "tarballSha256": "<sha256>",
  "browser": { "name": "chromium", "version": "...", "headless": true },
  "assertions": [],
  "expectedNetwork": [],
  "unexpectedResponses": [],
  "pageErrors": [],
  "consoleErrors": [],
  "requestFailures": [],
  "egressViolations": [],
  "artifacts": {
    "screenshot": "...",
    "trace": "...",
    "networkLog": "...",
    "serverLog": "..."
  },
  "knownRisks": [],
  "notes": []
}
```

### 9.5 总结报告

最终报告必须包含：

```text
Profile: qualification-ui | diagnostic-ui | manual-real-model
Artifact scope: exact-packed | packed-ui-source-harness | manual
P0: passed / failed / blocked / skipped / unsupported
P1: passed / failed / blocked / skipped / unsupported
Manual: passed / failed / not-run
Release browser qualification: PASS | FAIL | NOT_GRANTED
Exit code: 0 | 1
```
发布判定和退出码固定如下：

- `qualification-ui` 只有在 `artifactScope=exact-packed` 且全部 P0 为 `passed` 时输出 PASS/exit 0；其他任何组合输出 FAIL/exit 1；
- `diagnostic-ui` 可以按所选 case 成功与否返回自身 exit code，但其报告中的 Release browser qualification 必须始终为 `NOT_GRANTED`；
- `manual-real-model` 只记录 manual verdict，不得改变 qualification 的 PASS/FAIL。

并逐 case 列出：

- case ID；
- status；
- 首个失败断言；
- 非预期 network/console/page error；
- 证据路径；
- 是否命中已知风险。

### 9.6 停止与升级规则

- exact tarball、Node 22、Bun 1.4.0 或 Chromium 缺失：整个 `qualification-ui` 标为 `blocked`，不得自动改用 diagnostic 后记为通过；
- case fixture 创建失败：该 case `blocked`，保留 preflight 日志；
- 产品行为失败：`failed`，收证据后继续独立 case；
- 同一基础设施错误连续影响 3 个 case：停止后续同类 case，报告共同 blocker；
- 发现 secret 进入日志：立即停止测试，删除未脱敏副本，并报告安全阻断；
- 发现测试触及真实 Git/workspace/config：立即停止并报告隔离违规；
- 禁止把 `blocked`、`unsupported`、`skipped` 或 known risk 汇总成 P0 pass。

## 10. 最终发布浏览器检查清单

只有以下全部为真，浏览器 UI 才能记为发布资格通过：

- [ ] profile 为 `qualification-ui`；
- [ ] artifact scope 为 `exact-packed`；
- [ ] Linux x64、Node 22.x、Bun 1.4.0、headless Chromium；
- [ ] 所有 UI-P0 case 均为 `passed`；
- [ ] 没有 P0 skip/blocked/unsupported；
- [ ] 没有非预期 pageerror、console.error、requestfailed、4xx/5xx；
- [ ] `egressViolations` 为空；
- [ ] server/browser/SSE/WS/PTY 全部清理；
- [ ] 证据已脱敏且仅保留本地；
- [ ] 没有修改 vendored `packages/ui/src`；
- [ ] 没有使用真实 provider 凭据；
- [ ] 结果绑定到本次 git HEAD、manifest 和精确 tarball SHA-256。
