#!/usr/bin/env bun
"use strict";

/** UI-P0-19: panel rail switches with exactly one active surface. */

const { createHarness } = require("../harness.cjs");

async function pressed(h, name) {
	return h.page
		.getByRole("button", { name, exact: true })
		.getAttribute("aria-pressed");
}

async function main() {
	const h = await createHarness();
	try {
		await h.page.goto(h.state.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await h.waitReady();

		// Open Files: it becomes the single active panel.
		await h.page.getByRole("button", { name: "Files", exact: true }).click();
		await h.page.waitForFunction(
			() =>
				document
					.querySelector('[aria-label="Files"]')
					?.getAttribute("aria-pressed") === "true",
			null,
			{ timeout: 10_000 },
		);
		if ((await pressed(h, "Changes")) !== "false")
			throw new Error("Changes active while Files is open");

		// Switch to Changes (git diff surface).
		await h.page.getByRole("button", { name: "Changes", exact: true }).click();
		await h.page.waitForFunction(
			() =>
				document
					.querySelector('[aria-label="Changes"]')
					?.getAttribute("aria-pressed") === "true",
			null,
			{ timeout: 10_000 },
		);
		if ((await pressed(h, "Files")) !== "false")
			throw new Error("Files still active after switching to Changes");

		// Switch back to Files.
		await h.page.getByRole("button", { name: "Files", exact: true }).click();
		await h.page.waitForFunction(
			() =>
				document
					.querySelector('[aria-label="Files"]')
					?.getAttribute("aria-pressed") === "true",
			null,
			{ timeout: 10_000 },
		);

		await h.assertClean();
		console.log("UI-P0-19 passed");
	} finally {
		await h.teardown();
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-19 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
