#!/usr/bin/env bun
"use strict";

/** UI-P0-17: a failed prompt keeps the user input and shows no assistant reply. */

const { createHarness } = require("../harness.cjs");

async function main() {
  const h = await createHarness();
  try {
    await h.page.goto(h.state.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await h.waitReady();

    h.registry.failNextPrompt(503, "E2E_PROMPT_FAILURE");
    await h.page.getByText("New session", { exact: true }).first().click();

    const editable = h.page.getByTestId("chat-input").locator('[contenteditable="true"]');
    await editable.click();
    await h.page.keyboard.insertText("E2E UNSENT CONTENT");
    await h.page.keyboard.press("Enter");
    await h.page.waitForTimeout(2000);

    // No assistant reply rendered.
    const hasReply = await h.page.evaluate(() => document.body.innerText.includes("PICHAMBER_"));
    if (hasReply) throw new Error("assistant reply rendered despite prompt failure");

    // Composer keeps the unsent input.
    const composerText = await h.page.evaluate(() => {
      const el = document.querySelector('[data-testid="chat-input"] [contenteditable="true"]');
      return (el?.textContent ?? "").trim();
    });
    if (!composerText.includes("E2E UNSENT CONTENT")) {
      throw new Error(`composer lost the unsent input: "${composerText}"`);
    }

    await h.assertClean();
    console.log("UI-P0-17 passed");
  } finally {
    await h.teardown();
  }
}

main().catch((error) => {
  console.error(`UI-P0-17 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
