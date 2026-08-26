import { describe, expect, it } from "bun:test";
import { mapEvent } from "./mapEvent.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "../contracts/events.js";

describe("mapEvent", () => {
  it("maps message_update text_delta", () => {
    const event = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({ type: "text_delta", delta: "hello" });
  });

  it("maps message_update thinking_delta", () => {
    const event = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({ type: "thinking_delta", delta: "hmm" });
  });

  it("drops unmodeled assistantMessageEvent variants", () => {
    const event = {
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_start" },
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toBeNull();
  });

  it("maps tool_execution_start with args", () => {
    const event = {
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({
      type: "tool_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
    });
  });

  it("maps tool_execution_end with output + details", () => {
    const event = {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { diff: "+++ b/a.txt" },
      },
      isError: false,
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({
      type: "tool_end",
      toolCallId: "c1",
      toolName: "edit",
      output: "ok",
      details: { diff: "+++ b/a.txt" },
      isError: false,
    });
  });

  it("maps tool_execution_update to tool_update with partial text", () => {
    const event = {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      partialResult: { content: [{ type: "text", text: "line 1" }] },
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({
      type: "tool_update",
      toolCallId: "c1",
      toolName: "bash",
      partial: "line 1",
    });
  });

  it("maps bash_execution_update to bash_output", () => {
    const event = {
      type: "bash_execution_update",
      delta: "chunk",
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({ type: "bash_output", delta: "chunk" });
  });

  it("maps turn_end with usage", () => {
    const event = {
      type: "turn_end",
      message: { usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, reasoning: 30, cost: { total: 0.01 } } },
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({
      type: "turn_end",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, reasoning: 30, cost: 0.01 },
    });
  });

  it("maps lifecycle events", () => {
    const cases: Array<[AgentSessionEvent, AgentEvent["type"]]> = [
      [{ type: "agent_start" } as AgentSessionEvent, "agent_start"],
      [{ type: "agent_end" } as AgentSessionEvent, "agent_end"],
      [{ type: "turn_start" } as AgentSessionEvent, "turn_start"],
      [{ type: "message_start" } as AgentSessionEvent, "message_start"],
      [{ type: "message_end" } as AgentSessionEvent, "message_end"],
    ];
    for (const [event, type] of cases) {
      expect(mapEvent(event)?.type).toBe(type);
    }
  });

  it("maps queue_update to first steering/followUp", () => {
    const event = {
      type: "queue_update",
      steering: ["do X"],
      followUp: ["then Y"],
    } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toEqual({
      type: "queue_update",
      steering: "do X",
      followUp: "then Y",
    });
  });

  it("returns null for unmodeled events", () => {
    const event = { type: "compaction_start" } as unknown as AgentSessionEvent;
    expect(mapEvent(event)).toBeNull();
  });
});
