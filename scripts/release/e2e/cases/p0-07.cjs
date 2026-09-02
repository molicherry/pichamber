#!/usr/bin/env bun
"use strict";

/** UI-P0-07: rename a session through the UI and persist it. */

const { createHarness } = require("../harness.cjs");
const { REPLY_SESSION_A } = require("../fake-agent.cjs");

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
		await h.page.keyboard.insertText("E2E:SESSION_A");
		await h.page.keyboard.press("Enter");
		await h.page.waitForFunction(
			(t) => document.body.innerText.includes(t),
			REPLY_SESSION_A,
			{ timeout: 20_000 },
		);

		const session = h.registry.runtimesList()[0];
		const row = h.page.locator(`[data-session-row="${session.id}"]`).first();
		await row.click({ button: "right" });
		await h.page.getByText("Rename", { exact: true }).click();

		const input = h.page
			.locator(`[data-session-rename-form="${session.id}"] input`)
			.first();
		await input.fill("E2E Rename After");
		await h.page
			.getByRole("button", { name: "Save session name" })
			.first()
			.click();

		await h.page.waitForFunction(
			() => document.body.innerText.includes("E2E Rename After"),
			null,
			{ timeout: 20_000 },
		);

		// Persisted: reload keeps the new title.
		await h.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
		await h.waitReady();
		await h.page.waitForFunction(
			() => document.body.innerText.includes("E2E Rename After"),
			null,
			{ timeout: 20_000 },
		);

		await h.assertClean();
		console.log("UI-P0-07 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-07 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
