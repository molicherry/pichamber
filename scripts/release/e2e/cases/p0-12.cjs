#!/usr/bin/env bun
"use strict";

/** UI-P0-12: permission Deny flows back without stalling the session. */

const { createHarness } = require("../harness.cjs");
const { REPLY_PERMISSION_REJECTED } = require("../fake-agent.cjs");

async function main() {
  const h = await createHarness();
  try {
    await h.page.goto(h.state.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await h.waitReady();
    await h.page.getByText("New session", { exact: true }).first().click();

    const editable = h.page.getByTestId("chat-input").locator('[contenteditable="true"]');
    await editable.click();
    await h.page.keyboard.insertText("E2E:PERMISSION_REJECT");
    await h.page.keyboard.press("Enter");

    await h.page.getByText("Allow release browser action?", { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
    await h.page.getByRole("button", { name: "Deny" }).click();

    await h.page.getByText(REPLY_PERMISSION_REJECTED, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
    if (await h.page.evaluate((r) => document.body.innerText.includes(r), "PICHAMBER_PERMISSION_ALLOWED")) {
      throw new Error("allowed reply appeared after Deny");
    }

    await h.assertClean();
    console.log("UI-P0-12 passed");
  } finally {
    await h.teardown();
  }
}

main().catch((error) => {
  console.error(`UI-P0-12 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
