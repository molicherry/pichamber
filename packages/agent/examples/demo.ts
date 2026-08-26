/**
 * End-to-end smoke test: create a client, prompt, stream mapped events.
 * Run with: node packages/agent/examples/demo.ts [prompt]
 * Requires a configured pi API key; fails cleanly otherwise.
 */

import { createAgentClient } from "../src/index.js";

async function main(): Promise<void> {
	const client = await createAgentClient({
		cwd: process.cwd(),
		tools: ["read", "grep", "find", "ls"],
	});

	client.subscribe((event) => {
		switch (event.type) {
			case "text_delta":
				process.stdout.write(event.delta);
				break;
			case "thinking_delta":
				process.stdout.write(`\n[thinking] ${event.delta}`);
				break;
			case "tool_start":
				console.log(`\n[tool] ${event.toolName}`);
				break;
			case "tool_end":
				console.log(
					`\n[tool done] ${event.toolName}${event.isError ? " (error)" : ""}`,
				);
				break;
			case "agent_start":
				console.log("\n[agent started]");
				break;
			case "agent_end":
				console.log("\n[agent ended]");
				break;
			default:
				break;
		}
	});

	const prompt = process.argv[2] ?? "Say hello in one short sentence.";
	await client.prompt(prompt);
	await client.dispose();
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`\nDemo failed: ${message}`);
	process.exit(1);
});
