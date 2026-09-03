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
		JSON.stringify(
			{
				projects: [
					{
						id: "e2e-project",
						path: workspace,
						label: "E2E Workspace",
						addedAt: 1700000000000,
						lastOpenedAt: 1700000000000,
					},
				],
			},
			null,
			2,
		),
	);
}

/** Bun skips untrusted lifecycle scripts; build node-pty explicitly for terminal cases. */
function ensureNodePty() {
	try {
		require("../../../packages/web/node_modules/node-pty");
		return;
	} catch {
		// fall through to an explicit rebuild
	}
	const { execFileSync } = require("node:child_process");
	const nodePtyPackage = require.resolve(
		"../../../packages/web/node_modules/node-pty/package.json",
	);
	const nodePtyDir = path.dirname(fs.realpathSync(nodePtyPackage));
	const npmRoot = execFileSync("npm", ["root", "-g"], {
		encoding: "utf8",
	}).trim();
	const nodeGyp = path.join(
		npmRoot,
		"npm",
		"node_modules",
		"node-gyp",
		"bin",
		"node-gyp.js",
	);
	if (!fs.existsSync(nodeGyp))
		throw new Error(`npm's bundled node-gyp not found at ${nodeGyp}`);
	execFileSync(process.execPath, [nodeGyp, "rebuild"], {
		cwd: nodePtyDir,
		stdio: "inherit",
	});
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
	"/api/permission-auto-accept",
	"/api/session-folders",
	"/api/push/",
	"/api/global/event/ws",
	"/api/project-context/",
	"/api/session-knowledge",
	"/api/sessions/",
	"/api/opencode/upgrade-status",
];

// Exact probe paths (the reply routes /api/question/:id/reply and
// /api/permission/:id/reply are implemented; only the list probes are unsupported).
const BOOTSTRAP_UNSUPPORTED_EXACT = ["", "/api/question", "/api/permission"];

// External metadata the vendored UI fetches by design (model logos/capabilities).
const EGRESS_ALLOW_PREFIXES = ["https://models.dev/"];

function isBootstrapUnsupported(urlPath) {
	const pathOnly = urlPath.split("?")[0];
	if (BOOTSTRAP_UNSUPPORTED_EXACT.includes(pathOnly)) return true;
	return BOOTSTRAP_UNSUPPORTED_PREFIXES.some((prefix) =>
		pathOnly.includes(prefix),
	);
}

// Fire-and-forget terminal control calls whose routes return 204 No Content.
// Chromium reports a completed no-body 204 fetch as requestfailed
// (net::ERR_ABORTED) once the unconsumed Response is garbage-collected — a
// browser lifecycle artifact, not a transport failure. We record the exact
// request that already delivered a 204 so the harness can distinguish that
// post-204 abort from a real failure (an abort before any 204, or any non-2xx).
function terminalControlKind(url) {
	let pathname;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return null;
	}
	const match = pathname.match(/\/api\/terminal\/[^/]+\/(appearance|resize)$/);
	return match ? match[1] : null;
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
	if (options.terminal === true) ensureNodePty();

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
		nextPromptFailure: () => registry.takeNextPromptFailure(),
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
	// Terminal control calls (appearance/resize) that already delivered a 204.
	// Keyed by the Request object identity so a genuine later failure on the same
	// endpoint (a different request) is still counted.
	const terminalControl204Requests = new Set();
	const terminalControl204s = { appearance: 0, resize: 0 };
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
		if (url.includes("/api/event") || url.includes("/global/event")) return; // SSE long-lived stream
		if (url.includes("/session/") && url.includes("/abort")) return;
		if (url.includes("/api/event")) return; // SSE long-lived stream
		if (url.includes("/session/") && url.includes("/abort")) return;
		// A terminal control request that already returned 204 is a completed
		// fire-and-forget call; its later net::ERR_ABORTED is the no-body
		// lifecycle artifact. Only skip when the 204 for THIS exact request was
		// observed — any abort before the 204 still fails the case.
		if (terminalControl204Requests.has(request)) return;
		requestFailures.push(`${request.method()} ${url}`);
	});
	page.on("response", (response) => {
		const controlKind = terminalControlKind(response.url());
		if (response.status() === 204 && controlKind) {
			terminalControl204Requests.add(response.request());
			terminalControl204s[controlKind] += 1;
		}
		if (response.status() < 400) return;
		const pathOnly = response.request().url().replace(serverOrigin, "");
		if (isBootstrapUnsupported(pathOnly)) return;
		// fs/read 403/404 is file-semantics (missing/forbidden), not endpoint missing.
		if (
			pathOnly.includes("/api/fs/read") &&
			(response.status() === 403 || response.status() === 404)
		)
			return;
		unexpectedResponses.push(
			`${response.status()} ${response.request().method()} ${pathOnly}`,
		);
	});

	// WebSocket tracking: a successful upgrade fires `websocket` (no 101 proof
	// exists otherwise); capture received frames so terminal I/O can be asserted.
	const websockets = [];
	page.on("websocket", (ws) => {
		const frames = [];
		ws.on("framereceived", (frame) => frames.push(frame.payload));
		websockets.push({ url: ws.url(), frames });
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
		websockets,
		observability: {
			pageErrors,
			consoleErrors,
			requestFailures,
			egressViolations,
			unexpectedResponses,
		},
		async waitReady() {
			await this.page.waitForFunction(
				() => document.body.innerText.trim().length > 0,
				null,
				{ timeout: 30_000 },
			);
			// Close the first-run "Add project directory" prompt when the local
			// projects cache is empty (settings sync is async).
			const dialog = this.page
				.locator('[role="dialog"]')
				.filter({ hasText: "Add project directory" });
			if (await dialog.count()) {
				await this.page.keyboard.press("Escape");
				await dialog
					.waitFor({ state: "detached", timeout: 10_000 })
					.catch(() => {});
			}
		},
		async waitForModelReady() {
			// The composer only permits sending once a provider/model is selected.
			// In password mode the App mounts after login, so wait for the model
			// label to leave its "Select model" placeholder (i18n: en-US).
			await this.page.waitForFunction(
				() => {
					const el = document.querySelector(".model-controls__model-label");
					const text = (el?.textContent ?? "").trim();
					return text.length > 0 && text !== "Select model";
				},
				null,
				{ timeout: 30_000 },
			);
		},
		async waitForTerminalControlsSettled(timeoutMs = 10_000) {
			// The fire-and-forget terminal control calls must settle with 204 before
			// teardown; this asserts the required 204 (not merely the absence of a
			// failure) and makes the case deterministic without a fixed sleep.
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (
					terminalControl204s.appearance > 0 &&
					terminalControl204s.resize > 0
				) {
					return { ...terminalControl204s };
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(
				`terminal control calls did not settle with 204: appearance=${terminalControl204s.appearance} resize=${terminalControl204s.resize}`,
			);
		},
		async assertClean(options = {}) {
			const allowResponses = options.allowResponses || [];
			const allowConsoleErrors = options.allowConsoleErrors || [];
			const o = this.observability;
			const problems = [];
			if (o.pageErrors.length)
				problems.push(`pageerror: ${o.pageErrors.join(" | ")}`);
			const unexpectedConsoleErrors = o.consoleErrors.filter(
				(e) => !allowConsoleErrors.some((a) => e.includes(a)),
			);
			if (unexpectedConsoleErrors.length)
				problems.push(`console.error: ${unexpectedConsoleErrors.join(" | ")}`);
			if (o.requestFailures.length)
				problems.push(`requestfailed: ${o.requestFailures.join(" | ")}`);
			const unexpected = o.unexpectedResponses.filter(
				(u) => !allowResponses.some((a) => u.includes(a)),
			);
			if (unexpected.length)
				problems.push(`unexpected 4xx/5xx: ${unexpected.join(" | ")}`);
			if (o.egressViolations.length)
				problems.push(`egress: ${o.egressViolations.join(" | ")}`);
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
			// Per-case fixture isolation: remove the throwaway temp tree (home /
			// workspace / agent dir) so failed runs do not litter /tmp.
			fs.rmSync(runRoot, { recursive: true, force: true });
		},
	};
}

module.exports = { createHarness, FAKE_MODELS };
