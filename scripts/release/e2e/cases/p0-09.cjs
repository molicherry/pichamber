#!/usr/bin/env bun
"use strict";

/** UI-P0-09: page reload restores the session, messages, and selection. */

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
		await h.page.getByText("New session", { exact: true }).first().click();

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

		const sessionCountBefore = h.registry.runtimesList().length;

		await h.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
		await h.waitReady();

		// Same session and reply still present; no new session created.
		await h.page
			.getByText(REPLY_STREAM, { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 20_000 });
		if (h.registry.runtimesList().length !== sessionCountBefore) {
			throw new Error("session count changed after reload");
		}

		await h.assertClean();
		console.log("UI-P0-09 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-09 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
