#!/usr/bin/env bun
"use strict";

/** UI-P0-18: SSE drop triggers an automatic reconnect without losing messages. */

const { createHarness } = require("../harness.cjs");
const { REPLY_STREAM, REPLY_RECONNECTED } = require("../fake-agent.cjs");

async function main() {
  const h = await createHarness();
  try {
    await h.page.goto(h.state.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await h.waitReady();
    await h.page.getByText("New session", { exact: true }).first().click();

    const editable = h.page.getByTestId("chat-input").locator('[contenteditable="true"]');
    await editable.click();
    await h.page.keyboard.insertText("E2E:STREAM");
    await h.page.keyboard.press("Enter");
    await h.page.waitForFunction((t) => document.body.innerText.includes(t), REPLY_STREAM, { timeout: 20_000 });

    // Drop all SSE streams (harness-side fault control).
    const drop = await fetch(`${h.state.url}/api/_e2e/drop-sse`, { method: "POST" });
    if (!drop.ok) throw new Error(`drop-sse returned ${drop.status}`);

    // Send a follow-up; it only renders if the UI reconnected its SSE.
    await editable.click();
    await h.page.keyboard.insertText("E2E:AFTER_RECONNECT");
    await h.page.keyboard.press("Enter");
    await h.page.waitForFunction((t) => document.body.innerText.includes(t), REPLY_RECONNECTED, { timeout: 20_000 });

    // The original reply is still present exactly once.
    const occurrences = await h.page.evaluate((r) => document.body.innerText.split(r).length - 1, REPLY_STREAM);
    if (occurrences !== 1) throw new Error(`expected one original reply, got ${occurrences}`);

    await h.assertClean();
    console.log("UI-P0-18 passed");
  } finally {
    await h.teardown();
  }
}

main().catch((error) => {
  console.error(`UI-P0-18 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
