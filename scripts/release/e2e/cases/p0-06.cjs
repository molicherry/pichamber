#!/usr/bin/env bun
"use strict";

/** UI-P0-06: session switching isolates content across sessions. */

const { createHarness } = require("../harness.cjs");
const { REPLY_SESSION_A, REPLY_SESSION_B } = require("../fake-agent.cjs");

async function send(h, text) {
	const editable = h.page
		.getByTestId("chat-input")
		.locator('[contenteditable="true"]');
	await editable.click();
	await h.page.keyboard.insertText(text);
	await h.page.keyboard.press("Enter");
}

async function main() {
	const h = await createHarness();
	try {
		await h.page.goto(h.state.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await h.waitReady();

		// Session A.
		await h.page.getByText("New session", { exact: true }).first().click();
		await send(h, "E2E:SESSION_A");
		await h.page.waitForFunction(
			(t) => document.body.innerText.includes(t),
			REPLY_SESSION_A,
			{ timeout: 20_000 },
		);

		// Session B.
		await h.page.getByText("New session", { exact: true }).first().click();
		await send(h, "E2E:SESSION_B");
		await h.page.waitForFunction(
			(t) => document.body.innerText.includes(t),
			REPLY_SESSION_B,
			{ timeout: 20_000 },
		);

		// Switch back to A: only A content.
		const sessionA = h.registry.runtimesList()[0];
		await h.page.locator(`[data-session-row="${sessionA.id}"]`).first().click();
		await h.page.waitForFunction(
			(t) => document.body.innerText.includes(t),
			REPLY_SESSION_A,
			{ timeout: 20_000 },
		);
		// Wait for the switch render to settle, then assert no visible B content.
		await h.page.waitForTimeout(800);
		const bVisible = await h.page
			.getByText(REPLY_SESSION_B, { exact: false })
			.filter({ visible: true })
			.count();
		if (bVisible > 0) {
			throw new Error("session B content leaked into session A");
		}

		// Switch to B: only B content.
		const sessionB = h.registry.runtimesList()[1];
		await h.page.locator(`[data-session-row="${sessionB.id}"]`).first().click();
		await h.page.waitForFunction(
			(t) => document.body.innerText.includes(t),
			REPLY_SESSION_B,
			{ timeout: 20_000 },
		);

		await h.assertClean();
		console.log("UI-P0-06 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-06 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
