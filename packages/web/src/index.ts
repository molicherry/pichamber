/**
 * pichamber web server entrypoint — opencode-compatible API + built UI.
 * Runs under Node (tsx).
 */

import express from "express";
import cors from "cors";
import path from "node:path";
import { SessionRegistry } from "@pichamber/agent";
import { createOpencodeRoutes } from "./opencode.js";
import { createGitRoutes } from "./gitRoutes.js";
import { createGithubRoutes } from "./githubRoutes.js";
import { createTerminalRoutes } from "./terminalRoutes.js";
import { detectPiRuntime, formatPiRuntimeWarning } from "./piRuntime.js";
import http from "node:http";

async function main(): Promise<void> {
	// The agent runs against the repo root (packages/web is only the transport).
	const cwd = path.resolve(process.cwd(), "../..");

	// Detect pi runtime deps (plugins/extensions/models.json) up front and
	// warn loudly — silent degradation is worse than a clear startup error.
	const piRuntime = detectPiRuntime();
	const piWarning = formatPiRuntimeWarning(piRuntime);
	if (piWarning) console.warn(piWarning);
	const registry = new SessionRegistry({
		cwd,
		tools: [
			"read", "grep", "find", "ls", "write", "edit", "bash", "todo", "subtask",
			"lsp_diagnostics", "lsp_navigation", "lens_diagnostics", "ast_grep_search", "ast_grep_outline", "module_report", "symbol_search",
		],
	});

	const app = express();
	// Allowed extra origins come from the environment (comma-separated), so the
	// deployment host is never hardcoded into the repository.
	const extraOrigins = (process.env.PICAMBER_ALLOWED_ORIGIN ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	app.use(
		cors({
			origin: (origin, cb) => {
				const ok =
					!origin ||
					origin.startsWith("http://localhost") ||
					origin.startsWith("http://127.0.0.1") ||
					extraOrigins.some((o) => origin.includes(o));
				cb(null, ok);
			},
		}),
	);
	app.use(express.json());

	// Optional bearer-token auth. When PICAMBER_TOKEN is set, every /api and
	// /auth request must present it (Authorization header or ?token= for SSE).
	// Without the env var the server stays open (current behaviour).
	const authToken = process.env.PICAMBER_TOKEN;
	const requireAuth = (req: import("express").Request, res: import("express").Response, next: () => void) => {
		if (!authToken) return next();
		const header = req.headers.authorization ?? "";
		const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
		const queryToken = typeof req.query.token === "string" ? req.query.token : "";
		if (bearer === authToken || queryToken === authToken) return next();
		res.status(401).json({ error: "unauthorized" });
	};
	app.use("/api", requireAuth);
	app.use("/auth", requireAuth);

	// Temporary request log to discover which opencode endpoints the UI calls.
	app.use((req, _res, next) => {
		if (req.path.startsWith("/api"))
			console.log("[req]", req.method, req.originalUrl);
		next();
	});

	// opencode-compatible API + SSE (the vendored UI talks to these).
	createOpencodeRoutes(app, registry);

	createGitRoutes(app, cwd, (prompt, systemPrompt) =>
		registry.generateText(prompt, systemPrompt),
	);

	// GitHub PR surface (gh CLI).
	createGithubRoutes(app, cwd);

	// Terminal surface (shell sessions + WebSocket I/O).
	const server = http.createServer(app);
	createTerminalRoutes(app, server);

	// Stub for openchamber-owned endpoints the UI bootstraps
	// (config/settings, fs, quota, command, mcp, github, git, notifications,
	// session-folders, permission-auto-accept, etc.). Return benign empty shapes.
	app.use("/api", (req, res) => {
		if (req.path.includes("/health")) {
			res.json({ ok: true, pi: piRuntime });
			return;
		}
		if (req.path.includes("/event") || req.path.includes("/stream")) {
			// Long-lived streams should not get a JSON stub; leave the connection idle.
			return;
		}
		if (req.method === "GET") res.json([]);
		else res.status(200).json({});
	});

	app.get("/api/health", (_req, res) => {
		res.status(200).json({ ok: true, pi: piRuntime });
	});

	// Runtime URL auth token — opencode mints one during bootstrap; the UI
	// fails to initialize (Startup failed) without it. pichamber has no real
	// auth yet, so return a stable token.
	app.post("/auth/url-token", (_req, res) => {
		res.json({ token: authToken ?? "pichamber-local", expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
	});

	// Static hosting for the built UI + SPA fallback.
	const uiDist =
		process.env.UI_DIST ?? path.resolve(process.cwd(), "../ui/dist");
	app.use(express.static(uiDist));
	app.get(/^(?!\/session|\/event|\/api).*/, (_req, res) => {
		res.sendFile(path.join(uiDist, "index.html"));
	});

	const port = Number(process.env.PORT ?? 8787);
	server.listen(port, () => {
		console.log(
			`pichamber opencode server listening on http://localhost:${port}`,
		);
	});
}

main().catch((err: unknown) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error("Failed to start server:", message);
	process.exit(1);
});
