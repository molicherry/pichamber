#!/usr/bin/env bun
"use strict";

/** UI-P0-10: real server-process restart restores the session and messages. */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const {
	createPichamberServer,
} = require("../../../../packages/web/src/index.ts");
const { SessionRegistry } = require("../../../../packages/agent/src/index.ts");
const {
	createDeterministicClientFactory,
	REPLY_STREAM,
} = require("../fake-agent.cjs");
const { FAKE_MODELS } = require("../harness.cjs");
const { resolveBrowserExecutable } = require("../../environment.cjs");

async function startServer(dirs, uiDist) {
	const registry = new SessionRegistry({
		cwd: dirs.workspace,
		clientFactory: createDeterministicClientFactory(),
	});
	const runtime = await createPichamberServer({
		cwd: dirs.workspace,
		uiDist,
		host: "127.0.0.1",
		port: 0,
		registry,
		terminal: false,
	});
	const started = await runtime.start(0, "127.0.0.1");
	return { runtime, registry, url: started.url };
}

async function main() {
	const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-p010-"));
	const dirs = {
		home: path.join(runRoot, "home"),
		agentDir: path.join(runRoot, "pi-agent"),
		workspace: path.join(runRoot, "workspace"),
	};
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dirs.agentDir, "models.json"),
		JSON.stringify(FAKE_MODELS),
	);
	// Pre-seed a project so the first-run "Add project directory" dialog is skipped.
	const configDir = path.join(dirs.home, ".config", "openchamber");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "settings.json"),
		JSON.stringify({
			projects: [{ id: "e2e-project", path: dirs.workspace, label: "E2E Workspace", addedAt: 1700000000000, lastOpenedAt: 1700000000000 }],
		}, null, 2),
	);
	const uiDist = path.resolve(__dirname, "../../../../packages/ui/dist");

	const previous = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.HOME = dirs.home;
	process.env.PI_CODING_AGENT_DIR = dirs.agentDir;

	const executablePath = resolveBrowserExecutable(process.cwd(), process.env);
	let server;
	try {
		// Server A: create + send.
		server = await startServer(dirs, uiDist);
		const browser = await chromium.launch({ headless: true, executablePath });
		const page = await browser.newPage();
		await page.goto(server.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await page.waitForFunction(
			() => document.body.innerText.trim().length > 0,
			null,
			{ timeout: 30_000 },
		);
		const dialog = page
			.locator('[role="dialog"]')
			.filter({ hasText: "Add project directory" });
		if (await dialog.count()) {
			await page.keyboard.press("Escape");
		}
		await page.getByText("New session", { exact: true }).first().click();
		const editable = page
			.getByTestId("chat-input")
			.locator('[contenteditable="true"]');
		await editable.click();
		await page.keyboard.insertText("E2E:STREAM");
		await page.keyboard.press("Enter");
		await page
			.getByText(REPLY_STREAM, { exact: false })
			.first()
			.waitFor({ state: "visible", timeout: 20_000 });
		const sessionId = server.registry.runtimesList()[0].id;
		await browser.close();
		await server.runtime.stop();
		server = null;

		// Server B: restart on the same state, restore.
		server = await startServer(dirs, uiDist);
		const browser2 = await chromium.launch({ headless: true, executablePath });
		const page2 = await browser2.newPage();
		await page2.goto(server.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await page2.waitForFunction(
			() => document.body.innerText.trim().length > 0,
			null,
			{ timeout: 30_000 },
		);

		// The same session is listed and its reply restores.
		const ids = server.registry.runtimesList().map((r) => r.id);
		const opened = await server.registry.open(sessionId);
		if (!opened)
			throw new Error(`session ${sessionId} not restored after restart`);
		const restoredReply = await (async () => {
			const snap = opened.client.getSnapshot();
			return snap.messages.some((m) =>
				m.parts?.some((p) => p.text === REPLY_STREAM),
			);
		})();
		if (!restoredReply)
			throw new Error("assistant reply not restored after restart");
		// Click the restored session to render its messages, then assert the reply.
		await page2.locator(`[data-session-row="${sessionId}"]`).first().click();
		await page2.waitForFunction(
			(t) => document.body.innerText.includes(t),
			REPLY_STREAM,
			{ timeout: 20_000 },
		);
		await browser2.close();
		console.log("UI-P0-10 passed");
	} finally {
		if (server) await server.runtime.stop().catch(() => {});
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(runRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(
		`UI-P0-10 failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exit(1);
});
