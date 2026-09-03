#!/usr/bin/env bun
"use strict";

/**
 * Deterministic fake AgentClient + SessionRegistry for UI E2E.
 *
 * The fake client still drives the REAL SessionStore → HTTP → SSE → UI reducer
 * pipeline; only the model call itself is scripted. Behavior is selected by the
 * user prompt text (see the E2E:XXX table in doc/UI_E2E_CASES.md §3.4).
 *
 * Fault controls are invoked by the harness (NOT via page.evaluate(fetch)).
 */

const {
	SessionStore,
	PermissionBroker,
	TodoState,
} = require("../../../packages/agent/src/index.ts");

const REPLY_STREAM = "PICHAMBER_STREAM_OK";
const REPLY_SESSION_A = "PICHAMBER_SESSION_A_OK";
const REPLY_SESSION_B = "PICHAMBER_SESSION_B_OK";
const REPLY_ABORT_PARTIAL = "PICHAMBER_ABORT_PARTIAL";
const REPLY_ABORT_FORBIDDEN = "PICHAMBER_ABORT_FORBIDDEN_TAIL";
const REPLY_PERMISSION_ALLOWED = "PICHAMBER_PERMISSION_ALLOWED";
const REPLY_PERMISSION_REJECTED = "PICHAMBER_PERMISSION_REJECTED";
const REPLY_QUESTION_PREFIX = "PICHAMBER_QUESTION_";
const REPLY_QUESTION_DISMISSED = "PICHAMBER_QUESTION_DISMISSED";
const REPLY_RECONNECTED = "PICHAMBER_RECONNECTED_OK";
const REPLY_DEFAULT = "PICHAMBER_DEFAULT_OK";
const TODO_TEXT = "release browser todo";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DeterministicClient {
	constructor({ sessionId, permissionBroker, todoState, manager }) {
		this.sessionId = sessionId;
		this.permissionBroker = permissionBroker;
		this.todoState = todoState;
		this.manager = manager || null;
		this.listeners = new Set();
		this.aborted = false;
		this._abortWaiters = [];
		this.failNextAgentRun = null; // { status, message } — accepted-204-then-async-error seam
		this.lastReply = "";
	}

	emit(event) {
		if (event.type === "text_delta") this.lastReply += event.delta;
		for (const listener of this.listeners) listener(event);
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getSnapshot() {
		// Rebuild a snapshot from the real SessionManager when a manager is bound
		// (server-restart persistence).
		if (this.manager) {
			const messages = [];
			for (const entry of this.manager.getEntries()) {
				if (entry.type === "message" && entry.message) {
					messages.push(this.toAgentMessage(entry.message));
				}
			}
			return { sessionId: this.sessionId, isStreaming: false, messages };
		}
		return { sessionId: this.sessionId, isStreaming: false, messages: [] };
	}

	toAgentMessage(message) {
		const text = Array.isArray(message.content)
			? message.content.filter((c) => c?.type === "text").map((c) => c.text).join("")
			: String(message.content ?? "");
		return {
			id: message.id ?? `restored-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			role: message.role,
			timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
			text: text || undefined,
			parts: text ? [{ type: "text", text }] : [],
			usage: message.usage ?? undefined,
		};
	}

	async steer() {}
	async followUp() {}

	async abort() {
		this.aborted = true;
		for (const resolve of this._abortWaiters.splice(0)) resolve();
	}

	async dispose() {}

	async generateText() {
		return REPLY_DEFAULT;
	}

	_waitAbort() {
		if (this.aborted) return Promise.resolve();
		return new Promise((resolve) => this._abortWaiters.push(resolve));
	}

	async prompt(text) {
		if (this.failNextAgentRun) {
			const failure = this.failNextAgentRun;
			this.failNextAgentRun = null;
			// Accepted-204-then-async-failure: the prompt request already returned
			// 204 and dispatched; the failure surfaces later as an agent status
			// error. Distinct from the HTTP-level 503 fault (see
			// DeterministicRegistry.failNextPrompt / takeNextPromptFailure).
			this.emit({ type: "agent_start" });
			this.emit({ type: "status", status: "error", error: failure.message || "E2E_PROMPT_FAILURE" });
			return;
		}

		this.aborted = false;
		const trimmed = String(text || "").trim();

		if (trimmed === "E2E:STREAM" || trimmed === "E2E:AFTER_RECONNECT") {
			this.emit({ type: "agent_start" });
			const parts =
				trimmed === "E2E:STREAM"
					? ["PICHAMBER_", "STREAM_", "OK"]
					: ["PICHAMBER_", "RECONNECTED_", "OK"];
			for (const delta of parts) {
				await sleep(500);
				this.emit({ type: "text_delta", delta });
			}
			this.emit({ type: "agent_end" });
			return;
		}

		if (trimmed === "E2E:SESSION_A" || trimmed === "E2E:SESSION_B") {
			this.emit({ type: "agent_start" });
			this.emit({
				type: "text_delta",
				delta: trimmed === "E2E:SESSION_A" ? REPLY_SESSION_A : REPLY_SESSION_B,
			});
			this.emit({ type: "agent_end" });
			return;
		}

		if (trimmed === "E2E:SLOW_ABORT") {
			this.emit({ type: "agent_start" });
			this.emit({ type: "text_delta", delta: REPLY_ABORT_PARTIAL });
			await this._waitAbort();
			if (this.aborted) {
				this.emit({ type: "agent_end" }); // close the run so the session returns to idle
				return;
			}
			this.emit({ type: "text_delta", delta: REPLY_ABORT_FORBIDDEN });
			this.emit({ type: "agent_end" });
			return;
		}

		if (
			trimmed === "E2E:PERMISSION_ALLOW" ||
			trimmed === "E2E:PERMISSION_REJECT"
		) {
			this.emit({ type: "agent_start" });
			const choice = await this.permissionBroker.request({
				sessionId: this.sessionId,
				kind: "select",
				title: "Allow release browser action?",
				options: ["Yes", "No"],
			});
			this.emit({
				type: "text_delta",
				delta:
					choice === "Yes"
						? REPLY_PERMISSION_ALLOWED
						: REPLY_PERMISSION_REJECTED,
			});
			this.emit({ type: "agent_end" });
			return;
		}

		if (trimmed === "E2E:QUESTION" || trimmed === "E2E:QUESTION_DISMISS") {
			this.emit({ type: "agent_start" });
			const answer = await this.permissionBroker.request({
				sessionId: this.sessionId,
				kind: "input",
				title: "Release browser question",
			});
			this.emit({
				type: "text_delta",
				delta:
					answer === undefined
						? REPLY_QUESTION_DISMISSED
						: `${REPLY_QUESTION_PREFIX}${answer}`,
			});
			this.emit({ type: "agent_end" });
			return;
		}

		if (trimmed === "E2E:TODO") {
			this.todoState.add(TODO_TEXT, "high");
			this.emit({ type: "agent_start" });
			this.emit({ type: "text_delta", delta: "PICHAMBER_TODO_OK" });
			this.emit({ type: "agent_end" });
			return;
		}

		// Default: single-turn deterministic reply.
		this.emit({ type: "agent_start" });
		this.emit({ type: "text_delta", delta: REPLY_DEFAULT });
		this.emit({ type: "agent_end" });
	}
}

class DeterministicRegistry {
	constructor(cwd) {
		this.cwd = cwd;
		this.permissionBroker = new PermissionBroker();
		this.runtimes = new Map();
		this.listeners = new Set();
		this.nextId = 1;
		this._failNextPrompt = null;
		this._failNextAgentRun = null;
		this._dropSse = false;
	}

	// ---- fault controls (harness-only) ----
	// HTTP-level prompt failure: the next POST /prompt(_async) returns `status`
	// instead of dispatching. Consumed once by the web layer's prompt handler via
	// takeNextPromptFailure.
	failNextPrompt(status, message) {
		this._failNextPrompt = { status, message };
	}
	takeNextPromptFailure() {
		const failure = this._failNextPrompt;
		this._failNextPrompt = null;
		return failure;
	}
	// Accepted-204-then-async-failure: the prompt request succeeds, then the
	// client emits an agent status error. Models post-dispatch model failures
	// without an HTTP error status.
	failNextAgentRun(status, message) {
		this._failNextAgentRun = { status, message };
	}
	dropAllSseConnections() {
		this._dropSse = true;
		// The harness wires this flag to an actual SSE close via the web layer's
		// /api/_e2e/drop-sse endpoint; the fake registry itself only records intent.
		return this._dropSse;
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
		const id = `ses_e2e_${this.nextId++}`;
		const todoState = new TodoState();
		const client = new DeterministicClient({
			sessionId: id,
			permissionBroker: this.permissionBroker,
			todoState,
		});
		if (this._failNextAgentRun) {
			client.failNextAgentRun = this._failNextAgentRun;
			this._failNextAgentRun = null;
		}
		const store = new SessionStore(client, {
			id,
			title: `E2E Session ${this.nextId - 1}`,
			directory: this.cwd,
			todoState,
		});
		store.subscribe((change) => {
			for (const listener of this.listeners) listener(change, id);
		});
		store.start();
		const runtime = {
			id,
			title: store.getSession().title,
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
			...(runtime.store.getSession().time.archived !== undefined
				? { archived: runtime.store.getSession().time.archived }
				: {}),
			tokens: {
				input: 0,
				output: 0,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			},
		}));
	}

	async generateText() {
		return REPLY_DEFAULT;
	}

	// Session mutation methods (parity with the real SessionRegistry; the UI's
	// rename/archive/delete flow drives these on the in-memory store).
	async rename(id, title) {
		const rt = this.get(id);
		if (!rt) return null;
		rt.store.setTitle(title);
		return rt;
	}
	async setArchived(id, archived) {
		const rt = this.get(id);
		if (!rt) return null;
		rt.store.setArchived(archived);
		return rt;
	}
	async remove(id) {
		const rt = this.get(id);
		if (!rt) return false;
		rt.store.stop();
		await rt.client.dispose().catch(() => {});
		this.runtimes.delete(id);
		return true;
	}
}

/**
 * Factory for injecting a deterministic client into the REAL SessionRegistry
 * (used by P0-10 to test server-restart persistence with the real SessionManager).
 */
function createDeterministicClientFactory() {
	return async (manager, ctx) => {
		const client = new DeterministicClient({
			sessionId: manager.getSessionId(),
			permissionBroker: ctx.permissionBroker,
			todoState: ctx.todoState,
			manager,
		});
		// Persist user + assistant messages into the real SessionManager so
		// server restart restores them.
		const originalPrompt = client.prompt.bind(client);
		client.prompt = async (text) => {
			manager.appendMessage({
				role: "user",
				content: [{ type: "text", text }],
				api: "e2e",
				provider: "e2e",
				model: "deterministic",
				usage: { input: 0, output: 0, totalTokens: 0 },
				stopReason: "stop",
				timestamp: Date.now(),
			});
			client.lastReply = "";
			await originalPrompt(text);
			if (client.lastReply) {
				manager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: client.lastReply }],
					api: "e2e",
					provider: "e2e",
					model: "deterministic",
					usage: { input: 0, output: 0, totalTokens: 0 },
					stopReason: "stop",
					timestamp: Date.now(),
				});
			}
		};
		return client;
	};
}

module.exports = {
	DeterministicRegistry,
	DeterministicClient,
	createDeterministicClientFactory,
	REPLY_STREAM,
	REPLY_SESSION_A,
	REPLY_SESSION_B,
	REPLY_ABORT_PARTIAL,
	REPLY_ABORT_FORBIDDEN,
	REPLY_PERMISSION_ALLOWED,
	REPLY_PERMISSION_REJECTED,
	REPLY_QUESTION_DISMISSED,
	REPLY_RECONNECTED,
	TODO_TEXT,
};
