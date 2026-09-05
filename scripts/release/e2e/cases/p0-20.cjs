#!/usr/bin/env bun
"use strict";

/** UI-P0-20: a marker-less HTTP 503 prompt failure restores the composer via the confirmation refetch. */

const { createHarness } = require("../harness.cjs");

const UNSENT = "E2E UNSENT CONTENT";

async function composerText(h) {
	return h.page.evaluate(() => {
		const el = document.querySelector(
			'[data-testid="chat-input"] [contenteditable="true"]',
		);
		return el?.textContent ?? "";
	});
}

async function main() {
	const h = await createHarness();
	try {
		await h.page.goto(h.state.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await h.waitReady();
		await h.waitForModelReady();

		// Arm a marker-less transport-level HTTP 503 for the next prompt request.
		// Unlike the p0-17 fault, the response body carries no
		// "prompt_not_dispatched" / accepted:false marker, so the client cannot
		// positively tell the prompt was rejected before dispatch. It must rely on
		// the confirmation refetch to decide whether to restore the composer.
		h.registry.failNextPrompt(503, "E2E_BARE_PROMPT_FAILURE", {
			marker: false,
		});

		await h.page.getByText("New session", { exact: true }).first().click();

		const editable = h.page
			.getByTestId("chat-input")
			.locator('[contenteditable="true"]');
		await editable.click();
		await h.page.keyboard.insertText(UNSENT);
		await h.page.keyboard.press("Enter");

		// Visible failure toast.
		await h.page
			.getByText("Failed to send message", { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 10_000 });

		// No assistant reply rendered.
		await h.page.waitForTimeout(1000);
		const hasReply = await h.page.evaluate(() =>
			document.body.innerText.includes("PICHAMBER_"),
		);
		if (hasReply)
			throw new Error("assistant reply rendered despite prompt failure");

		// Composer restores the exact unsent input.
		const restored = (await composerText(h)).trim();
		if (restored !== UNSENT) {
			throw new Error(
				`composer did not restore the unsent input: "${restored}"`,
			);
		}

		// Session is not stuck busy.
		if (await h.page.getByRole("button", { name: "Stop generating" }).count()) {
			throw new Error("session left busy after a failed prompt");
		}

		// Reload persistence: the restored draft survives a page reload.
		await h.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
		await h.waitReady();
		const reloaded = (await composerText(h)).trim();
		if (reloaded !== UNSENT) {
			throw new Error(`draft did not survive reload: "${reloaded}"`);
		}

		await h.assertClean({
			allowResponses: ["503 POST"],
			allowConsoleErrors: ["Message send failed"],
		});
		console.log("UI-P0-20 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-20 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
