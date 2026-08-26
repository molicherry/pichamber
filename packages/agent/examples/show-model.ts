import { createAgentClient, SessionStore } from "../src/index.js";

async function main() {
  const client = await createAgentClient({ cwd: "/tmp/smoke-workspace", tools: ["read", "write", "ls"] });
  const store = new SessionStore(client, { title: "demo", directory: "/tmp/smoke-workspace" });
  store.start();
  store.pushUser("Create a file hello.txt with the text 'hi'.");
  await client.prompt("Create a file hello.txt with the text 'hi'.");

  console.log("=== Parts ===");
  for (const p of store.getParts()) {
    if (p.type === "text") console.log(`  text: ${p.text.slice(0, 50)}`);
    else if (p.type === "reasoning") console.log(`  reasoning (${p.text.length}ch)`);
    else if (p.type === "tool" && p.state.status === "completed") console.log(`  tool ${p.tool}: input=${JSON.stringify(p.state.input).slice(0,60)} output=${p.state.output.slice(0,40)}`);
    else if (p.type === "tool") console.log(`  tool ${p.tool} [${p.state.status}]`);
    else if (p.type === "patch") console.log(`  patch: files=${JSON.stringify(p.files)}`);
    else if (p.type === "step-start") console.log(`  step-start`);
    else if (p.type === "step-finish") console.log(`  step-finish tokens=${JSON.stringify(p.tokens)}`);
    else console.log(`  ${p.type}`);
  }
  console.log("=== Session tokens ===");
  console.log(" ", JSON.stringify(store.getSession().tokens));
  store.stop();
  await client.dispose();
}
main().catch((e) => { console.error(e); process.exit(1); });
