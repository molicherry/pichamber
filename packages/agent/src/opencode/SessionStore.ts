/**
 * SessionStore — aggregates the pi event stream into the opencode-compatible
 * Session → Message → Part model. v2: complete ToolPart (input/output),
 * StepStart/StepFinish, PatchPart from edit diffs, and token aggregation.
 */

import type { AgentClient } from "../contracts/client.js";
import type { AgentEvent, AgentUsage } from "../contracts/events.js";
import type { AgentMessage } from "../contracts/snapshot.js";
import { TodoState } from "../todo.js";
import type { TodoItem } from "../todo.js";
import type {
  AssistantMessage,
  Message,
  Part,
  PatchPart,
  ReasoningPart,
  Session,
  StepFinishPart,
  StepStartPart,
  TextPart,
  ToolPart,
  ToolStateCompleted,
  ToolStateError,
  ToolStateRunning,
  UserMessage,
} from "./types.js";

export interface SessionStoreOptions {
  id?: string;
  title: string;
  directory: string;
  model?: { providerID: string; modelID: string };
  /** Per-session todo state (owned by the registry); mutations emit todo_updated. */
  todoState?: TodoState;
}

/**
 * Granular model mutations emitted to subscribers. The transport layer maps
 * these to opencode SSE events (session.updated, message.updated,
 * message.part.updated, message.part.delta, session.status).
 */
export type StoreChange =
  | { type: "session_updated" }
  | { type: "message_added"; message: Message }
  | { type: "message_updated"; message: Message }
  | { type: "part_added"; part: Part }
  | { type: "part_updated"; part: Part }
  | { type: "part_delta"; messageID: string; partID: string; field: string; delta: string }
  | { type: "status"; status: "busy" | "idle" | "error" }
  | { type: "todo_updated"; todos: TodoItem[] };

export class SessionStore {
  private session: Session;
  private messages: Message[] = [];
  private parts: Part[] = [];
  private currentAssistant: AssistantMessage | null = null;
  private currentText: TextPart | null = null;
  private currentReasoning: ReasoningPart | null = null;
  private msgSeq = 0;
  private partSeq = 0;
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private unsubscribe: (() => void) | undefined;
  private todoState: TodoState | undefined;

  constructor(
    private readonly client: AgentClient,
    options: SessionStoreOptions,
  ) {
    const id = options.id ?? "session-1";
    this.session = {
      id,
      slug: id,
      projectID: "default",
      directory: options.directory,
      title: options.title,
      ...(options.model
        ? { model: { id: options.model.modelID, providerID: options.model.providerID } }
        : {}),
      version: "0",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() },
    };
    if (options.todoState) {
      this.todoState = options.todoState;
      this.todoState.subscribe((todos) => {
        this.emit({ type: "todo_updated", todos });
      });
    }
  }

  start(): void {
    this.unsubscribe = this.client.subscribe((event) => this.handleEvent(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  getSession(): Session {
    return this.session;
  }

  getStatus(): "busy" | "idle" {
    return this.currentAssistant ? "busy" : "idle";
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getTodos(): TodoItem[] {
    return this.todoState?.list() ?? [];
  }

  getParts(messageID?: string): Part[] {
    if (!messageID) return this.parts;
    return this.parts.filter((p) => p.messageID === messageID);
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Record a user prompt as a completed user message + text part. */
  pushUser(text: string, messageId?: string): void {
    const message: UserMessage = {
      id: messageId ?? this.nextMessageId(),
      sessionID: this.session.id,
      role: "user",
      time: { created: Date.now() },
      agent: "pi",
      model: { providerID: "pi", modelID: "default" },
    };
    this.messages.push(message);
    this.emit({ type: "message_added", message });
    const part: TextPart = {
      id: this.nextPartId(),
      sessionID: this.session.id,
      messageID: message.id,
      type: "text",
      text,
      time: { start: Date.now(), end: Date.now() },
    };
    this.parts.push(part);
    this.emit({ type: "part_added", part });
    this.touch();
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.openAssistant();
        break;
      case "thinking_delta":
        this.appendReasoning(event.delta);
        break;
      case "text_delta":
        this.appendText(event.delta);
        break;
      case "tool_start":
        this.openTool(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_end":
        this.closeTool(event.toolCallId, event.output, event.details, event.isError);
        break;
      case "tool_update":
        this.updateToolOutput(event.toolCallId, event.partial);
        break;
      case "turn_start":
        this.openStep();
        break;
      case "turn_end":
        this.closeStep(event.usage);
        break;
      case "agent_end":
        this.closeAssistant(event.error);
        break;
      case "status":
        if (event.status === "error") this.setError(event.error ?? "Error");
        break;
      case "message_start":
        // A new message boundary resets streaming part accumulation so
        // consecutive turns (or text around tool calls) don't merge.
        this.currentText = null;
        this.currentReasoning = null;
        break;
      default:
        break;
    }
    this.touch();
  }

  private openAssistant(): void {
    if (this.currentAssistant) return;
    const message: AssistantMessage = {
      id: this.nextMessageId(),
      sessionID: this.session.id,
      role: "assistant",
      time: { created: Date.now() },
      parentID: this.lastUserMessageId() ?? "",
      modelID: this.session.model?.id ?? "default",
      providerID: this.session.model?.providerID ?? "pi",
      mode: "default",
      agent: "pi",
      path: { cwd: this.session.directory, root: this.session.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
    this.currentAssistant = message;
    this.messages.push(message);
    this.emit({ type: "message_added", message });
    this.emit({ type: "status", status: "busy" });
  }

  private appendReasoning(delta: string): void {
    this.openAssistant();
    if (!this.currentAssistant) return;
    if (!this.currentReasoning) {
      const part: ReasoningPart = {
        id: this.nextPartId(),
        sessionID: this.session.id,
        messageID: this.currentAssistant.id,
        type: "reasoning",
        text: delta,
        time: { start: Date.now() },
      };
      this.currentReasoning = part;
      this.parts.push(part);
      this.emit({ type: "part_added", part });
    } else {
      this.currentReasoning.text += delta;
      const rp = this.currentReasoning;
      this.emit({ type: "part_delta", messageID: rp.messageID, partID: rp.id, field: "text", delta });
    }
    this.currentText = null;
  }

  private appendText(delta: string): void {
    this.openAssistant();
    if (!this.currentAssistant) return;
    this.currentReasoning = null;
    if (!this.currentText) {
      const part: TextPart = {
        id: this.nextPartId(),
        sessionID: this.session.id,
        messageID: this.currentAssistant.id,
        type: "text",
        text: delta,
        time: { start: Date.now() },
      };
      this.currentText = part;
      this.parts.push(part);
      this.emit({ type: "part_added", part });
    } else {
      this.currentText.text += delta;
      const tp = this.currentText;
      this.emit({ type: "part_delta", messageID: tp.messageID, partID: tp.id, field: "text", delta });
    }
  }

  private openTool(
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
  ): void {
    this.openAssistant();
    if (!this.currentAssistant) return;
    const state: ToolStateRunning = {
      status: "running",
      input: args,
      time: { start: Date.now() },
    };
    const part: ToolPart = {
      id: this.nextPartId(),
      sessionID: this.session.id,
      messageID: this.currentAssistant.id,
      type: "tool",
      callID: toolCallId,
      tool: name,
      state,
    };
    this.parts.push(part);
    this.emit({ type: "part_added", part });
    this.currentText = null;
    this.currentReasoning = null;
  }

  private closeTool(
    toolCallId: string,
    output: string,
    details: Record<string, unknown>,
    isError: boolean,
  ): void {
    const idx = findLastIndex(
      this.parts,
      (p) => p.type === "tool" && p.callID === toolCallId,
    );
    if (idx < 0) return;
    const tool = this.parts[idx];
    if (!tool || tool.type !== "tool") return;

    const running = tool.state as ToolStateRunning;
    const start = running.time?.start ?? Date.now();
    const input = running.input ?? {};

    const state: ToolStateCompleted | ToolStateError = isError
      ? { status: "error", input, error: output || "Tool failed", time: { start, end: Date.now() } }
      : {
          status: "completed",
          input,
          output,
          title: tool.tool,
          metadata: details,
          time: { start, end: Date.now() },
        };
    this.parts[idx] = { ...tool, state };
    this.emit({ type: "part_updated", part: this.parts[idx] });

    // Emit a PatchPart when the tool reports a unified patch (edit tool).
    const patchText = typeof details["patch"] === "string" ? details["patch"] : "";
    if (patchText) {
      const patch: PatchPart = {
        id: this.nextPartId(),
        sessionID: this.session.id,
        messageID: tool.messageID,
        type: "patch",
        hash: hashString(patchText),
        files: extractFilesFromDiff(patchText),
      };
      this.parts.push(patch);
      this.emit({ type: "part_added", part: patch });
    }
  }

  private updateToolOutput(toolCallId: string, partial: string): void {
    const idx = findLastIndex(
      this.parts,
      (p) => p.type === "tool" && p.callID === toolCallId,
    );
    if (idx < 0) return;
    const tool = this.parts[idx];
    if (!tool || tool.type !== "tool") return;
    const state = tool.state as ToolStateRunning;
    if (state.status !== "running") return;
    const updated = { ...tool, state: { ...state, title: partial } };
    this.parts[idx] = updated;
    this.emit({ type: "part_updated", part: updated });
  }

  private openStep(): void {
    this.openAssistant();
    if (!this.currentAssistant) return;
    const part: StepStartPart = {
      id: this.nextPartId(),
      sessionID: this.session.id,
      messageID: this.currentAssistant.id,
      type: "step-start",
    };
    this.parts.push(part);
    this.emit({ type: "part_added", part });
  }

  private closeStep(usage: AgentUsage): void {
    if (!this.currentAssistant) return;
    const part: StepFinishPart = {
      id: this.nextPartId(),
      sessionID: this.session.id,
      messageID: this.currentAssistant.id,
      type: "step-finish",
      reason: this.currentAssistant.error ? "error" : "end_turn",
      cost: usage.cost,
      tokens: {
        total: usage.totalTokens,
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cache: { read: usage.cacheRead, write: usage.cacheWrite },
      },
    };
    this.parts.push(part);
    this.emit({ type: "part_added", part });
    this.accumulateTokens(usage);
  }

  private accumulateTokens(usage: AgentUsage): void {
    const t = this.session.tokens;
    if (!t) return;
    this.session.tokens = {
      input: t.input + usage.input,
      output: t.output + usage.output,
      reasoning: t.reasoning + usage.reasoning,
      cache: {
        read: t.cache.read + usage.cacheRead,
        write: t.cache.write + usage.cacheWrite,
      },
    };
  }

  private closeAssistant(error?: string): void {
    if (!this.currentAssistant) return;
    const assistant = this.currentAssistant;
    this.currentAssistant.time = {
      ...this.currentAssistant.time,
      completed: Date.now(),
    };
    this.currentAssistant.finish = error ? "error" : "completed";
    if (error) {
      this.currentAssistant.error = {
        name: "UnknownError",
        data: { message: error },
      };
    }
    if (this.currentText) {
      this.currentText.time = {
        start: this.currentText.time?.start ?? Date.now(),
        end: Date.now(),
      };
    }
    if (this.currentReasoning) {
      this.currentReasoning.time = { ...this.currentReasoning.time, end: Date.now() };
    }
    this.currentAssistant = null;
    this.currentText = null;
    this.currentReasoning = null;
    this.emit({ type: "message_updated", message: assistant });
    this.emit({ type: "status", status: "idle" });
  }

  private setError(message: string): void {
    if (this.currentAssistant) {
      this.currentAssistant.error = { name: "UnknownError", data: { message } };
      this.emit({ type: "message_updated", message: this.currentAssistant });
    }
  }

  private nextMessageId(): string {
    this.msgSeq += 1;
    return `msg-${this.msgSeq}`;
  }

  private nextPartId(): string {
    this.partSeq += 1;
    return `part-${this.partSeq}`;
  }

  private lastUserMessageId(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && m.role === "user") return m.id;
    }
    return undefined;
  }

  private touch(): void {
    this.session.time.updated = Date.now();
    this.emit({ type: "session_updated" });
  }

  private emit(change: StoreChange): void {
    for (const listener of this.listeners) listener(change);
  }

	/**
	 * Seed the store with history from a prior run. Called before start() when
	 * reopening an existing session. Reconstructs text, reasoning, tool and patch
	 * parts from the normalized message stream so tool calls/edits survive a
	 * reload (tool results are folded back into their ToolPart state).
	 */
	restore(messages: AgentMessage[]): void {
		if (this.messages.length > 0 || this.parts.length > 0) return;

		// Index tool results by callID so tool parts can be completed on restore.
		const toolResults = new Map<string, AgentMessage>();
		for (const msg of messages) {
			if (msg.role === "tool" && msg.toolCallId) toolResults.set(msg.toolCallId, msg);
		}

		for (const msg of messages) {
			if (msg.role === "user") {
				if (!msg.text) continue;
				const message: UserMessage = {
					id: this.nextMessageId(),
					sessionID: this.session.id,
					role: "user",
					time: { created: msg.timestamp },
					agent: "pi",
					model: { providerID: "pi", modelID: "default" },
				};
				this.messages.push(message);
				this.parts.push({
					id: this.nextPartId(),
					sessionID: this.session.id,
					messageID: message.id,
					type: "text",
					text: msg.text,
					time: { start: msg.timestamp, end: msg.timestamp },
				});
			} else if (msg.role === "assistant") {
				const parts = msg.parts ?? [];
				if (parts.length === 0 && !msg.text) continue;
				const message: AssistantMessage = {
					id: this.nextMessageId(),
					sessionID: this.session.id,
					role: "assistant",
					time: { created: msg.timestamp, completed: msg.timestamp },
					parentID: this.lastUserMessageId() ?? "",
					modelID: this.session.model?.id ?? "default",
					providerID: this.session.model?.providerID ?? "pi",
					mode: "default",
					agent: "pi",
					path: { cwd: this.session.directory, root: this.session.directory },
					cost: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
					finish: "completed",
				};
				this.messages.push(message);
				const ts = msg.timestamp;
				for (const part of parts) {
					if (part.type === "text" && part.text) {
						this.parts.push({
							id: this.nextPartId(),
							sessionID: this.session.id,
							messageID: message.id,
							type: "text",
							text: part.text,
							time: { start: ts, end: ts },
						});
					} else if (part.type === "reasoning" && part.text) {
						this.parts.push({
							id: this.nextPartId(),
							sessionID: this.session.id,
							messageID: message.id,
							type: "reasoning",
							text: part.text,
							time: { start: ts, end: ts },
						});
					} else if (part.type === "toolCall" && part.id && part.name) {
						const result = toolResults.get(part.id);
						const input = part.arguments ?? {};
						const state: ToolStateRunning | ToolStateCompleted | ToolStateError = result
							? result.isError
								? { status: "error", input, error: result.text ?? "Tool failed", time: { start: ts, end: ts } }
								: { status: "completed", input, output: result.text ?? "", title: part.name, metadata: {}, time: { start: ts, end: ts } }
							: { status: "running", input, time: { start: ts } };
						this.parts.push({
							id: this.nextPartId(),
							sessionID: this.session.id,
							messageID: message.id,
							type: "tool",
							callID: part.id,
							tool: part.name,
							state,
						});
						if (result?.patch) {
							this.parts.push({
								id: this.nextPartId(),
								sessionID: this.session.id,
								messageID: message.id,
								type: "patch",
								hash: hashString(result.patch),
								files: extractFilesFromDiff(result.patch),
							});
						}
					}
				}
				if (parts.length === 0 && msg.text) {
					this.parts.push({
						id: this.nextPartId(),
						sessionID: this.session.id,
						messageID: message.id,
						type: "text",
						text: msg.text,
						time: { start: ts, end: ts },
					});
				}
			}
		}
	}
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const item = arr[i];
    if (item !== undefined && pred(item)) return i;
  }
  return -1;
}

function extractFilesFromDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    // Match both `+++ b/path` (git) and `+++ path` (pi's jsdiff output).
    if (line.startsWith("+++ ")) {
      let f = line.slice(4).trim();
      if (f.startsWith("b/")) f = f.slice(2);
      const tab = f.indexOf("\t");
      if (tab >= 0) f = f.slice(0, tab);
      if (f && f !== "/dev/null" && !files.includes(f)) files.push(f);
    }
  }
  return files;
}

function hashString(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
