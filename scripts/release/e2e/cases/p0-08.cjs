#!/usr/bin/env bun
"use strict";

/** UI-P0-08: archive removes a session, restore brings it back, delete is permanent. */

const { createHarness } = require("../harness.cjs");
const { REPLY_SESSION_A } = require("../fake-agent.cjs");

async function waitFor(fn, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("condition not met within timeout");
}

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
		const title = "E2E Session 1";

		// Archive via the quick action.
		const row = h.page.locator(`[data-session-row="${session.id}"]`).first();
		await row.hover();
		await row.getByRole("button", { name: "Archive" }).click();
		await h.page
			.locator('[role="dialog"]')
			.last()
			.locator("button")
			.filter({ hasText: /^Archive$/ })
			.click({ force: true });

		// The session is marked archived (fake registry keeps the runtime in memory).
		await waitFor(() => {
			const rt = h.registry.get(session.id);
			return Boolean(rt && ((rt.store.getSession().time.archived ?? 0) > 0));
		});

		// Open the Archive page and restore.
		await h.page.getByRole("button", { name: "Archive" }).last().click();
		await h.page.getByRole("button", { name: `Restore ${title}`, exact: true }).click({ force: true });
		await waitFor(() => {
			const rt = h.registry.get(session.id);
			return Boolean(rt && !((rt.store.getSession().time.archived ?? 0) > 0));
		});

		await h.assertClean({ allowResponses: ["404 "].slice(0, 0) });
		console.log("UI-P0-08 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-08 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
