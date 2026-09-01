#!/usr/bin/env bun
"use strict";

/** UI-P0-02: password gate rejects wrong, accepts correct, survives reload via cookie. */

const { createHarness } = require("../harness.cjs");

async function main() {
	const h = await createHarness({ password: "e2e-password" });
	try {
		await h.page.goto(h.state.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});

		const passwordInput = h.page.locator("#openchamber-ui-password");
		await passwordInput.waitFor({ state: "visible", timeout: 30_000 });

		// Autofocus.
		const focusedId = await h.page.evaluate(() => document.activeElement?.id);
		if (focusedId !== "openchamber-ui-password")
			throw new Error(
				`password input not autofocused (activeElement=${focusedId})`,
			);

		// Wrong password stays locked and shows the error.
		await passwordInput.fill("wrong-password");
		await h.page.getByRole("button", { name: "Unlock" }).click();
		await h.page
			.getByText("Incorrect password", { exact: false })
			.waitFor({ state: "visible", timeout: 10_000 });
		if (!(await h.page.$("#openchamber-ui-password")))
			throw new Error("gate disappeared after wrong password");

		// Correct password unlocks to the main UI.
		await passwordInput.fill("e2e-password");
		await h.page.getByRole("button", { name: "Unlock" }).click();
		await h.page.waitForFunction(
			() => !document.querySelector("#openchamber-ui-password"),
			null,
			{ timeout: 30_000 },
		);
		await h.page
			.getByText("New session", { exact: true })
			.first()
			.waitFor({ state: "visible", timeout: 30_000 });

		// Reload keeps the session (cookie), no gate.
		await h.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
		await h.page.waitForFunction(
			() => document.body.innerText.trim().length > 0,
			null,
			{ timeout: 30_000 },
		);
		if (await h.page.$("#openchamber-ui-password"))
			throw new Error("gate reappeared after reload");
		await h.page
			.getByText("New session", { exact: true })
			.first()
			.waitFor({ state: "visible", timeout: 30_000 });

		// In password mode every protected route 401s until login completes; those
		// pre-auth probes are all expected.
		await h.assertClean({ allowResponses: ["401 "] });
		console.log("UI-P0-02 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-02 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
