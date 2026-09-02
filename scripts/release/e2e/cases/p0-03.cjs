#!/usr/bin/env bun
"use strict";

/** UI-P0-03: password mode authenticates SSE and the Terminal WebSocket. */

const { createHarness } = require("../harness.cjs");
const { REPLY_STREAM } = require("../fake-agent.cjs");

async function main() {
  const h = await createHarness({ password: "e2e-password", terminal: true });
  try {
    await h.page.goto(h.state.url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const passwordInput = h.page.locator("#openchamber-ui-password");
    await passwordInput.waitFor({ state: "visible", timeout: 30_000 });
    await passwordInput.fill("e2e-password");
    await h.page.getByRole("button", { name: "Unlock" }).click();
    await h.page.waitForFunction(() => !document.querySelector("#openchamber-ui-password"), null, { timeout: 30_000 });
    await h.page.getByText("New session", { exact: true }).first().click();

    // SSE works in password mode (URL token minted + used).
    const editable = h.page.getByTestId("chat-input").locator('[contenteditable="true"]');
    await editable.click();
    await h.page.keyboard.insertText("E2E:STREAM");
    await h.page.keyboard.press("Enter");
    await h.page.waitForFunction((t) => document.body.innerText.includes(t), REPLY_STREAM, { timeout: 20_000 });

    // Terminal panel opens (WebSocket upgrade succeeds).
    await h.page.getByRole("button", { name: "Terminal", exact: true }).click();
    await h.page.waitForFunction(() => document.querySelector('[aria-label="Terminal"]')?.getAttribute("aria-pressed") === "true", null, { timeout: 15_000 });

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
