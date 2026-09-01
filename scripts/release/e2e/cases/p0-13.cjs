#!/usr/bin/env bun
"use strict";

/** UI-P0-13: QuestionCard submit flows back through the SDK route. */

const { createHarness } = require("../harness.cjs");

const REPLY = "PICHAMBER_QUESTION_release answer";

async function main() {
  const h = await createHarness();
  try {
    await h.page.goto(h.state.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await h.waitReady();
    await h.page.getByText("New session", { exact: true }).first().click();

    const editable = h.page.getByTestId("chat-input").locator('[contenteditable="true"]');
    await editable.click();
    await h.page.keyboard.insertText("E2E:QUESTION");
    await h.page.keyboard.press("Enter");

		await h.page.getByText("Input needed", { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
		await h.page.getByRole("button", { name: /Other/ }).click();
		await h.page.locator('textarea[placeholder="Your answer"]').fill("release answer");
		await h.page.getByRole("button", { name: "Submit" }).click();

    await h.page.getByText(REPLY, { exact: false }).first().waitFor({ state: "visible", timeout: 20_000 });
    await h.assertClean();
    console.log("UI-P0-13 passed");
  } finally {
    await h.teardown();
  }
}

main().catch((error) => {
  console.error(`UI-P0-13 failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
