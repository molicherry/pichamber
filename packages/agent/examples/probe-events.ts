/**
 * Probe: dump raw pi event shapes to confirm the mapping assumptions.
 * Run: tsx examples/probe-events.ts
 */

import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

async function main(): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "ls", "grep"],
  });

  session.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      const r = event.result as Record<string, unknown>;
      console.log("=== tool_execution_end ===");
      console.log("  toolName:", event.toolName, "isError:", event.isError);
      console.log("  result keys:", Object.keys(r ?? {}));
      console.log("  result.details keys:", Object.keys((r?.details as object) ?? {}));
    }
    if (event.type === "turn_end") {
      const m = event.message as Record<string, unknown>;
      console.log("=== turn_end ===");
      console.log("  message.usage:", JSON.stringify(m?.usage));
      const tr = event.toolResults?.[0] as Record<string, unknown> | undefined;
      console.log("  toolResults[0] keys:", Object.keys(tr ?? {}));
      console.log("  toolResults[0].details:", JSON.stringify(tr?.details)?.slice(0, 300));
    }
  });

  await session.prompt("List the files in the current directory.");
  await session.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
