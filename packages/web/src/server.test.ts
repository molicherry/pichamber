import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPichamberServer, type PichamberServerRuntime } from "./index.js";

const original = {
	HOME: process.env.HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PICAMBER_PASSWORD: process.env.PICAMBER_PASSWORD,
	PICAMBER_TOKEN: process.env.PICAMBER_TOKEN,
};
const runtimes: PichamberServerRuntime[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.stop();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	for (const [key, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
		else process.env[key as keyof NodeJS.ProcessEnv] = value;
	}
});

async function server(auth: { password?: string; token?: string } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-web-test-")); roots.push(root);
	const home = path.join(root, "home"); const workspace = path.join(home, "workspace"); const ui = path.join(root, "ui");
	fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(ui, { recursive: true });
	fs.writeFileSync(path.join(ui, "index.html"), "<!doctype html><title>pichamber test</title>");
	process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
	process.env.PICAMBER_PASSWORD = auth.password ?? ""; process.env.PICAMBER_TOKEN = auth.token ?? "";
	const runtime = await createPichamberServer({
		cwd: workspace,
		uiDist: ui,
		port: 0,
		host: "127.0.0.1",
		terminal: false,
	});
	runtimes.push(runtime);
	const started = await runtime.start(0);
	return { root, home, workspace, url: started.url };
}

describe("createPichamberServer", () => {
	it("preserves CLI route behavior with isolated open-mode HTTP, SSE, filesystem and explicit unknown responses", async () => {
		const state = await server();
		const health = await fetch(`${state.url}/api/opencode/health`);
		expect(health.status).toBe(200); expect(await health.json()).toEqual({ healthy: true });
		const auth = await fetch(`${state.url}/auth/session`);
		expect(await auth.json()).toEqual({ authenticated: true });
		const spa = await fetch(`${state.url}/some/client/route`);
		expect(await spa.text()).toContain("pichamber test");
		const unknown = await fetch(`${state.url}/api/not-a-real-operation`);
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: "unsupported endpoint", method: "GET", path: "/not-a-real-operation" });

		const safe = path.join(state.home, "safe.txt"); fs.writeFileSync(safe, "safe-content");
		const read = await fetch(`${state.url}/api/fs/read?path=${encodeURIComponent(safe)}`);
		expect(read.status).toBe(200); expect(await read.text()).toBe("safe-content");
		const sensitive = path.join(state.home, ".env"); fs.writeFileSync(sensitive, "SECRET=never-read");
		expect((await fetch(`${state.url}/api/fs/read?path=${encodeURIComponent(sensitive)}`)).status).toBe(403);

		const controller = new AbortController();
		const stream = await fetch(`${state.url}/api/event`, { signal: controller.signal });
		expect(stream.headers.get("content-type")).toContain("text/event-stream");
		const chunk = await stream.body?.getReader().read();
		expect(new TextDecoder().decode(chunk?.value)).toContain(": connected");
		controller.abort();
	});

	it("enforces password, cookie, URL-token, bearer, invalid credential and rate-limit modes", async () => {
		const state = await server({ password: "release-password", token: "static-token" });
		expect((await fetch(`${state.url}/api/opencode/health`)).status).toBe(401);
		expect((await fetch(`${state.url}/api/opencode/health`, { headers: { authorization: "Bearer static-token" } })).status).toBe(200);
		for (let i = 0; i < 5; i++) {
			const wrong = await fetch(`${state.url}/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
			expect(wrong.status).toBe(401);
		}
		expect((await fetch(`${state.url}/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) })).status).toBe(429);

		const second = await server({ password: "release-password" });
		const login = await fetch(`${second.url}/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "release-password" }) });
		expect(login.status).toBe(200);
		const cookie = login.headers.get("set-cookie"); expect(cookie).toContain("pichamber_session=");
		expect((await fetch(`${second.url}/api/opencode/health`, { headers: { cookie: cookie ?? "" } })).status).toBe(200);
		const tokenResponse = await fetch(`${second.url}/auth/url-token`, { method: "POST", headers: { cookie: cookie ?? "" } });
		expect(tokenResponse.status).toBe(200);
		const tokenPayload: unknown = await tokenResponse.json();
		if (!tokenPayload || typeof tokenPayload !== "object" || !("token" in tokenPayload) || typeof tokenPayload.token !== "string") {
			throw new Error("URL token response did not contain a token");
		}
		expect((await fetch(`${second.url}/api/opencode/health?token=${encodeURIComponent(tokenPayload.token)}`)).status).toBe(200);
	});
});
