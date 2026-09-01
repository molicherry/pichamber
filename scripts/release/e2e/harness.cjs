#!/usr/bin/env bun
"use strict";

/**
 * UI E2E harness — spins up a real server (packed/workspace UI) backed by a
 * deterministic fake registry, a fixed browser context, and an egress guard.
 * See doc/UI_E2E_CASES.md §3/§4 for the fixture and observability contracts.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { chromium } = require("playwright");
const { createPichamberServer } = require("../../../packages/web/src/index.ts");
const { DeterministicRegistry } = require("./fake-agent.cjs");
const { resolveBrowserExecutable } = require("../environment.cjs");

const FAKE_MODELS = {
	providers: {
		e2e: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "e2e-test-key",
			models: [
				{ id: "deterministic", name: "Deterministic E2E", input: ["text"] },
			],
		},
	},
};

function makeDirs(runRoot) {
	const dirs = {
		root: runRoot,
		home: path.join(runRoot, "home"),
		agentDir: path.join(runRoot, "pi-agent"),
		workspace: path.join(runRoot, "workspace"),
		artifacts: path.join(runRoot, "artifacts"),
		logs: path.join(runRoot, "logs"),
		browserProfile: path.join(runRoot, "browser-profile"),
	};
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
	return dirs;
}

function seedWorkspace(workspace) {
	fs.writeFileSync(
		path.join(workspace, "README.md"),
		"PICHAMBER_FILE_PREVIEW_OK\n",
	);
	fs.mkdirSync(path.join(workspace, "fixtures"), { recursive: true });
	fs.writeFileSync(
		path.join(workspace, "fixtures", "nested.txt"),
		"PICHAMBER_NESTED_FILE_OK\n",
	);
}

function seedSettings(home, workspace) {
	const configDir = path.join(home, ".config", "openchamber");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "settings.json"),
		JSON.stringify({
			projects: [
				{
					id: "e2e-project",
					path: workspace,
					label: "E2E Workspace",
					addedAt: 1700000000000,
					lastOpenedAt: 1700000000000,
				},
			],
		}, null, 2),
	);
}

// Bootstrap probe prefixes that pichamber honestly does not support. Their
// explicit 404 is a correct degradation, not a defect, so they are excluded
// from the "unexpected 4xx/5xx" check.
const BOOTSTRAP_UNSUPPORTED_PREFIXES = [
	"/api/quota/",
	"/api/openchamber/",
	"/api/update-check",
	"/api/upgrade-status",
	"/api/config/skills",
	"/api/config/themes",
	"/api/command",
	"/api/git/identities",
	"/api/github/auth/status",
	"/api/notifications/",
	"/api/permission-auto-accept",
	"/api/session-folders",
	"/api/push/",
	"/api/global/event/ws",
	"/api/project-context/",
	"/api/session-knowledge",
	"/api/sessions/",
];

// External metadata the vendored UI fetches by design (model logos/capabilities).
const EGRESS_ALLOW_PREFIXES = ["https://models.dev/"];

function isBootstrapUnsupported(urlPath) {
	return BOOTSTRAP_UNSUPPORTED_PREFIXES.some((prefix) => urlPath.includes(prefix));
}

async function createHarness(options = {}) {
	const runRoot =
		options.runRoot ||
		fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-ui-e2e-"));
	const dirs = makeDirs(runRoot);
	const uiDist =
		options.uiDist || path.resolve(__dirname, "../../../packages/ui/dist");

	// Deterministic provider/model so the UI's ChatInput permits sending.
	fs.writeFileSync(
		path.join(dirs.agentDir, "models.json"),
		JSON.stringify(FAKE_MODELS, null, 2),
	);
	seedWorkspace(dirs.workspace);
	seedSettings(dirs.home, dirs.workspace);

	const previous = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PICAMBER_PASSWORD: process.env.PICAMBER_PASSWORD,
		PICAMBER_TOKEN: process.env.PICAMBER_TOKEN,
	};
	process.env.HOME = dirs.home;
	process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
	process.env.PICAMBER_PASSWORD = options.password || "";
	process.env.PICAMBER_TOKEN = options.token || "";

	const registry = new DeterministicRegistry(dirs.workspace);
	const runtime = await createPichamberServer({
		cwd: dirs.workspace,
		uiDist,
		host: "127.0.0.1",
		port: 0,
		registry,
		terminal: options.terminal === true,
	});
	const started = await runtime.start(0, "127.0.0.1");
	const serverOrigin = `http://127.0.0.1:${started.port}`;

	const executablePath =
		options.browserExecutable ||
		resolveBrowserExecutable(process.cwd(), process.env);
	const browser = await chromium.launch({ headless: true, executablePath });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: options.colorScheme || "dark",
		reducedMotion: "reduce",
		deviceScaleFactor: 1,
	});

	// Egress guard: only the case server origin, data:, and blob: are allowed.
	const egressViolations = [];
	await context.route("**/*", (route) => {
		const url = route.request().url();
		if (url.startsWith("data:") || url.startsWith("blob:"))
			return route.continue();
		if (url.startsWith(serverOrigin)) return route.continue();
		if (EGRESS_ALLOW_PREFIXES.some((p) => url.startsWith(p)))
			return route.abort(); // allowed origin, but no network in tests
		egressViolations.push(`${route.request().method()} ${url}`);
		return route.abort();
	});

	const page = await context.newPage();
	const pageErrors = [];
	const consoleErrors = [];
	const requestFailures = [];
	const unexpectedResponses = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (msg) => {
		if (msg.type() !== "error") return;
		const text = msg.text();
		// Browser-agnostic 404 load records are covered by unexpectedResponses.
		if (text.startsWith("Failed to load resource")) return;
		// Realtime WS is not implemented; the SDK falls back to SSE. The failed
		// handshake is expected, not a defect.
		if (text.startsWith("WebSocket connection")) return;
		// Vendored UI degrade-on-unsupported logs (openchamber-only surfaces).
		if (text.startsWith("Failed to load skills")) return;
		if (text.startsWith("Failed to load commands")) return;
		if (text.startsWith("Failed to fetch model metadata")) return;
		consoleErrors.push(text);
	});
	page.on("requestfailed", (request) => {
		const url = request.url();
		// Expected: allowed external metadata (models.dev) and long-lived
		// streams aborted at teardown (prompt_async, openchamber/events).
		if (EGRESS_ALLOW_PREFIXES.some((p) => url.startsWith(p))) return;
		if (url.includes("/prompt_async")) return;
		if (url.includes("/openchamber/events")) return;
		if (url.includes("/notifications/stream")) return;
		requestFailures.push(`${request.method()} ${url}`);
	});
	page.on("response", (response) => {
		if (response.status() < 400) return;
		const pathOnly = response.request().url().replace(serverOrigin, "");
		if (isBootstrapUnsupported(pathOnly)) return;
		// fs/read 403/404 is file-semantics (missing/forbidden), not endpoint missing.
		if (pathOnly.includes("/api/fs/read") && (response.status() === 403 || response.status() === 404)) return;
		unexpectedResponses.push(`${response.status()} ${response.request().method()} ${pathOnly}`);
	});

	return {
		dirs,
		state: {
			url: started.url,
			origin: serverOrigin,
			workspace: dirs.workspace,
		},
		server: runtime,
		browser,
		context,
		page,
		registry,
		observability: {
			pageErrors,
			consoleErrors,
			requestFailures,
			egressViolations,
			unexpectedResponses,
		},
		async waitReady() {
			await this.page.waitForFunction(() => document.body.innerText.trim().length > 0, null, { timeout: 30_000 });
			// Close the first-run "Add project directory" prompt when the local
			// projects cache is empty (settings sync is async).
			const dialog = this.page.locator('[role="dialog"]').filter({ hasText: "Add project directory" });
			if (await dialog.count()) {
				await this.page.keyboard.press("Escape");
				await dialog.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
			}
		},
		async assertClean(options = {}) {
			const allowResponses = options.allowResponses || [];
			const o = this.observability;
			const problems = [];
			if (o.pageErrors.length) problems.push(`pageerror: ${o.pageErrors.join(" | ")}`);
			if (o.consoleErrors.length) problems.push(`console.error: ${o.consoleErrors.join(" | ")}`);
			if (o.requestFailures.length) problems.push(`requestfailed: ${o.requestFailures.join(" | ")}`);
			const unexpected = o.unexpectedResponses.filter((u) => !allowResponses.some((a) => u.includes(a)));
			if (unexpected.length) problems.push(`unexpected 4xx/5xx: ${unexpected.join(" | ")}`);
			if (o.egressViolations.length) problems.push(`egress: ${o.egressViolations.join(" | ")}`);
			if (problems.length) throw new Error(problems.join("; "));
		},
		async teardown() {
			await context.close().catch(() => {});
			await browser.close().catch(() => {});
			await runtime.stop().catch(() => {});
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

module.exports = { createHarness, FAKE_MODELS };
