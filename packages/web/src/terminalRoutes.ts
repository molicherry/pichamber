/**
 * opencode-compatible terminal surface with a runtime-selected PTY backend.
 * Under Node the backend is node-pty (behavior unchanged); under Bun >= 1.4.0
 * it is Bun.Terminal/Bun.spawn, because node-pty's spawn under Bun exits with
 * exitCode 0 + SIGHUP before the authenticated WebSocket can attach. Both
 * backends multiplex I/O over the `/api/terminal/ws` WebSocket using
 * opencode's tagged-JSON protocol and support resize and TTY I/O.
 */

import * as pty from "node-pty";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { checkCredentials, readAuthConfig } from "./auth.js";

const TAG = 1;

interface WsMessage {
	t: string;
	s?: string;
	q?: number;
	d?: string;
	[key: string]: unknown;
}

type TerminalBackendName = "node-pty" | "bun-terminal";

interface TerminalExit {
	exitCode: number | null;
	signal: string | null;
}

interface TerminalProcess {
	readonly backend: TerminalBackendName;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
	onData(callback: (data: string) => void): void;
	onExit(callback: (exit: TerminalExit) => void): void;
}

interface TerminalSpawnOptions {
	shell: string;
	args: string[];
	cols: number;
	rows: number;
	cwd: string;
	env: Record<string, string | undefined>;
}

interface TerminalBackend {
	spawn(options: TerminalSpawnOptions): TerminalProcess;
}

interface TerminalSession {
	id: string;
	cwd: string;
	proc: TerminalProcess;
	cols: number;
	rows: number;
	buffer: string;
	seq: number;
	status: "running" | "exited";
	exitCode?: number;
	signal?: string | null;
	createdAt: number;
	attached: Set<WebSocket>;
}

function encode(message: WsMessage): Buffer {
	const payload = Buffer.from(JSON.stringify(message), "utf8");
	const frame = Buffer.alloc(payload.length + 1);
	frame[0] = TAG;
	payload.copy(frame, 1);
	return frame;
}

function decode(data: Buffer): WsMessage | null {
	let bytes = data;
	if (bytes.length > 0 && bytes[0] === TAG) bytes = bytes.subarray(1);
	try {
		return JSON.parse(bytes.toString("utf8")) as WsMessage;
	} catch {
		return null;
	}
}

function resolveShell(shell: string | undefined): string {
	switch (shell) {
		case "bash":
			return "bash";
		case "zsh":
			return "zsh";
		case "fish":
			return "fish";
		case "sh":
			return "sh";
		case "auto":
		case undefined:
			return process.env.SHELL || "bash";
		default:
			return "bash";
	}
}

const nodePtyBackend: TerminalBackend = {
	spawn({ shell, args, cols, rows, cwd, env }) {
		const proc = pty.spawn(shell, args, {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
			env,
		});
		return {
			backend: "node-pty",
			write: (data) => proc.write(data),
			resize: (cols, rows) => proc.resize(cols, rows),
			kill: () => proc.kill(),
			onData: (callback) => proc.onData(callback),
			onExit: (callback) =>
				proc.onExit(({ exitCode, signal }) =>
					callback({
						exitCode,
						// node-pty reports the terminating signal as a numeric signal
						// number (1 = SIGHUP); normalize to the protocol's string field.
						signal: signal !== undefined ? String(signal) : null,
					}),
				),
		};
	},
};

/**
 * Minimal structural contract for the Bun runtime capability we use. Defined
 * here (not imported from bun-types) so the Node TypeScript compilation path
 * has no dependency on Bun's ambient types; the real `Bun` global is probed at
 * runtime and checked against this shape before any terminal is spawned.
 */
interface BunTerminalLike {
	write(data: string | Uint8Array): number;
	resize(cols: number, rows: number): void;
	close(): void;
}

interface BunSubprocessLike {
	kill(signal?: string): void;
}

interface BunGlobalLike {
	Terminal?: new (options: {
		cols?: number;
		rows?: number;
		name?: string;
		data?: (terminal: unknown, data: Uint8Array) => void;
	}) => BunTerminalLike;
	spawn?: (
		command: string[],
		options: {
			cwd?: string;
			env?: Record<string, string | undefined>;
			terminal?: unknown;
			onExit?: (
				subprocess: unknown,
				exitCode: number | null,
				signalCode: string | number | null,
			) => void;
		},
	) => BunSubprocessLike;
}

function createBunTerminalBackend(bun: BunGlobalLike): TerminalBackend {
	const Terminal = bun.Terminal;
	const spawn = bun.spawn;
	if (typeof Terminal !== "function" || typeof spawn !== "function") {
		throw new Error(
			"Running under Bun but Bun.Terminal/Bun.spawn is unavailable. " +
				"The native terminal backend requires Bun >= 1.4.0 (Bun.Terminal + Bun.spawn); " +
				"upgrade Bun or run the server under Node 22+ to use the node-pty backend.",
		);
	}
	return {
		spawn({ shell, args, cols, rows, cwd, env }) {
			// Bun.Terminal/Bun.spawn deliver data/exit on a later tick, but the
			// process handle's callbacks are wired only after spawn returns. Buffer
			// any early output/exit so no bytes or the exit event are lost.
			let onDataListener: ((data: string) => void) | null = null;
			let onExitListener: ((exit: TerminalExit) => void) | null = null;
			const pendingData: string[] = [];
			let pendingExit: TerminalExit | null = null;
			let exited = false;
			const decoder = new TextDecoder();

			const terminal = new Terminal({
				cols,
				rows,
				name: "xterm-256color",
				data: (_terminal, data) => {
					const text = decoder.decode(data, { stream: true });
					if (onDataListener) onDataListener(text);
					else pendingData.push(text);
				},
			});

			const proc = spawn([shell, ...args], {
				cwd,
				env,
				terminal,
				onExit: (_subprocess, exitCode, signalCode) => {
					exited = true;
					const exit: TerminalExit = {
						exitCode,
						// Bun reports a signal name (e.g. "SIGHUP"); tolerate the
						// numeric form in case an older Bun reports one.
						signal:
							signalCode === null || signalCode === undefined
								? null
								: String(signalCode),
					};
					if (onExitListener) onExitListener(exit);
					else pendingExit = exit;
				},
			});

			return {
				backend: "bun-terminal",
				write: (data) => {
					try {
						if (!exited) terminal.write(data);
					} catch {
						/* terminal may already be closed */
					}
				},
				resize: (nextCols, nextRows) => {
					try {
						if (!exited) terminal.resize(nextCols, nextRows);
					} catch {
						/* terminal may already be closed */
					}
				},
				kill: () => {
					// SIGHUP matches node-pty's default hang-up semantics for a PTY
					// session; closing the master also SIGHUPs the session leader.
					try {
						proc.kill("SIGHUP");
					} catch {
						/* already gone */
					}
					try {
						terminal.close();
					} catch {
						/* already closed */
					}
				},
				onData: (callback) => {
					onDataListener = callback;
					for (const data of pendingData.splice(0)) callback(data);
				},
				onExit: (callback) => {
					onExitListener = callback;
					if (pendingExit) callback(pendingExit);
				},
			};
		},
	};
}

function isBunRuntime(): boolean {
	const global = globalThis as { Bun?: unknown };
	return typeof global.Bun === "object" && global.Bun !== null;
}

function resolveTerminalBackend(): TerminalBackend {
	if (!isBunRuntime()) return nodePtyBackend;
	const bun = (globalThis as { Bun?: unknown }).Bun as BunGlobalLike;
	return createBunTerminalBackend(bun);
}

class TerminalManager {
	private readonly sessions = new Map<string, TerminalSession>();
	private readonly wss: WebSocketServer;
	private disposed = false;

	constructor(
		server: Server,
		private readonly backend: TerminalBackend,
	) {
		const auth = readAuthConfig();
		this.wss = new WebSocketServer({
			server,
			path: "/api/terminal/ws",
			verifyClient: (info: {
				origin: string;
				req: import("node:http").IncomingMessage;
			}) => {
				// Reject cross-origin WebSocket upgrades (CSWSH mitigation).
				// Extra origins come from the environment, never hardcoded.
				const origin = info.origin || "";
				const extraOrigins = (process.env.PICAMBER_ALLOWED_ORIGIN ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				const originOk =
					!origin ||
					origin.startsWith("http://localhost") ||
					origin.startsWith("http://127.0.0.1") ||
					extraOrigins.some((o) => origin.includes(o));
				if (!originOk) return false;
				// The terminal WS upgrade bypasses the /api bearer-auth middleware,
				// so it must enforce the same auth itself: static token, minted url
				// token, or a password session cookie.
				const url = new URL(info.req.url ?? "/", "http://localhost");
				const queryToken = url.searchParams.get("token") ?? "";
				const header = info.req.headers.authorization ?? "";
				const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
				return checkCredentials(
					{
						bearer,
						query: queryToken,
						cookieHeader: info.req.headers.cookie ?? "",
					},
					auth,
				);
			},
		});
		this.wss.on("connection", (ws) => this.handleConnection(ws));
	}

	/**
	 * Dispose every live terminal session and WebSocket client. This is the
	 * server-owned teardown for the terminal surface: it kills PTY processes
	 * (so they cannot keep the runtime process alive) and force-closes the
	 * upgrade clients and the WebSocketServer before http.Server.close().
	 * Idempotent — safe to call more than once.
	 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const id of [...this.sessions.keys()]) this.close(id);
		for (const client of this.wss.clients) {
			try {
				client.terminate();
			} catch {
				/* already closed */
			}
		}
		try {
			this.wss.close();
		} catch {
			/* already closed */
		}
	}

	create(cwd: string, options: Record<string, unknown>): TerminalSession {
		const id =
			typeof options.sessionId === "string" && options.sessionId
				? options.sessionId
				: randomUUID();
		const cols = typeof options.cols === "number" ? options.cols : 80;
		const rows = typeof options.rows === "number" ? options.rows : 24;
		const shell = resolveShell(
			typeof options.shell === "string" ? options.shell : undefined,
		);
		const args: string[] = [];
		if (options.loginShell === true) {
			args.push("-l");
		}
		const proc = this.backend.spawn({
			shell,
			args,
			cols,
			rows,
			cwd,
			env: { ...process.env, TERM: "xterm-256color" },
		});
		const session: TerminalSession = {
			id,
			cwd,
			proc,
			cols,
			rows,
			buffer: "",
			seq: 0,
			status: "running",
			createdAt: Date.now(),
			attached: new Set(),
		};
		proc.onData((data: string) => this.onOutput(session, data));
		proc.onExit(({ exitCode, signal }) =>
			this.onExit(session, exitCode, signal),
		);
		this.sessions.set(id, session);
		return session;
	}

	list(cwd: string): Array<{
		sessionId: string;
		cwd: string;
		status: string;
		createdAt: number | null;
	}> {
		const out: Array<{
			sessionId: string;
			cwd: string;
			status: string;
			createdAt: number | null;
		}> = [];
		for (const s of this.sessions.values()) {
			if (cwd && s.cwd !== cwd) continue;
			out.push({
				sessionId: s.id,
				cwd: s.cwd,
				status: s.status,
				createdAt: s.createdAt,
			});
		}
		return out;
	}

	get(id: string): TerminalSession | undefined {
		return this.sessions.get(id);
	}

	write(id: string, data: string): void {
		const session = this.sessions.get(id);
		if (session && session.status === "running") {
			try {
				session.proc.write(data);
			} catch {
				/* process may have exited */
			}
		}
	}

	resize(id: string, cols: number, rows: number): void {
		const session = this.sessions.get(id);
		if (!session) return;
		session.cols = cols;
		session.rows = rows;
		try {
			session.proc.resize(cols, rows);
		} catch {
			/* process may have exited */
		}
	}

	close(id: string): void {
		const session = this.sessions.get(id);
		if (!session) return;
		try {
			session.proc.kill();
		} catch {
			/* already gone */
		}
		this.sessions.delete(id);
		for (const ws of session.attached) {
			if (ws.readyState === WebSocket.OPEN) ws.close();
		}
	}

	private onOutput(session: TerminalSession, text: string): void {
		if (!text) return;
		session.buffer = (session.buffer + text).slice(-512 * 1024);
		session.seq += 1;
		this.broadcast(session, {
			t: "output",
			s: session.id,
			q: session.seq,
			d: text,
		});
	}

	private onExit(
		session: TerminalSession,
		code: number | null,
		signal: string | null,
	): void {
		if (session.status === "exited") return;
		session.status = "exited";
		session.exitCode = code ?? undefined;
		session.signal = signal;
		session.seq += 1;
		this.broadcast(session, {
			t: "exit",
			s: session.id,
			q: session.seq,
			exitCode: code,
			signal,
		});
	}

	private broadcast(session: TerminalSession, message: WsMessage): void {
		const frame = encode(message);
		for (const ws of session.attached) {
			if (ws.readyState === WebSocket.OPEN) ws.send(frame);
		}
	}

	private handleConnection(ws: WebSocket): void {
		ws.on("message", (raw) => {
			if (!Buffer.isBuffer(raw)) return;
			const msg = decode(raw);
			if (!msg) return;
			switch (msg.t) {
				case "hello":
					ws.send(encode({ t: "pong" }));
					break;
				case "attach":
					this.attach(ws, msg.s ?? "");
					break;
				case "detach":
					this.detach(ws, msg.s ?? "");
					break;
				case "write":
					if (msg.s) this.write(msg.s, typeof msg.d === "string" ? msg.d : "");
					break;
				case "ping":
					ws.send(encode({ t: "pong" }));
					break;
			}
		});
		ws.on("close", () => {
			for (const session of this.sessions.values()) session.attached.delete(ws);
		});
	}

	private attach(ws: WebSocket, sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			ws.send(
				encode({
					t: "error",
					s: sessionId,
					message: "terminal session not found",
					fatal: true,
				}),
			);
			return;
		}
		session.attached.add(ws);
		ws.send(
			encode({
				t: "snapshot",
				s: sessionId,
				q: session.seq,
				history: session.buffer,
				status: session.status,
				exitCode: session.exitCode,
				signal: session.signal ?? null,
				ptyBackend: session.proc.backend,
				terminalType: session.proc.backend,
			}),
		);
	}

	private detach(ws: WebSocket, sessionId: string): void {
		const session = this.sessions.get(sessionId);
		session?.attached.delete(ws);
	}
}

export function createTerminalRoutes(
	app: import("express").Express,
	server: Server,
): () => void {
	const backend = resolveTerminalBackend();
	const manager = new TerminalManager(server, backend);
	const router = Router();

	router.get("/terminal/shells", (_req: Request, res: Response) => {
		res.json([
			{ id: "bash", name: "bash", supportsLogin: true },
			{ id: "zsh", name: "zsh", supportsLogin: true },
			{ id: "fish", name: "fish", supportsLogin: true },
			{ id: "sh", name: "sh", supportsLogin: true },
		]);
	});

	router.post("/terminal/create", (req: Request, res: Response) => {
		const requested =
			typeof req.body?.cwd === "string" && req.body.cwd ? req.body.cwd : "";
		const home = path.resolve(process.env.HOME ?? "/root");
		const resolved = requested ? path.resolve(requested) : home;
		// Confine the shell cwd to the home directory.
		const cwd =
			resolved === home || resolved.startsWith(home + path.sep)
				? resolved
				: home;
		const session = manager.create(cwd, req.body ?? {});
		res.status(201).json({
			sessionId: session.id,
			cols: session.cols,
			rows: session.rows,
			status: session.status,
		});
	});

	router.get("/terminal/sessions", (req: Request, res: Response) => {
		const cwd = typeof req.query.cwd === "string" ? req.query.cwd : "";
		res.json({ sessions: manager.list(cwd) });
	});

	router.post("/terminal/touch", (_req: Request, res: Response) => {
		res.status(204).end();
	});

	router.post("/terminal/:id/restart", (req: Request, res: Response) => {
		const id = req.params["id"];
		if (typeof id !== "string") {
			res.status(400).json({ error: "id required" });
			return;
		}
		const existing = manager.get(id);
		if (!existing) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		manager.close(id);
		const session = manager.create(existing.cwd, {
			cols: existing.cols,
			rows: existing.rows,
		});
		res.json({
			sessionId: session.id,
			cols: session.cols,
			rows: session.rows,
			status: session.status,
		});
	});

	router.post("/terminal/:id/appearance", (_req: Request, res: Response) => {
		res.status(204).end();
	});

	router.post("/terminal/:id/resize", (req: Request, res: Response) => {
		const id = req.params["id"];
		const cols = Number(req.body?.cols);
		const rows = Number(req.body?.rows);
		if (
			typeof id === "string" &&
			Number.isFinite(cols) &&
			Number.isFinite(rows)
		) {
			manager.resize(id, cols, rows);
		}
		res.status(204).end();
	});

	router.delete("/terminal/:id", (req: Request, res: Response) => {
		const id = req.params["id"];
		if (typeof id === "string") manager.close(id);
		res.status(204).end();
	});

	router.post("/terminal/force-kill", (req: Request, res: Response) => {
		const sessionId =
			typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
		const killed: string[] = [];
		if (sessionId) {
			if (manager.get(sessionId)) {
				manager.close(sessionId);
				killed.push(sessionId);
			}
		} else {
			const cwd = typeof req.body?.cwd === "string" ? req.body.cwd : "";
			for (const s of manager.list(cwd)) {
				manager.close(s.sessionId);
				killed.push(s.sessionId);
			}
		}
		res.json({ killedSessionIds: killed });
	});

	app.use("/api", router);

	return () => manager.dispose();
}
