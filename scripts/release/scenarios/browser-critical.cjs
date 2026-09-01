#!/usr/bin/env bun
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");
const {
	SessionStore,
	PermissionBroker,
	TodoState,
} = require("../../../packages/agent/src/index.ts");
const { createPichamberServer } = require("../../../packages/web/src/index.ts");

const REPLY = "PICHAMBER_RELEASE_BROWSER_OK";

class DeterministicClient {
	constructor() {
		this.listeners = new Set();
		this.aborted = false;
	}
	emit(event) {
		for (const listener of this.listeners) listener(event);
	}
	async prompt() {
		await new Promise((resolve) => setTimeout(resolve, 50));
		this.emit({ type: "agent_start" });
		this.emit({ type: "text_delta", delta: REPLY });
		this.emit({ type: "agent_end" });
	}
	async steer() {}
	async followUp() {}
	async abort() {
		this.aborted = true;
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	getSnapshot() {
		return { sessionId: "release-browser", isStreaming: false, messages: [] };
	}
	async generateText() {
		return REPLY;
	}
	async dispose() {}
}

class DeterministicRegistry {
	constructor(cwd) {
		this.cwd = cwd;
		this.permissionBroker = new PermissionBroker();
		this.runtimes = new Map();
		this.listeners = new Set();
		this.nextId = 1;
	}
	subscribeMcpToolsChanged() {
		return () => {};
	}
	subscribeAll(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	runtimesList() {
		return [...this.runtimes.values()];
	}
	get(id) {
		return this.runtimes.get(id);
	}
	async open(id) {
		return this.get(id) || null;
	}
	async create() {
		const id = `ses_release_browser_${this.nextId++}`;
		const client = new DeterministicClient();
		const todoState = new TodoState();
		todoState.add("release browser todo", "high");
		const store = new SessionStore(client, {
			id,
			title: "Release browser session",
			directory: this.cwd,
			todoState,
		});
		store.subscribe((change) => {
			for (const listener of this.listeners) listener(change, id);
		});
		store.start();
		const runtime = {
			id,
			title: "Release browser session",
			directory: this.cwd,
			client,
			store,
		};
		this.runtimes.set(id, runtime);
		return runtime;
	}
	async list() {
		return [...this.runtimes.values()].map((runtime) => ({
			id: runtime.id,
			title: runtime.store.getSession().title,
			directory: this.cwd,
			createdAt: runtime.store.getSession().time.created,
			updatedAt: runtime.store.getSession().time.updated,
			messageCount: runtime.store.getMessages().length,
			tokens: {
				input: 0,
				output: 0,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			},
		}));
	}
	async generateText() {
		return REPLY;
	}
}

async function main() {
	const tarball = process.env.PICAMBER_QUALIFIED_TARBALL;
	const runRoot = process.env.PICAMBER_SCENARIO_ROOT;
	const executablePath = process.env.PICAMBER_RELEASE_BROWSER_EXECUTABLE;
	if (!tarball || !runRoot || !executablePath) {
		throw new Error(
			"browser scenario requires the qualified tarball, scenario root, and browser executable",
		);
	}
	if (!fs.existsSync(executablePath))
		throw new Error(`browser executable does not exist: ${executablePath}`);

	const extractRoot = path.join(runRoot, "browser-package");
	const workspace = path.join(runRoot, "browser-workspace");
	const home = path.join(runRoot, "browser-home");
	const agent = path.join(runRoot, "browser-agent");
	const evidenceRoot = process.env.PICAMBER_RELEASE_EVIDENCE_ROOT;
	const artifacts = evidenceRoot
		? path.join(evidenceRoot, "artifacts", "browser.critical-render-path")
		: path.join(runRoot, "browser-artifacts");
	for (const directory of [extractRoot, workspace, home, agent, artifacts])
		fs.mkdirSync(directory, { recursive: true });
	execFileSync("tar", ["-xzf", tarball, "-C", extractRoot]);
	const uiDist = path.join(extractRoot, "package", "ui");
	if (!fs.existsSync(path.join(uiDist, "index.html")))
		throw new Error("packed artifact does not contain UI index.html");

	const previous = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	};
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = agent;
	const registry = new DeterministicRegistry(workspace);
	const runtime = await createPichamberServer({
		cwd: workspace,
		uiDist,
		host: "127.0.0.1",
		port: 0,
		registry,
		terminal: false,
	});
	const started = await runtime.start(0, "127.0.0.1");
	const browser = await chromium.launch({ headless: true, executablePath });
	const page = await browser.newPage();
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	try {
		await page.goto(started.url, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await page.waitForFunction(
			() => document.body.innerText.trim().length > 0,
			null,
			{ timeout: 30_000 },
		);
		const session = await page.evaluate(async () => {
			const response = await fetch("/api/session", { method: "POST" });
			if (!response.ok)
				throw new Error(`session create returned ${response.status}`);
			return response.json();
		});
		if (!session || typeof session.id !== "string")
			throw new Error("browser session creation returned no id");
		await page.goto(
			`${started.url}/?session=${encodeURIComponent(session.id)}&directory=${encodeURIComponent(workspace)}`,
			{
				waitUntil: "domcontentloaded",
				timeout: 60_000,
			},
		);
		await page.evaluate(
			async ({ id }) => {
				const response = await fetch(
					`/api/session/${encodeURIComponent(id)}/prompt`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							parts: [{ type: "text", text: "release browser prompt" }],
						}),
					},
				);
				if (!response.ok) throw new Error(`prompt returned ${response.status}`);
			},
			{ id: session.id },
		);
		await page.waitForFunction(
			(reply) => document.body.innerText.includes(reply),
			REPLY,
			{ timeout: 30_000 },
		);

		const todos = await page.evaluate(
			async ({ id }) => {
				const response = await fetch(
					`/api/session/${encodeURIComponent(id)}/todo`,
				);
				if (!response.ok) throw new Error(`todo returned ${response.status}`);
				return response.json();
			},
			{ id: session.id },
		);
		if (!Array.isArray(todos) || todos[0]?.content !== "release browser todo") {
			throw new Error(
				"browser todo contract did not return the session todo state",
			);
		}

		let permissionPrompt;
		const stopPermissionCapture = registry.permissionBroker.subscribe(
			(prompt) => {
				permissionPrompt = prompt;
			},
		);
		const permissionResult = registry.permissionBroker.request({
			sessionId: session.id,
			kind: "select",
			title: "Allow release browser action?",
			options: ["Yes", "No"],
		});
		stopPermissionCapture();
		if (!permissionPrompt)
			throw new Error("permission broker emitted no prompt");
		const permissionReply = await page.evaluate(
			async ({ id }) => {
				const response = await fetch(
					`/api/permission/${encodeURIComponent(id)}/reply`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ reply: "once" }),
					},
				);
				return { status: response.status, body: await response.json() };
			},
			{ id: permissionPrompt.id },
		);
		if (
			permissionReply.status !== 200 ||
			permissionReply.body !== true ||
			(await permissionResult) !== "Yes"
		) {
			throw new Error("permission reply contract failed");
		}

		let questionPrompt;
		const stopQuestionCapture = registry.permissionBroker.subscribe(
			(prompt) => {
				questionPrompt = prompt;
			},
		);
		const questionResult = registry.permissionBroker.request({
			sessionId: session.id,
			kind: "input",
			title: "Release browser question",
		});
		stopQuestionCapture();
		if (!questionPrompt) throw new Error("question broker emitted no prompt");
		const questionReply = await page.evaluate(
			async ({ sessionId, requestId }) => {
				const response = await fetch(
					`/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ answers: [["release answer"]] }),
					},
				);
				return { status: response.status, body: await response.json() };
			},
			{ sessionId: session.id, requestId: questionPrompt.id },
		);
		if (
			questionReply.status !== 200 ||
			questionReply.body !== true ||
			(await questionResult) !== "release answer"
		) {
			throw new Error("question reply contract failed");
		}

		const abortStatus = await page.evaluate(
			async ({ id }) => {
				const response = await fetch(
					`/api/session/${encodeURIComponent(id)}/abort`,
					{ method: "POST" },
				);
				return response.status;
			},
			{ id: session.id },
		);
		if (abortStatus !== 204 || !registry.get(session.id)?.client.aborted)
			throw new Error("abort contract failed");

		await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
		await page.waitForFunction(
			(reply) => document.body.innerText.includes(reply),
			REPLY,
			{ timeout: 30_000 },
		);
		await page.screenshot({
			path: path.join(artifacts, "critical-path.png"),
			fullPage: true,
		});
		if (pageErrors.length)
			throw new Error(`browser page errors: ${pageErrors.join(" | ")}`);
	} catch (error) {
		try {
			await page.screenshot({
				path: path.join(artifacts, "failure.png"),
				fullPage: true,
			});
		} catch {}
		throw error;
	} finally {
		await browser.close();
		await runtime.stop();
		if (previous.HOME === undefined) delete process.env.HOME;
		else process.env.HOME = previous.HOME;
		if (previous.PI_CODING_AGENT_DIR === undefined)
			delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.PI_CODING_AGENT_DIR;
	}
	console.log(
		"packed UI browser bootstrap/session/prompt/SSE/todo/permission/question/abort/render/reload scenario passed",
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
