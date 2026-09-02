#!/usr/bin/env bun
"use strict";

/** UI-P0-15: todo is user-visible in the work-status panel. */

const { createHarness } = require("../harness.cjs");
const { TODO_TEXT } = require("../fake-agent.cjs");

async function main() {
	const h = await createHarness();
	try {
		await h.page.goto(h.state.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await h.waitReady();
		await h.page.getByText("New session", { exact: true }).first().click();

		const editable = h.page
			.getByTestId("chat-input")
			.locator('[contenteditable="true"]');
		await editable.click();
		await h.page.keyboard.insertText("E2E:TODO");
		await h.page.keyboard.press("Enter");

		await h.page
			.getByText("PICHAMBER_TODO_OK", { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 20_000 });
		await h.page
			.getByRole("button", { name: "Toggle work-status panel" })
			.click();
		await h.page
			.getByText(TODO_TEXT, { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 20_000 });

		await h.assertClean();
		console.log("UI-P0-15 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-15 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
