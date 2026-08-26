import { describe, expect, it } from "bun:test";
import { broadcast, toSseFrame, type SseSink } from "./sse.js";

describe("sse", () => {
	it("serializes an event to an SSE frame", () => {
		expect(toSseFrame({ type: "text_delta", delta: "hi" })).toBe(
			'data: {"type":"text_delta","delta":"hi"}\n\n',
		);
	});

	it("broadcasts to every sink", () => {
		const written: string[] = [];
		const makeSink = (): SseSink => ({
			write: (chunk) => {
				written.push(chunk);
				return true;
			},
		});
		const a = makeSink();
		const b = makeSink();

		broadcast([a, b], { type: "agent_start" });

		expect(written).toEqual([
			'data: {"type":"agent_start"}\n\n',
			'data: {"type":"agent_start"}\n\n',
		]);
	});
});
