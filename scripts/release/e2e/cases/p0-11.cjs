#!/usr/bin/env bun
"use strict";

/** UI-P0-11: permission Allow Once flows back through the UI card. */

const { createHarness } = require("../harness.cjs");
const { REPLY_PERMISSION_ALLOWED } = require("../fake-agent.cjs");

async function main() {
  const h = await createHarness();
  try {
    await h.page.goto(h.state.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await h.waitReady();
    await h.page.getByText("New session", { exact: true }).first().click();

    const editable = h.page.getByTestId("chat-input").locator('[contenteditable="true"]');
    await editable.click();
    await h.page.keyboard.insertText("E2E:PERMISSION_ALLOW");
    await h.page.keyboard.press("Enter");

    // Permission card appears with the request title.
    const card = h.page.getByText("Allow release browser action?", { exact: false }).first();
    await card.waitFor({ state: "visible", timeout: 20_000 });
		if (await h.page.evaluate((reply) => document.body.innerText.includes(reply), REPLY_PERMISSION_ALLOWED)) {
			throw new Error("permission reply appeared before the user allowed it");
		}

    await h.page.getByRole("button", { name: "Allow Once" }).click();
    await h.page.getByText(REPLY_PERMISSION_ALLOWED, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });

    await h.assertClean();
    console.log("UI-P0-11 passed");
  } finally {
    await h.teardown();
  }
}

main().catch((error) => {
  console.error(`UI-P0-11 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
