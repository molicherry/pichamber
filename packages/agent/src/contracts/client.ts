/**
 * Stable agent-client contract consumed by the upper layer.
 * Self-contained: this file must never import the pi SDK.
 */

import type { AgentEvent } from "./events.js";
import type { AgentSnapshot } from "./snapshot.js";

/** Image input shape, kept identical to pi's for pass-through. */
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface PromptOpts {
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
}

export interface AgentClient {
	/** Send a prompt; resolves when the run finishes. Throws if streaming and no streamingBehavior is set. */
	prompt(input: string, opts?: PromptOpts): Promise<void>;
	/** Queue a steering message while streaming. */
	steer(text: string): Promise<void>;
	/** Queue a follow-up message delivered once the agent stops. */
	followUp(text: string): Promise<void>;
	/** Abort the current run. */
	abort(): Promise<void>;
	/** Subscribe to normalized events; returns an unsubscribe function. */
	subscribe(listener: (event: AgentEvent) => void): () => void;
	/** Current normalized state snapshot. */
	getSnapshot(): AgentSnapshot;
	/** One-shot text generation (used for git commit/PR message generation). */
	generateText(prompt: string, systemPrompt?: string): Promise<string>;
	/** Clean up the underlying session. */
	dispose(): Promise<void>;
}
