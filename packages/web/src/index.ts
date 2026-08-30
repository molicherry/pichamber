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
import {
	checkCredentials,
	isAuthEnabled,
	isValidSession,
	mintSession,
	mintUrlToken,
	parseCookies,
	readAuthConfig,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	URL_TOKEN_TTL_MS,
} from "./auth.js";
import http from "node:http";

async function main(): Promise<void> {
	// The agent works against PICAMBER_WORKSPACE when set (the mounted
	// workspace in Docker); otherwise fall back to the repo root (local dev).
	const cwd = process.env.PICAMBER_WORKSPACE
		? path.resolve(process.env.PICAMBER_WORKSPACE)
		: path.resolve(process.cwd(), "../..");

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

	// Auth: password gate (PICAMBER_PASSWORD) + optional static bearer
	// (PICAMBER_TOKEN). Neither set → the server stays open. The /auth/* entry
	// points (/auth/session, /auth/url-token) are registered explicitly below and
	// are NOT behind requireAuth — they are how a client authenticates in the
	// first place (a login request obviously cannot carry the credential yet).
	const auth = readAuthConfig();
	const extractBearer = (req: import("express").Request): string => {
		const header = req.headers.authorization ?? "";
		return header.startsWith("Bearer ") ? header.slice(7) : "";
	};
	const extractQueryToken = (req: import("express").Request): string =>
		typeof req.query.token === "string" ? req.query.token : "";
	const isAuthenticated = (req: import("express").Request): boolean =>
		checkCredentials(
			{
				bearer: extractBearer(req),
				query: extractQueryToken(req),
				cookieHeader: req.headers.cookie ?? "",
			},
			auth,
		);

	const requireAuth = (req: import("express").Request, res: import("express").Response, next: () => void) => {
		if (!isAuthEnabled(auth) || isAuthenticated(req)) return next();
		res.status(401).json({ error: "unauthorized" });
	};
	app.use("/api", requireAuth);


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


	// --- auth entry points (not behind requireAuth) ---

	// Status check for the vendored password gate. Without a configured
	// password the gate is a no-op (always authenticated).
	app.get("/auth/session", (req, res) => {
		if (!auth.password) {
			res.json({ authenticated: true });
			return;
		}
		if (isAuthenticated(req)) {
			res.json({ authenticated: true });
			return;
		}
		res.status(401).json({ error: "unauthorized" });
	});

	// Password verify → mint a session cookie. A simple per-IP rate limit blunts
	// brute-force guessing.
	const RATE_LIMIT_MAX = 5;
	const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
	const failedAttempts = new Map<string, { count: number; resetAt: number }>();
	app.post("/auth/session", (req, res) => {
		if (!auth.password) {
			res.json({ authenticated: true });
			return;
		}
		const ip = req.ip ?? "unknown";
		const now = Date.now();
		const existing = failedAttempts.get(ip);
		if (existing && existing.resetAt <= now) failedAttempts.delete(ip);
		const current = failedAttempts.get(ip);
		if (current && current.count >= RATE_LIMIT_MAX) {
			res.status(429).json({ retryAfter: Math.ceil((current.resetAt - now) / 1000) });
			return;
		}
		const password = typeof req.body?.password === "string" ? req.body.password : "";
		if (password !== auth.password) {
			const e = current ?? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
			e.count += 1;
			failedAttempts.set(ip, e);
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		failedAttempts.delete(ip);
		const sessionId = mintSession();
		const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
		res.setHeader("Set-Cookie", [
			`${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`,
		]);
		res.json({ authenticated: true });
	});

	// Runtime URL auth token — used as `?token=` on SSE/WS URLs (which cannot
	// carry cookies). In password mode only an authenticated session may mint
	// one; otherwise return the static token (or a benign placeholder in open
	// mode).
	app.post("/auth/url-token", (req, res) => {
		if (auth.password && !isValidSession(parseCookies(req.headers.cookie ?? "")[SESSION_COOKIE])) {
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		const token = auth.password ? mintUrlToken() : auth.token || "pichamber-local";
		res.json({ token, expiresAt: Date.now() + URL_TOKEN_TTL_MS });
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
