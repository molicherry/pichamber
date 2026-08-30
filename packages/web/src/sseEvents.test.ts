import { describe, expect, it } from "bun:test";
import { nextEventId, toOpencodeEvent } from "./sseEvents.js";
import type { Session } from "@pichamber/agent";

const session: Session = {
	id: "session-1",
	slug: "session-1",
	projectID: "default",
	directory: "/app",
	title: "test",
	version: "0",
	time: { created: 1, updated: 1 },
};

describe("toOpencodeEvent", () => {
	it("maps session_updated to session.updated", () => {
		const ev = toOpencodeEvent({ type: "session_updated" }, session);
		expect(ev?.type).toBe("session.updated");
		expect(ev?.properties).toMatchObject({
			sessionID: "session-1",
			info: session,
		});
	});

	it("maps status busy/idle/error", () => {
		expect(
			toOpencodeEvent({ type: "status", status: "busy" }, session)?.type,
		).toBe("session.status");
		expect(
			toOpencodeEvent({ type: "status", status: "idle" }, session)?.type,
		).toBe("session.idle");
		expect(
			toOpencodeEvent({ type: "status", status: "error" }, session)?.type,
		).toBe("session.error");
	});

	it("maps part_delta to message.part.delta", () => {
		const ev = toOpencodeEvent(
			{
				type: "part_delta",
				messageID: "m1",
				partID: "p1",
				field: "text",
				delta: "hi",
			},
			session,
		);
		expect(ev?.type).toBe("message.part.delta");
		expect(ev?.properties).toEqual({
			sessionID: "session-1",
			messageID: "m1",
			partID: "p1",
			field: "text",
			delta: "hi",
		});
	});

	it("maps todo_updated to todo.updated", () => {
		const todos = [{ content: "x", status: "pending", priority: "medium" }];
		const ev = toOpencodeEvent({ type: "todo_updated", todos }, session);
		expect(ev?.type).toBe("todo.updated");
		expect(ev?.properties).toMatchObject({ sessionID: "session-1", todos });
	});

	it("allocates unique event ids", () => {
		expect(nextEventId()).not.toBe(nextEventId());
	});
});
