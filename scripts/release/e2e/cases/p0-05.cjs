#!/usr/bin/env bun
"use strict";

/** UI-P0-05: multi-delta streaming renders through the real SSE pipeline. */

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

		// New session draft.
		await h.page.getByText("New session", { exact: true }).first().click();

		// Type the deterministic trigger and send.
		const editable = h.page
			.getByTestId("chat-input")
			.locator('[contenteditable="true"]');
		await editable.click();
		await h.page.keyboard.insertText("E2E:STREAM");

		// Prove incremental streaming at the agent→store boundary. The vendored
		// UI coalesces deltas into fewer DOM paints, so the DOM alone cannot
		// prove incrementality; the part_delta stream can.
		const deltas = [];
		const unsubscribe = h.registry.subscribeAll((change) => {
			// First delta arrives as part_added (a new TextPart); later deltas
			// arrive as part_delta.
			if (change.type === "part_delta") deltas.push(change.delta);
			if (change.type === "part_added" && change.part.type === "text" && !change.part.text.startsWith("E2E:")) deltas.push(change.part.text);
		});
		await h.page.keyboard.press("Enter");

		// Final reply appears exactly once in the rendered UI.
		await h.page
			.getByText(REPLY_STREAM, { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 30_000 });
		unsubscribe();
		if (deltas.length < 3 || deltas.join("") !== REPLY_STREAM) {
			throw new Error(`expected incremental deltas (got ${deltas.length}: ${JSON.stringify(deltas)})`);
		}
		const occurrences = await h.page.evaluate(
			(reply) => document.body.innerText.split(reply).length - 1,
			REPLY_STREAM,
		);
		if (occurrences !== 1)
			throw new Error(`expected one reply occurrence, got ${occurrences}`);

		// Composer clears after send.
		const composerText = await h.page.evaluate(() => {
			const el = document.querySelector(
				'[data-testid="chat-input"] [contenteditable="true"]',
			);
			return (el?.textContent ?? "").trim();
		});
		if (composerText.includes("E2E:STREAM"))
			throw new Error(`composer not cleared after send: "${composerText}"`);

		await h.assertClean();
		console.log("UI-P0-05 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-05 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
