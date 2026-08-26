/**
 * opencode-compatible terminal surface — a real PTY backend (node-pty).
 * Spawns a shell per session and multiplexes I/O over the `/api/terminal/ws`
 * WebSocket using opencode's tagged-JSON protocol. Supports true resize and
 * TTY job control (interactive programs like vim/top work).
 */

import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const TAG = 1;

interface WsMessage {
	t: string;
	s?: string;
	q?: number;
	d?: string;
	[key: string]: unknown;
}

interface TerminalSession {
	id: string;
	cwd: string;
	proc: IPty;
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

class TerminalManager {
	private readonly sessions = new Map<string, TerminalSession>();

	constructor(server: Server) {
		const wss = new WebSocketServer({
			server,
			path: "/api/terminal/ws",
			verifyClient: (info: { origin: string }) => {
				// Reject cross-origin WebSocket upgrades (CSWSH mitigation).
				// Extra origins come from the environment, never hardcoded.
				const origin = info.origin || "";
				const extraOrigins = (process.env.PICAMBER_ALLOWED_ORIGIN ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				return (
					!origin ||
					origin.startsWith("http://localhost") ||
					origin.startsWith("http://127.0.0.1") ||
					extraOrigins.some((o) => origin.includes(o))
				);
			},
		});
		wss.on("connection", (ws) => this.handleConnection(ws));
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
		const proc = pty.spawn(shell, args, {
			name: "xterm-256color",
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
			this.onExit(session, exitCode, signal !== undefined ? String(signal) : null),
		);
		this.sessions.set(id, session);
		return session;
	}

	list(
		cwd: string,
	): Array<{
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
				ptyBackend: "node-pty",
				terminalType: "node-pty",
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
): void {
	const manager = new TerminalManager(server);
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
		const requested = typeof req.body?.cwd === "string" && req.body.cwd ? req.body.cwd : "";
		const home = path.resolve(process.env.HOME ?? "/root");
		const resolved = requested ? path.resolve(requested) : home;
		// Confine the shell cwd to the home directory.
		const cwd = resolved === home || resolved.startsWith(home + path.sep) ? resolved : home;
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
}
