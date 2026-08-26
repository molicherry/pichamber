import { describe, expect, it } from "bun:test";
import type { AgentClient } from "../contracts/client.js";
import type { AgentEvent } from "../contracts/events.js";
import type { AgentSnapshot } from "../contracts/snapshot.js";
import { SessionStore } from "./SessionStore.js";

function createFakeClient(): {
  client: AgentClient;
  emit: (event: AgentEvent) => void;
} {
  let listener: ((event: AgentEvent) => void) | undefined;
  const client: AgentClient = {
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    subscribe: (l: (event: AgentEvent) => void) => {
      listener = l;
      return () => {};
    },
    getSnapshot: (): AgentSnapshot => ({
      sessionId: "s",
      isStreaming: false,
      messages: [],
    }),
    generateText: async () => "",
    dispose: async () => {},
  };
  return { client, emit: (event) => listener?.(event) };
}

describe("SessionStore", () => {
  it("builds user + assistant messages with text parts", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    store.pushUser("hello");
    emit({ type: "agent_start" });
    emit({ type: "text_delta", delta: "Hi " });
    emit({ type: "text_delta", delta: "there" });
    emit({ type: "agent_end" });

    const messages = store.getMessages();
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    const textParts = store.getParts(messages[1]?.id).filter((p) => p.type === "text");
    expect(textParts).toHaveLength(1);
    if (textParts[0] && textParts[0].type === "text") {
      expect(textParts[0].text).toBe("Hi there");
    }
  });

  it("aggregates reasoning deltas into a ReasoningPart", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    emit({ type: "agent_start" });
    emit({ type: "thinking_delta", delta: "Let me " });
    emit({ type: "thinking_delta", delta: "think" });

    const reasoning = store.getParts().find((p) => p.type === "reasoning");
    if (reasoning && reasoning.type === "reasoning") {
      expect(reasoning.text).toBe("Let me think");
    }
  });

  it("records tool input/output and state transitions", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    emit({ type: "agent_start" });
    emit({ type: "tool_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    emit({ type: "tool_end", toolCallId: "c1", toolName: "bash", output: "file1.txt", details: {}, isError: false });

    const tool = store.getParts().find((p) => p.type === "tool");
    if (tool && tool.type === "tool" && tool.state.status === "completed") {
      expect(tool.state.input).toEqual({ command: "ls" });
      expect(tool.state.output).toBe("file1.txt");
    }
  });

  it("emits a PatchPart when a tool reports a unified patch", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    emit({ type: "agent_start" });
    emit({ type: "tool_start", toolCallId: "c1", toolName: "edit", args: {} });
    emit({
      type: "tool_end",
      toolCallId: "c1",
      toolName: "edit",
      output: "",
      details: { patch: "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n" },
      isError: false,
    });

    const patch = store.getParts().find((p) => p.type === "patch");
    expect(patch?.type).toBe("patch");
    if (patch && patch.type === "patch") {
      expect(patch.files).toEqual(["x.txt"]);
      expect(patch.hash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it("updates running tool title from tool_update partials", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    emit({ type: "agent_start" });
    emit({ type: "tool_start", toolCallId: "c1", toolName: "bash", args: {} });
    emit({ type: "tool_update", toolCallId: "c1", toolName: "bash", partial: "line 1\n" });
    emit({ type: "tool_update", toolCallId: "c1", toolName: "bash", partial: "line 2\n" });

    const tool = store.getParts().find((p) => p.type === "tool");
    if (tool && tool.type === "tool" && tool.state.status === "running") {
      expect(tool.state.title).toBe("line 2\n");
    }
  });

  it("emits StepStart/StepFinish parts around turns and accumulates tokens", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({ type: "text_delta", delta: "x" });
    emit({ type: "turn_end", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, reasoning: 30, cost: 0.01 } });
    emit({ type: "agent_end" });

    const stepStart = store.getParts().find((p) => p.type === "step-start");
    const stepFinish = store.getParts().find((p) => p.type === "step-finish");
    expect(stepStart?.type).toBe("step-start");
    expect(stepFinish?.type).toBe("step-finish");

    const tokens = store.getSession().tokens;
    expect(tokens?.input).toBe(100);
    expect(tokens?.output).toBe(50);
    expect(tokens?.reasoning).toBe(30);
  });

  it("marks the assistant message complete on agent_end", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    emit({ type: "agent_start" });
    emit({ type: "text_delta", delta: "x" });
    emit({ type: "agent_end" });

    const assistant = store.getMessages().find((m) => m.role === "assistant");
    if (assistant && assistant.role === "assistant") {
      expect(assistant.finish).toBe("completed");
    }
  });

  it("attaches a status error to the assistant message", () => {
    const { client, emit } = createFakeClient();
    const store = new SessionStore(client, { title: "t", directory: "/d" });
    store.start();

    emit({ type: "agent_start" });
    emit({ type: "status", status: "error", error: "boom" });

    const assistant = store.getMessages().find((m) => m.role === "assistant");
    if (assistant && assistant.role === "assistant") {
      expect(assistant.error?.name).toBe("UnknownError");
    }
  });
});
