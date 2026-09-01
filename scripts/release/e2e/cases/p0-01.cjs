#!/usr/bin/env bun
"use strict";

/** UI-P0-01: open-mode bootstrap — main UI renders without a password gate. */

const { createHarness } = require("../harness.cjs");

async function main() {
	const h = await createHarness();
	try {
		await h.page.goto(h.state.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await h.page.waitForFunction(
			() => document.body.innerText.trim().length > 0,
			null,
			{ timeout: 30_000 },
		);

		// No password gate in open mode.
		if (await h.page.$("#openchamber-ui-password"))
			throw new Error("password gate must not exist in open mode");

		// Main New session CTA.
		const newSession = h.page.getByText("New session", { exact: true }).first();
		await newSession.waitFor({ state: "visible", timeout: 30_000 });

		// Chat composer host + editable region.
		const composer = h.page.getByTestId("chat-input");
		await composer.waitFor({ state: "visible", timeout: 30_000 });
		const editable = composer.locator('[contenteditable="true"]');
		await editable.waitFor({ state: "visible", timeout: 10_000 });

		// Must not be stuck on a loading / startup-failed screen.
		const bodyText = await h.page.evaluate(() => document.body.innerText);
		if (/startup failed/i.test(bodyText))
			throw new Error("UI shows startup failed");

		// No page errors, console errors, unexpected 4xx/5xx, or egress violations.
		await h.assertClean();

		console.log("UI-P0-01 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-01 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
