#!/usr/bin/env bun
"use strict";

/** UI-P0-03: password mode authenticates SSE and the Terminal WebSocket. */

const { createHarness } = require("../harness.cjs");
const { REPLY_STREAM } = require("../fake-agent.cjs");

const TERMINAL_MARKER = "PICHAMBER_PASSWORD_WS_OK";

function decodeTerminalFrame(payload) {
  let buf;
  if (Buffer.isBuffer(payload)) buf = payload;
  else if (typeof payload === "string") buf = Buffer.from(payload, "utf8");
  else return null;
  if (buf.length > 0 && buf[0] === 1) buf = buf.subarray(1);
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function terminalOutputs(h) {
  const out = [];
  for (const ws of h.websockets) {
    if (!ws.url.includes("/api/terminal/ws")) continue;
    for (const frame of ws.frames) {
      const msg = decodeTerminalFrame(frame);
      if (msg && msg.t === "output" && typeof msg.d === "string")
        out.push(msg.d);
    }
  }
  return out.join("");
}

async function waitForTerminalText(h, marker, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (terminalOutputs(h).includes(marker)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  const h = await createHarness({ password: "e2e-password", terminal: true });
  try {
    await h.page.goto(h.state.url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const passwordInput = h.page.locator("#openchamber-ui-password");
    await passwordInput.waitFor({ state: "visible", timeout: 30_000 });
    await passwordInput.fill("e2e-password");
    await h.page.getByRole("button", { name: "Unlock" }).click();
    await h.page.waitForFunction(() => !document.querySelector("#openchamber-ui-password"), null, { timeout: 30_000 });

    // Readiness: the composer only accepts sends once a provider/model is
    // selected. In password mode the App mounts after login, so sending
    // immediately would be dropped client-side ("provider or model not
    // selected").
    await h.waitForModelReady();

    // SSE works in password mode (URL token minted + used).
    await h.page.getByText("New session", { exact: true }).first().click();
    const editable = h.page.getByTestId("chat-input").locator('[contenteditable="true"]');
    await editable.click();
    await h.page.keyboard.insertText("E2E:STREAM");
    await h.page.keyboard.press("Enter");
    await h.page.waitForFunction((t) => document.body.innerText.includes(t), REPLY_STREAM, { timeout: 20_000 });

    // Terminal panel: real PTY I/O over the authenticated WebSocket.
    await h.page.getByRole("button", { name: "Terminal", exact: true }).click();
    await h.page.waitForFunction(() => document.querySelector('[aria-label="Terminal"]')?.getAttribute("aria-pressed") === "true", null, { timeout: 15_000 });
    const viewport = h.page.locator('[data-terminal-owner="main"]');
    await viewport.waitFor({ state: "visible", timeout: 15_000 });
    await viewport.click();
    await h.page.keyboard.type(`printf '${TERMINAL_MARKER}'`);
    await h.page.keyboard.press("Enter");

    if (!(await waitForTerminalText(h, TERMINAL_MARKER))) {
      throw new Error("terminal did not echo the expected marker over the authenticated WebSocket");
    }
    const terminalWs = h.websockets.find((w) => w.url.includes("/api/terminal/ws"));
    if (!terminalWs) {
      throw new Error("terminal WebSocket never upgraded to /api/terminal/ws");
    }

    // The fire-and-forget appearance/resize control calls must settle with 204
    // before cleanup. The harness records each 204 and excludes only the
    // subsequent no-body post-204 abort artifact, so this is a real assertion
    // of the control contract, not a global requestfailed allowlist.
    await h.waitForTerminalControlsSettled();

    // In password mode every protected route 401s until login completes; those
    // pre-auth probes are expected and are the only 4xx/5xx this case allows.
    await h.assertClean({ allowResponses: ["401 "] });
    console.log("UI-P0-03 passed");
  } finally {
    await h.teardown();
  }
}

main().catch((error) => {
  console.error(`UI-P0-03 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
