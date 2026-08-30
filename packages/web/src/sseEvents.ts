/**
 * Pure opencode SSE event mapping — no express/transport/pi-SDK runtime imports.
 * Maps a SessionStore mutation to the opencode SSE event shape the vendored UI's
 * reducer consumes. Kept dependency-light so the mapping is unit-testable.
 */

import type { Session, StoreChange } from "@pichamber/agent";

export interface OpencodeEvent {
	id: string;
	type: string;
	properties: Record<string, unknown>;
}

let eventSeq = 0;
export function nextEventId(): string {
	eventSeq += 1;
	return `evt-${eventSeq}`;
}

/** Map a SessionStore mutation to an opencode SSE event (or null if unmapped). */
export function toOpencodeEvent(
	change: StoreChange,
	session: Session,
): OpencodeEvent | null {
	switch (change.type) {
		case "session_updated":
			return {
				id: nextEventId(),
				type: "session.updated",
				properties: { sessionID: session.id, info: session },
			};
		case "message_added":
		case "message_updated":
			return {
				id: nextEventId(),
				type: "message.updated",
				properties: { sessionID: session.id, info: change.message },
			};
		case "part_added":
		case "part_updated":
			return {
				id: nextEventId(),
				type: "message.part.updated",
				properties: {
					sessionID: session.id,
					part: change.part,
					time: Date.now(),
				},
			};
		case "part_delta":
			return {
				id: nextEventId(),
				type: "message.part.delta",
				properties: {
					sessionID: session.id,
					messageID: change.messageID,
					partID: change.partID,
					field: change.field,
					delta: change.delta,
				},
			};
		case "status":
			if (change.status === "busy") {
				return {
					id: nextEventId(),
					type: "session.status",
					properties: { sessionID: session.id, status: { type: "busy" } },
				};
			}
			if (change.status === "idle") {
				return {
					id: nextEventId(),
					type: "session.idle",
					properties: { sessionID: session.id },
				};
			}
			return {
				id: nextEventId(),
				type: "session.error",
				properties: { sessionID: session.id },
			};
		case "todo_updated":
			return {
				id: nextEventId(),
				type: "todo.updated",
				properties: { sessionID: session.id, todos: change.todos },
			};
	}
}
