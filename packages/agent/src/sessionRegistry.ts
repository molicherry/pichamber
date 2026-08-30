/**
 * SessionRegistry — manages multiple persisted sessions, each backed by an
 * independent AgentClient + SessionStore. Uses pi SDK's SessionManager JSONL
 * store for persistence and discovery; no new database.
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentClient } from "./contracts/client.js";
import { createAgentClient } from "./pi/PiAgentClient.js";
import { SessionStore } from "./opencode/SessionStore.js";
import type { StoreChange } from "./opencode/SessionStore.js";
import { TodoState, createTodoTool } from "./todo.js";
import type { TodoItem } from "./todo.js";
import { createSubtaskTool } from "./subtask.js";
import { PermissionBroker } from "./permission.js";

/** Per-session token totals (mapped from pi's per-message usage). */
export interface SessionTokens {
	input: number;
	output: number;
	reasoning: number;
	cache: { read: number; write: number };
}

/** Lightweight session summary (no live runtime), derived from disk. */
export interface SessionHandle {
	id: string;
	title: string;
	directory: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	tokens: SessionTokens;
}

/** A live session: the agent client plus its opencode-model store. */
export interface SessionRuntime {
	id: string;
	title: string;
	directory: string;
	client: AgentClient;
	store: SessionStore;
}

export interface SessionRegistryOptions {
	cwd: string;
	tools?: string[];
}

export class SessionRegistry {
	private readonly runtimes = new Map<string, SessionRuntime>();
	private readonly allListeners = new Set<
		(change: StoreChange, id: string) => void
	>();
	private readonly mcpToolsListeners = new Set<() => void>();

	constructor(private readonly opts: SessionRegistryOptions) {}

	/** Shared permission broker — the web layer subscribes and drives the UI cards. */
	readonly permissionBroker = new PermissionBroker();

	/** Subscribe to MCP tool-set changes (fires mcp.tools.changed). */
	subscribeMcpToolsChanged(listener: () => void): () => void {
		this.mcpToolsListeners.add(listener);
		return () => {
			this.mcpToolsListeners.delete(listener);
		};
	}

	get cwd(): string {
		return this.opts.cwd;
	}

	/** List persisted sessions (newest first, per pi SessionManager.list). */
	async list(): Promise<SessionHandle[]> {
		const infos = await SessionManager.list(this.opts.cwd);
		return infos.map((info) => {
			let tokens: SessionTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
			try {
				tokens = sumSessionTokens(SessionManager.open(info.path));
			} catch {
				// Unreadable session → zero totals (never fail the whole list).
			}
			return {
				id: info.id,
				title:
					info.name ??
					(info.firstMessage ? truncate(info.firstMessage) : "New session"),
				directory: info.cwd || this.opts.cwd,
				createdAt: info.created.getTime(),
				updatedAt: info.modified.getTime(),
				messageCount: info.messageCount,
				tokens,
			};
		});
	}

	/** Create a brand-new persisted session. */
	async create(): Promise<SessionRuntime> {
		const manager = SessionManager.create(this.opts.cwd);
		return this.buildRuntime(manager);
	}

	/** Open an existing persisted session by id (returns null if unknown). */
	async open(id: string): Promise<SessionRuntime | null> {
		const infos = await SessionManager.list(this.opts.cwd);
		const info = infos.find((i) => i.id === id);
		if (!info) return null;
		const manager = SessionManager.open(info.path);
		const titleHint =
			info.name ??
			(info.firstMessage ? truncate(info.firstMessage) : undefined);
		return this.buildRuntime(manager, titleHint);
	}

	/** Get a live runtime if it has already been created/opened this process. */
	get(id: string): SessionRuntime | undefined {
		return this.runtimes.get(id);
	}

	/** All live runtimes (for status fan-out). */
	runtimesList(): SessionRuntime[] {
		return [...this.runtimes.values()];
	}

	/** One-shot text generation, reusing a live client or a throwaway one. */
	async generateText(prompt: string, systemPrompt?: string): Promise<string> {
		const rt = this.runtimes.values().next().value;
		if (rt) return rt.client.generateText(prompt, systemPrompt);
		const client = await createAgentClient({ cwd: this.opts.cwd });
		try {
			return await client.generateText(prompt, systemPrompt);
		} finally {
			await client.dispose();
		}
	}

	/** Subscribe to changes from every live runtime (for SSE fan-out). */
	subscribeAll(
		listener: (change: StoreChange, id: string) => void,
	): () => void {
		this.allListeners.add(listener);
		return () => {
			this.allListeners.delete(listener);
		};
	}

	private async buildRuntime(
		manager: SessionManager,
		titleHint?: string,
	): Promise<SessionRuntime> {
		const id = manager.getSessionId();
		const existing = this.runtimes.get(id);
		if (existing) return existing;

		const todoState = new TodoState();

		// Restore persisted todos (stored as a custom session entry, latest wins).
		const entries = manager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type === "custom" && entry.customType === "todo") {
				const data = (entry as { data?: unknown }).data as { todos?: TodoItem[] } | undefined;
				if (data && Array.isArray(data.todos)) {
					todoState.setItems(data.todos);
				}
				break;
			}
		}

		// Persist todos as a custom session entry on every change.
		todoState.subscribe((todos) => {
			manager.appendCustomEntry("todo", { todos });
		});

		const client = await createAgentClient({
			cwd: this.opts.cwd,
			tools: this.opts.tools,
			sessionManager: manager,
			customTools: [createTodoTool(todoState), createSubtaskTool({ cwd: this.opts.cwd })],
			permissionBroker: this.permissionBroker,
			onToolsChanged: () => {
				for (const l of this.mcpToolsListeners) l();
			},
		});

		const store = new SessionStore(client, {
			id,
			title: titleHint ?? manager.getSessionName() ?? "New session",
			directory: this.opts.cwd,
			todoState,
		});

		// Best-effort text-level history restoration on reopen.
		const snapshot = client.getSnapshot();
		if (snapshot.messages.length > 0) {
			store.restore(snapshot.messages);
		}

		// Forward every runtime's store changes to global SSE subscribers.
		store.subscribe((change) => {
			for (const l of this.allListeners) l(change, id);
		});

		store.start();

		const runtime: SessionRuntime = {
			id,
			title: store.getSession().title,
			directory: this.opts.cwd,
			client,
			store,
		};
		this.runtimes.set(id, runtime);
		return runtime;
	}
}

function truncate(text: string, max = 60): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Sum per-message LLM usage across a session's entries into opencode token totals. */
function sumSessionTokens(manager: SessionManager): SessionTokens {
	const out: SessionTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
	for (const entry of manager.getEntries()) {
		const message = (entry as { message?: { usage?: unknown } }).message;
		if (!message?.usage) continue;
		const t = usageToTokens(message.usage);
		out.input += t.input;
		out.output += t.output;
		out.reasoning += t.reasoning;
		out.cache.read += t.cache.read;
		out.cache.write += t.cache.write;
	}
	return out;
}

function usageToTokens(usage: unknown): SessionTokens {
	const u = (usage ?? {}) as Record<string, unknown>;
	return {
		input: toNumber(u["input"]),
		output: toNumber(u["output"]),
		reasoning: toNumber(u["reasoning"]),
		cache: { read: toNumber(u["cacheRead"]), write: toNumber(u["cacheWrite"]) },
	};
}

function toNumber(v: unknown): number {
	return typeof v === "number" ? v : 0;
}
