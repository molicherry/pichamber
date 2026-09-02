#!/usr/bin/env bun
"use strict";

/** UI-P0-16: Stop/abort stops the tail and the session is immediately reusable. */

const { createHarness } = require("../harness.cjs");
const {
	REPLY_ABORT_PARTIAL,
	REPLY_ABORT_FORBIDDEN,
	REPLY_STREAM,
} = require("../fake-agent.cjs");

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
		await h.page.keyboard.insertText("E2E:SLOW_ABORT");
		await h.page.keyboard.press("Enter");

		// The run is busy: Stop generating appears (the partial text may be coalesced
		// by the vendored UI, so assert on the busy state rather than the partial DOM).
		await h.page
			.getByRole("button", { name: "Stop generating" })
			.waitFor({ state: "visible", timeout: 20_000 });
		await h.page.getByRole("button", { name: "Stop generating" }).click();

		// Abort ends the run; the forbidden tail never renders.
		await h.page
			.getByRole("button", { name: "Stop generating" })
			.waitFor({ state: "detached", timeout: 10_000 })
			.catch(() => {});
		await h.page.waitForTimeout(1000);
		if (
			await h.page.evaluate(
				(t) => document.body.innerText.includes(t),
				REPLY_ABORT_FORBIDDEN,
			)
		) {
			throw new Error("forbidden tail rendered after abort");
		}

		// Second send succeeds.
		await editable.click();
		await h.page.keyboard.insertText("E2E:STREAM");
		await h.page.keyboard.press("Enter");
		await h.page
			.getByText(REPLY_STREAM, { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 20_000 });

		await h.assertClean();
		console.log("UI-P0-16 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-16 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
