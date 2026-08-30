/**
 * Normalized agent state snapshot — parsed/normalized at the adapter boundary.
 * Self-contained: this file must never import the pi SDK.
 */

import type { AgentUsage } from "./events.js";

export type AgentPart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| {
			type: "toolCall";
			id: string;
			name: string;
			arguments: Record<string, unknown>;
	  };

export interface AgentMessage {
	role: "user" | "assistant" | "tool";
	text?: string;
	timestamp: number;
	/**
	 * Rich parts for assistant messages (text/reasoning/toolCall), reconstructed
	 * from pi's assistant content array so session restore can rebuild tool/step
	 * parts instead of flattening to text.
	 */
	parts?: AgentPart[];
	/** Tool role: the originating tool call id. */
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	/** Unified patch (edit tool) surfaced as a PatchPart on restore. */
	patch?: string;
	/** LLM usage for assistant messages (pi persists it; used to restore token totals). */
	usage?: AgentUsage;
}

export interface AgentSnapshot {
	sessionId: string;
	isStreaming: boolean;
	messages: AgentMessage[];
	error?: string;
}
