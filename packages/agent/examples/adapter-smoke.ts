/**
 * Live smoke: wire a real AgentClient to SessionStore and print the
 * opencode-shaped model. Run: tsx examples/adapter-smoke.ts
 */

import { createAgentClient, SessionStore } from "../src/index.js";

async function main(): Promise<void> {
	const client = await createAgentClient({
		cwd: process.cwd(),
		tools: ["read"],
	});
	const store = new SessionStore(client, {
		title: "adapter smoke",
		directory: process.cwd(),
	});
	store.start();
	store.pushUser("Reply with exactly one word.");

	await client.prompt("Reply with exactly one word.");

	const parts = store.getParts().map((p) => {
		if (p.type === "text") return `text:"${p.text}"`;
		if (p.type === "reasoning") return `reasoning:${p.text.length}ch`;
		if (p.type === "tool") return `tool:${p.tool}(${p.state.status})`;
		return p.type;
	});

	console.log("session.title:", store.getSession().title);
	console.log(
		"messages:",
		store
			.getMessages()
			.map((m) => m.role)
			.join(", "),
	);
	console.log("parts:", parts.join(" | "));

	store.stop();
	await client.dispose();
}

main().catch((err: unknown) => {
	console.error("smoke failed:", err);
	process.exit(1);
});
