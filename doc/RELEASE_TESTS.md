# 本地发布资格测试项清单

> 本文是 `release-scenarios.json` 的人可读梳理。机器清单是唯一事实来源，本文逐项展开"测什么 / 怎么测 / 通过标准"。两处不一致时以 `release-scenarios.json` 为准。

## 总览

本地完整资格（`bun run release:qualify`）执行 **12 个必测项**，分两个阶段：

- **source 阶段**（10 项）：在源码工作树上跑
- **artifact 阶段**（2 项）：在打包出的 tarball 干净安装后跑

CI 只跑其中带 `ci` profile 的快速子集（5 项），**不产生发布资格证据**。完整发布必须 12 项全部 `passed`，任何必测项 `failed / skipped / unsupported` 都阻断发布。

| # | 测试项 | 阶段 | CI | 本地 full |
|---|---|:--:|:--:|
| 1 | static.type-check | source | ✅ | ✅ |
| 2 | static.lint | source | ✅ | ✅ |
| 3 | ui.stable-contract-groups | source | — | ✅ |
| 4 | agent.contracts | source | ✅ | ✅ |
| 5 | agent.pi-session-compatibility | source | — | ✅ |
| 6 | web.http-auth-sse | source | ✅ | ✅ |
| 7 | runtime.git-disposable | source | — | ✅ |
| 8 | runtime.terminal-node-pty | source | — | ✅ |
| 9 | gate.self-tests | source | ✅ | ✅ |
| 10 | static.production-build | source | — | ✅ |
| 11 | artifact.clean-install-runtime | artifact | — | ✅ |
| 12 | browser.critical-render-path | artifact | — | ✅ |

---

## 逐项说明

### 1. static.type-check

- **测什么**：全部 workspace（agent/web/ui）TypeScript 编译。
- **怎么测**：`bun run type-check`（全包 `tsc --noEmit`）。
- **通过标准**：三个包退出码均为 0。
- **前置**：Node ≥ 22、Bun 1.4.0。

### 2. static.lint

- **测什么**：全部 workspace lint 策略。
- **怎么测**：`bun run lint`（oxlint）。
- **通过标准**：退出码 0；vendored UI 的既有 warning 不阻断（不修改 `packages/ui/src`）。
- **前置**：Bun 1.4.0。

### 3. ui.stable-contract-groups

- **测什么**：4 组稳定的 UI 契约测试——sync 事件管道、runtime fetch、路由序列化、认证状态机。
- **怎么测**：`node scripts/release/scenarios/ui-stable-tests.cjs`，每个文件**独立 Bun 进程**执行。
- **为什么隔离**：vendored UI 测试含进程级 `mock.module`，全量同进程跑会互相污染（曾 312 失败）。稳定组单独进程跑保证确定性，且**不声称整个 326 文件套件绿**。
- **通过标准**：4 个文件全部退出码 0。

### 4. agent.contracts

- **测什么**：`@pichamber/agent` 的映射与聚合契约——pi 事件→`AgentEvent`（mapEvent）、`SessionStore` 消息/part/token 聚合、TodoState、PermissionBroker。
- **怎么测**：`bun test packages/agent/src`（23 个用例）。
- **通过标准**：全部通过；覆盖 text/reasoning/tool/patch/usage/生命周期/todo/permission/abort 契约。

### 5. agent.pi-session-compatibility

- **测什么**：真实 pi `SessionManager` JSONL 持久化与恢复——session_info、todo 自定义条目、assistant 消息 usage；损坏 `models.json` 不破坏会话发现。
- **怎么测**：`bun scripts/release/scenarios/pi-session.cjs`，用临时 sessionDir 写→重开→校验。
- **通过标准**：重开后 session name、todo、usage 完整恢复；损坏配置下 `list()` 仍返回数组。

### 6. web.http-auth-sse

- **测什么**：真实 HTTP 组合行为——open/password/token 三种认证模式、SSE 建连与清理、filesystem HOME 边界与敏感路径拒绝、未知 `/api/*` 显式 404。
- **怎么测**：`bun test packages/web/src`（18 个用例，loopback 端口 + 临时 HOME）。
- **通过标准**：认证矩阵、限流（5 次失败→429）、SSE `: connected`、未知端点 404 均符合契约。

### 7. runtime.git-disposable

- **测什么**：Git 面板在一次性仓库的真实操作——status/stash/branch + 负向（option-like ref 注入被拒）。
- **怎么测**：`node scripts/release/scenarios/git-disposable.cjs`，临时 `git init` 仓库。
- **通过标准**：操作生效且负向用例按预期失败；不触碰用户真实仓库。

### 8. runtime.terminal-node-pty

- **测什么**：真实 `node-pty` PTY 全生命周期——create、鉴权 WebSocket I/O、resize、restart、kill、清理。
- **怎么测**：`node --import tsx scripts/release/scenarios/terminal-lifecycle.cjs`；若 Bun 安装未跑原生构建，脚本先用 npm 自带的 node-gyp 显式编译 pty.node（凭据隔离）。
- **通过标准**：echo 往返可见、resize/restart 生效、进程清理干净。

### 9. gate.self-tests

- **测什么**：门禁自身的拒收逻辑——脏工作树、过期/不完整证据、schema/version/manifest/artifact hash 不匹配、required 失败/skip/未执行、未知 profile、支持能力无覆盖、密钥不继承且日志脱敏、无网络发布自测。
- **怎么测**：`bun test scripts/release`（21 个用例）。
- **通过标准**：全部拒收断言通过；**绝不调用 `npm publish`、绝不上传**。

### 10. static.production-build

- **测什么**：可发布分发包能否从当前源码构建。
- **怎么测**：`node scripts/build-publish.cjs`（UI vite build + web/agent bundle + dist manifest）。
- **通过标准**：构建成功，`dist/` 含受守卫的 publish manifest（`prepublishOnly`）与完整 `bin/server/ui/scripts/LICENSE/README`。

### 11. artifact.clean-install-runtime

- **测什么**：打包 tarball 的**干净安装 + 真实启动**——native 依赖脚本启用、CLI 启动、open-mode 认证、未知路由 404、重启后 health。
- **怎么测**：`node scripts/release/scenarios/artifact-smoke.cjs`（临时目录 `npm install` tarball → 启动 → 验证 → 重启）。
- **通过标准**：安装出 CLI、两次启动 health 均 `{healthy:true}`、未知路由 404。
- **注意**：安装步骤会下载 npm 依赖与 Node headers，但**不发布、不上传证据**。

### 12. browser.critical-render-path

- **测什么**：真实浏览器走通完整链路——packed UI 启动、创建确定性本地 session、HTTP prompt、经真实 SessionStore/SSE 渲染回复、todo/permission/question/abort 契约、reload 后回复仍在。
- **怎么测**：`bun scripts/release/scenarios/browser-critical.cjs`（Playwright Chromium + 确定性假 AgentClient，不耗真实 provider 凭据、不计费）。
- **通过标准**：页面渲染出确定性回复、todo 契约、permission/question 回复、abort 状态、reload 恢复、无 page error。
- **前置**：本地已 `bunx playwright install chromium`；浏览器二进制与截图只留本机。

---

## 明确不测（诚实声明）

以下能力标为 `unsupported`，**不出现在 required 场景里，绝不报告为通过**：

| 能力 | 原因 |
| --- | --- |
| multi-workspace | 每进程单工作区；多项目执行路由未支持 |
| real-model-network-smoke | 不消耗 provider 凭据、不做计费模型调用 |
| desktop-mobile | Electron / 移动端未打包 |

浏览器关键路径虽支持，但用**确定性本地 agent**验证传输/渲染链路，不是真实模型网络调用。

---

## 本地证据边界

- 全部证据/日志/截图/tarball 落在 `.release-evidence/`（gitignored），**只留本机**。
- 资格流程无任何上传、telemetry、对象存储路径；唯一网络副作用是显式非 dry-run 的 `release:publish`。
- 证据 24h 有效，绑定 commit/tree/version/manifest hash/产物 SHA-256。

## 相关文档

- 机器清单：`release-scenarios.json`
- 发布流程与支持矩阵：`doc/RELEASE_PROCESS.md`
- 端点能力清单：`doc/CAPABILITIES.md`
