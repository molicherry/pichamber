/**
 * pi SDK adapter — the only module (besides mapEvent) that imports the pi SDK.
 * Implements the stable AgentClient contract on top of createAgentSession().
 */

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentClient, PromptOpts } from "../contracts/client.js";
import type { AgentEvent } from "../contracts/events.js";
import type { AgentMessage, AgentPart, AgentSnapshot } from "../contracts/snapshot.js";
import { mapEvent } from "./mapEvent.js";
import { createWebUIContext, createWriteGateExtension } from "../permission.js";
import type { PermissionBroker } from "../permission.js";

/** Self-contained config — no pi types leak into the public contract. */
export interface AgentClientConfig {
	cwd?: string;
	/** Base tool names to enable. Extension tools (MCP/lsp/etc.) are auto-activated by pi and preserved. */
	tools?: string[];
	/** Optional model selection; falls back to pi defaults when omitted. */
	model?: { provider: string; id: string };
	/** Session storage; defaults to in-memory. Pass a SessionManager instance to control persistence per session. */
	sessionManager?: "in-memory" | "persist" | "continue-recent" | SessionManager;
	/** Custom tools to register on the session (in addition to built-in tools). */
	customTools?: ToolDefinition[];
	/** Permission broker — when set, a web-backed UI context is bound so permission prompts reach the browser. */
	permissionBroker?: PermissionBroker;
	/** Gate write/edit tools behind a runtime confirmation (default: on, requires permissionBroker). */
	writeGate?: boolean;
	/** Called when the registered tool set changes (MCP tools register/unregister dynamically). */
	onToolsChanged?: () => void;
}

export async function createAgentClient(
	config: AgentClientConfig = {},
): Promise<AgentClient> {
	const cwd = config.cwd ?? process.cwd();
	const modelRuntime = await ModelRuntime.create();

	let model: ReturnType<ModelRuntime["getModel"]> | undefined;
	if (config.model) {
		model = modelRuntime.getModel(config.model.provider, config.model.id);
		if (!model) {
			throw new Error(
				`Model not found: ${config.model.provider}/${config.model.id}`,
			);
		}
	}

	const sessionManager =
		config.sessionManager instanceof SessionManager
			? config.sessionManager
			: resolveSessionManager(config.sessionManager, cwd);

	// Write/edit permission gate: an inline extension that intercepts write/edit
	// tool calls and asks the user via the web UI context. Only active when a
	// broker is bound (otherwise the prompt would hang with no UI).
	const writeGate = config.writeGate !== false && config.permissionBroker !== undefined;
	const resourceLoader = writeGate
		? new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				extensionFactories: [createWriteGateExtension()],
			})
		: undefined;
	if (resourceLoader) await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		modelRuntime,
		sessionManager,
		...(model ? { model } : {}),
		...(config.customTools ? { customTools: config.customTools } : {}),
		...(resourceLoader ? { resourceLoader } : {}),
	});

	if (config.permissionBroker) {
		// Inject a web-backed UI context so pi's permission extensions can ask
		// the user through the browser instead of the no-op UI context.
		await session.bindExtensions({
			uiContext: createWebUIContext(config.permissionBroker, session.sessionId),
		});
	}

	const resolvedModel = model ?? modelRuntime.getModels()[0];
	const client = new PiAgentClient(session, modelRuntime, resolvedModel, config.onToolsChanged);
	client.syncActiveTools(config.tools);
	return client;
}

function resolveSessionManager(
	kind: "in-memory" | "persist" | "continue-recent" | undefined,
	cwd: string,
): SessionManager {
	switch (kind) {
		case "persist":
			return SessionManager.create(cwd);
		case "continue-recent":
			return SessionManager.continueRecent(cwd);
		case "in-memory":
		case undefined:
			return SessionManager.inMemory();
	}
}

/** Default tool set when no explicit base tools are configured. */
const DEFAULT_BASE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "todo", "subtask"];

class PiAgentClient implements AgentClient {
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private unsubscribe: (() => void) | undefined;
	private baseTools: string[] | undefined;
	private previousToolNames: string[] | undefined;

	constructor(
		private readonly session: AgentSession,
		private readonly modelRuntime: ModelRuntime,
		private readonly model: ReturnType<ModelRuntime["getModel"]>,
		private readonly onToolsChanged?: () => void,
	) {}

	/**
	 * Recompute the active tool set.
	 *
	 * pi's default (no `tools` allowlist) auto-activates newly registered
	 * extension tools — including MCP tools, whose names are dynamic
	 * (`<serverName>_<toolName>`, e.g. `echo_test_mcp_echo`), so they cannot be
	 * matched by a fixed prefix. We therefore take the UNION of pi's current
	 * active set with the requested base tools instead of replacing it, which
	 * both preserves MCP/extension tools and fills in extra built-ins
	 * (grep/find/ls). Idempotent; safe to call before every prompt.
	 */
	syncActiveTools(baseTools?: string[]): void {
		this.baseTools = baseTools;
		const all = this.session.getAllTools().map((t) => t.name).sort();
		const current = this.session.getActiveToolNames();
		const base = baseTools ?? DEFAULT_BASE_TOOLS;
		const active = [...new Set([...current, ...base])];
		this.session.setActiveToolsByName(active);
		if (this.previousToolNames && this.previousToolNames.join("\u0000") !== all.join("\u0000")) {
			this.onToolsChanged?.();
		}
		this.previousToolNames = all;
	}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		if (!this.unsubscribe) {
			this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
				const mapped = mapEvent(event);
				if (mapped) {
					for (const l of this.listeners) l(mapped);
				}
			});
		}
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) {
				this.unsubscribe?.();
				this.unsubscribe = undefined;
			}
		};
	}

	async prompt(input: string, opts?: PromptOpts): Promise<void> {
		this.syncActiveTools(this.baseTools);
		await this.session.prompt(input, opts);
	}

	async steer(text: string): Promise<void> {
		await this.session.steer(text);
	}

	async followUp(text: string): Promise<void> {
		await this.session.followUp(text);
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	async generateText(prompt: string, systemPrompt?: string): Promise<string> {
		if (!this.model) return "";
		const stream = this.modelRuntime.streamSimple(this.model, {
			systemPrompt,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		});
		const msg = await stream.result();
		const content = (msg.content ?? []) as Array<{ type: string; text?: string }>;
		return content
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("");
	}

	getSnapshot(): AgentSnapshot {
		const state = this.session.agent.state;
		const messages: AgentMessage[] = (state.messages ?? []).map(
			toContractMessage,
		);

		return {
			sessionId: this.session.sessionId,
			isStreaming: this.session.isStreaming,
			messages,
			...(state.errorMessage ? { error: state.errorMessage } : {}),
		};
	}

	async dispose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.listeners.clear();
		this.session.dispose();
	}
}

/**
 * Normalize a pi message (a discriminated union incl. custom coding-agent
 * messages) into the self-contained AgentMessage contract.
 */
function toContractMessage(m: {
	role: string;
	timestamp: number;
	content?: unknown;
	command?: string;
	output?: string;
	summary?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
}): AgentMessage {
	const timestamp = m.timestamp;
	switch (m.role) {
		case "user":
			return { role: "user", timestamp, ...withText(m.content) };
		case "assistant":
			return { role: "assistant", timestamp, parts: mapParts(m.content) };
		case "toolResult": {
			const details = (m.details ?? {}) as Record<string, unknown>;
			const patch = typeof details.patch === "string" ? details.patch : undefined;
			return {
				role: "tool",
				timestamp,
				text: extractText(m.content),
				toolCallId: m.toolCallId,
				toolName: m.toolName,
				isError: details.isError === true,
				...(patch ? { patch } : {}),
			};
		}
		case "custom":
			return { role: "assistant", timestamp, ...withText(m.content) };
		case "bashExecution":
			return {
				role: "tool",
				timestamp,
				text: `Ran \`${m.command ?? ""}\`\n${m.output ?? ""}`,
				toolCallId: `bash-${timestamp}`,
				toolName: "bash",
			};
		case "branchSummary":
		case "compactionSummary":
			return { role: "assistant", timestamp, text: m.summary ?? "" };
		default:
			// Unknown roles degrade to a best-effort assistant message.
			return { role: "assistant", timestamp, ...withText(m.content) };
	}
}

/** Map pi assistant content parts (text/thinking/toolCall) to AgentPart[]. */
function mapParts(content: unknown): AgentPart[] {
	if (!Array.isArray(content)) return [];
	const parts: AgentPart[] = [];
	for (const item of content) {
		if (typeof item !== "object" || item === null || !("type" in item)) continue;
		const p = item as {
			type: string;
			text?: string;
			thinking?: string;
			id?: string;
			name?: string;
			arguments?: unknown;
		};
		if (p.type === "text" && typeof p.text === "string") {
			parts.push({ type: "text", text: p.text });
		} else if (p.type === "thinking" && typeof p.thinking === "string") {
			parts.push({ type: "reasoning", text: p.thinking });
		} else if (p.type === "toolCall" && typeof p.id === "string" && typeof p.name === "string") {
			parts.push({ type: "toolCall", id: p.id, name: p.name, arguments: (p.arguments ?? {}) as Record<string, unknown> });
		}
	}
	return parts;
}

function withText(content: unknown): { text?: string } {
	const text = extractText(content);
	return text !== undefined ? { text } : {};
}

function extractText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (
			typeof item === "object" &&
			item !== null &&
			"type" in item &&
			item.type === "text" &&
			"text" in item &&
			typeof item.text === "string"
		) {
			parts.push(item.text);
		}
	}
	return parts.length > 0 ? parts.join("") : undefined;
}
