#!/usr/bin/env bun
"use strict";
const express = require("../../../packages/web/node_modules/express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { WebSocket } = require("../../../packages/web/node_modules/ws");
const { sanitizedChildEnvironment } = require("../environment.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-terminal-scenario-"));
  const nodePtyPackage = require.resolve("../../../packages/web/node_modules/node-pty/package.json");
  const nodePtyDir = fs.realpathSync(path.dirname(nodePtyPackage));
  let nativeReady = true;
  try {
    require("../../../packages/web/node_modules/node-pty");
  } catch {
    nativeReady = false;
  }
  if (!nativeReady) {
    // Bun intentionally skips untrusted lifecycle scripts in a clean checkout.
    // Invoke npm's bundled node-gyp directly so only the native addon is built;
    // `npm rebuild` also runs node-pty's package prepare step and requires its
    // unpublished development dependencies, which are absent from installations.
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    const nodeGyp = path.join(npmRoot, "npm", "node_modules", "node-gyp", "bin", "node-gyp.js");
    if (!fs.existsSync(nodeGyp)) throw new Error(`npm's bundled node-gyp was not found at ${nodeGyp}`);
    execFileSync(
      process.execPath,
      [nodeGyp, "rebuild"],
      {
        cwd: nodePtyDir,
        stdio: "inherit",
        env: sanitizedChildEnvironment(process.env, { HOME: root }),
      },
    );
  }
  const { createTerminalRoutes } = require("../../../packages/web/src/terminalRoutes.ts");
  const oldHome = process.env.HOME; const oldToken = process.env.PICAMBER_TOKEN;
  process.env.HOME = root; process.env.PICAMBER_TOKEN = "release-terminal-token";
  const app = express(); app.use(express.json());
  const server = http.createServer(app); createTerminalRoutes(app, server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("terminal server did not bind");
  const base = `http://127.0.0.1:${address.port}`; let sessionId = "";
  try {
    const created = await fetch(`${base}/api/terminal/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: root, shell: "sh", cols: 80, rows: 24 }) });
    if (created.status !== 201) throw new Error(`terminal create returned ${created.status}`);
    sessionId = (await created.json()).sessionId;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/terminal/ws?token=release-terminal-token`, { origin: base });
    const messages = [];
    ws.on("message", (raw) => { const data = Buffer.from(raw); messages.push(JSON.parse(data.subarray(data[0] === 1 ? 1 : 0).toString("utf8"))); });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const frame = (value) => Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))]);
    ws.send(frame({ t: "attach", s: sessionId }));
    const attachedDeadline = Date.now() + 5000;
    while (Date.now() < attachedDeadline && !messages.some((m) => m.t === "snapshot")) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!messages.some((m) => m.t === "snapshot")) throw new Error(`terminal websocket did not attach: ${JSON.stringify(messages)}`);
    ws.send(frame({ t: "write", s: sessionId, d: "echo release-terminal-ok\r" }));
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !messages.some((m) => String(m.d ?? m.history ?? "").includes("release-terminal-ok"))) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!messages.some((m) => String(m.d ?? m.history ?? "").includes("release-terminal-ok"))) throw new Error(`terminal websocket did not receive PTY output: ${JSON.stringify(messages)}`);
    const resized = await fetch(`${base}/api/terminal/${sessionId}/resize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: 100, rows: 30 }) });
    if (resized.status !== 204) throw new Error("terminal resize failed");
    const restarted = await fetch(`${base}/api/terminal/${sessionId}/restart`, { method: "POST" });
    if (!restarted.ok) throw new Error("terminal restart failed");
    const restartedId = (await restarted.json()).sessionId; await fetch(`${base}/api/terminal/${restartedId}`, { method: "DELETE" });
    ws.close();
    await Promise.race([
      new Promise((resolve) => ws.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    console.log("real node-pty create/ws I/O/resize/restart/kill lifecycle passed");
  } finally {
    if (sessionId) await fetch(`${base}/api/terminal/${sessionId}`, { method: "DELETE" }).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldToken === undefined) delete process.env.PICAMBER_TOKEN; else process.env.PICAMBER_TOKEN = oldToken;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
