/**
 * subtask tool — spawn an independent read-only subagent session and return
 * its final text. pi has no built-in subagent, so this is a custom tool.
 * Subagents run with read-only tools only (no subtask), preventing recursion.
 */

import { Object, String as TString, Optional } from "typebox";
import type { Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAgentClient } from "./pi/PiAgentClient.js";
import { SessionStore } from "./opencode/SessionStore.js";

const subtaskSchema = Object({
	prompt: TString(),
	description: Optional(TString()),
});

type SubtaskParams = Static<typeof subtaskSchema>;

export interface SubtaskOptions {
	cwd: string;
}

export function createSubtaskTool(
	opts: SubtaskOptions,
): ToolDefinition<typeof subtaskSchema> {
	return {
		name: "subtask",
		label: "Subtask",
		description:
			"Spawn a subagent to run an independent task and report back. Use for research or isolated work you want a fresh context for.",
		promptSnippet: "Spawn a read-only subagent for an independent task",
		parameters: subtaskSchema,
		async execute(_toolCallId, params: SubtaskParams, signal?: AbortSignal) {
			const prompt = (params.prompt ?? "").trim();
			if (!prompt) {
				throw new Error("prompt is required for subtask");
			}
			const text = await runSubagent(opts.cwd, prompt, signal);
			return {
				content: [{ type: "text", text }],
				details: { description: params.description ?? prompt },
			};
		},
	};
}

async function runSubagent(
	cwd: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<string> {
	const client = await createAgentClient({
		cwd,
		tools: ["read", "grep", "find", "ls"],
		sessionManager: "in-memory",
	});

	const store = new SessionStore(client, {
		title: "subagent",
		directory: cwd,
	});

	// Forward an outer abort to the subagent.
	const onAbort = (): void => {
		void client.abort();
	};
	if (signal) {
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort);
		}
	}

	try {
		store.start();
		store.pushUser(prompt);
		await client.prompt(prompt);
	} catch (error) {
		// Throw so pi marks the tool errored (content-only errors are treated as success).
		throw new Error(
			`Subagent error: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		store.stop();
		await client.dispose();
	}

	const text = store
		.getMessages()
		.filter((m) => m.role === "assistant")
		.flatMap((m) => store.getParts(m.id))
		.filter((p) => p.type === "text")
		.map((p) => (p as { text?: string }).text ?? "")
		.join("\n")
		.trim()
		.slice(0, 200_000);

	return text || "(subagent produced no text)";
}
