/**
 * Pure mapper from pi SDK session events to normalized AgentEvent.
 * v2: preserves tool input/output/details and turn usage (no longer drops them).
 * v3: preserves streaming tool partials (tool_update) and bash output deltas
 *     (bash_output), plus reasoning and cost usage fields.
 */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentUsage } from "../contracts/events.js";

export function mapEvent(event: AgentSessionEvent): AgentEvent | null {
	switch (event.type) {
		case "message_update": {
			const e = event.assistantMessageEvent;
			if (e.type === "text_delta") {
				return { type: "text_delta", delta: e.delta };
			}
			if (e.type === "thinking_delta") {
				return { type: "thinking_delta", delta: e.delta };
			}
			return null;
		}
		case "tool_execution_start": {
			const args = event.args as Record<string, unknown> | undefined;
			return {
				type: "tool_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: args ?? {},
			};
		}
		case "tool_execution_update": {
			const partial = extractText(
				(event.partialResult as { content?: unknown } | undefined)?.content,
			);
			if (!partial) return null;
			return {
				type: "tool_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				partial,
			};
		}
		case "tool_execution_end": {
			const result = (event.result ?? {}) as {
				content?: unknown;
				details?: unknown;
			};
			const details = result.details as Record<string, unknown> | undefined;
			return {
				type: "tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				output: extractText(result.content),
				details: details ?? {},
				isError: event.isError,
			};
		}
		case "turn_end": {
			const message = event.message as { usage?: unknown } | undefined;
			return { type: "turn_end", usage: extractUsage(message?.usage) };
		}
		case "bash_execution_update":
			return { type: "bash_output", delta: event.delta };
		case "message_start":
			return { type: "message_start" };
		case "message_end":
			return { type: "message_end" };
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end": {
			const messages = event.messages as Array<{ errorMessage?: string }> | undefined;
			const last = messages?.[messages.length - 1];
			return {
				type: "agent_end",
				...(last?.errorMessage ? { error: last.errorMessage } : {}),
			};
		}
		case "turn_start":
			return { type: "turn_start" };
		case "queue_update":
			return {
				type: "queue_update",
				steering: event.steering[0],
				followUp: event.followUp[0],
			};
		default:
			return null;
	}
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
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
	return parts.join("");
}

function extractUsage(usage: unknown): AgentUsage {
	const u = (usage ?? {}) as Record<string, unknown>;
	const cost = (u["cost"] ?? {}) as Record<string, unknown>;
	return {
		input: numberOrZero(u["input"]),
		output: numberOrZero(u["output"]),
		cacheRead: numberOrZero(u["cacheRead"]),
		cacheWrite: numberOrZero(u["cacheWrite"]),
		totalTokens: numberOrZero(u["totalTokens"]),
		reasoning: numberOrZero(u["reasoning"]),
		cost: numberOrZero(cost["total"]),
	};
}

function numberOrZero(v: unknown): number {
	return typeof v === "number" ? v : 0;
}
