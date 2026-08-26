/**
 * SSE transport helpers — pure and testable, no express dependency.
 */

import type { AgentEvent } from "@pichamber/agent";

export interface SseSink {
	write(chunk: string): boolean;
}

/** Serialize one agent event as an SSE frame. */
export function toSseFrame(event: AgentEvent): string {
	return `data: ${JSON.stringify(event)}\n\n`;
}

/** Broadcast one agent event to every connected SSE client. */
export function broadcast(clients: Iterable<SseSink>, event: AgentEvent): void {
	const frame = toSseFrame(event);
	for (const client of clients) {
		client.write(frame);
	}
}
