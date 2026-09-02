#!/usr/bin/env bun
"use strict";

/** UI-P0-04: New session opens a draft; the first send creates one session. */

const { createHarness } = require("../harness.cjs");
const { REPLY_STREAM } = require("../fake-agent.cjs");

async function main() {
	const h = await createHarness();
	try {
		await h.page.goto(h.state.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await h.waitReady();

		// Clicking New session opens a draft — no persisted session yet.
		await h.page.getByText("New session", { exact: true }).first().click();
		await h.page.waitForTimeout(800);
		if (h.registry.runtimesList().length !== 0) {
			throw new Error("draft created a session before the first send");
		}

		const editable = h.page
			.getByTestId("chat-input")
			.locator('[contenteditable="true"]');
		await editable.click();
		await h.page.keyboard.insertText("E2E:STREAM");
		await h.page.keyboard.press("Enter");
		await h.page
			.getByText(REPLY_STREAM, { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 20_000 });

		if (h.registry.runtimesList().length !== 1) {
			throw new Error(
				`expected exactly one session after first send, got ${h.registry.runtimesList().length}`,
			);
		}

		await h.assertClean();
		console.log("UI-P0-04 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-04 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
