#!/usr/bin/env bun
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SessionRegistry } = require("../../../packages/agent/src/index.ts");
const { SessionManager } = require("../../../packages/agent/node_modules/@earendil-works/pi-coding-agent");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-pi-compat-"));
  const oldHome = process.env.HOME; const oldAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.HOME = path.join(root, "home"); process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    const workspace = path.join(process.env.HOME, "workspace"); fs.mkdirSync(workspace, { recursive: true });
    const sessionDir = path.join(root, "sessions");
    const manager = SessionManager.create(workspace, sessionDir);
    manager.appendSessionInfo("Release persistence fixture");
    manager.appendCustomEntry("todo", {
      todos: [{ content: "persisted release todo", status: "completed", priority: "high" }],
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "persisted release response" }],
      api: "release-fixture",
      provider: "release-fixture",
      model: "release-fixture",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || !fs.existsSync(sessionFile)) throw new Error("pi SessionManager did not persist its JSONL file");
    const reopened = SessionManager.open(sessionFile, sessionDir);
    if (reopened.getSessionName() !== "Release persistence fixture") throw new Error("pi SessionManager did not restore session info");
    const todoEntry = reopened.getEntries().find((entry) => entry.type === "custom" && entry.customType === "todo");
    if (!todoEntry || todoEntry.data?.todos?.[0]?.content !== "persisted release todo") {
      throw new Error("pi SessionManager did not restore persisted todo custom data");
    }
    const assistantEntry = reopened.getEntries().find((entry) => entry.type === "message" && entry.message?.role === "assistant");
    if (!assistantEntry || assistantEntry.message?.usage?.output !== 2) {
      throw new Error("pi SessionManager did not restore assistant usage data");
    }

    const registry = new SessionRegistry({ cwd: workspace });
    const sessions = await registry.list();
    if (!Array.isArray(sessions) || sessions.length !== 0) throw new Error("isolated pi session store should start empty");
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), "{damaged");
    const afterDamage = await registry.list();
    if (!Array.isArray(afterDamage)) throw new Error("damaged model configuration corrupted session discovery");
    console.log("real pi SessionManager JSONL persistence, todo restoration, discovery, and damaged-config isolation passed");
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
