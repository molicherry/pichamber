/**
 * opencode-compatible HTTP + SSE server, backed by SessionRegistry.
 * The vendored openchamber UI talks to these routes via @opencode-ai/sdk
 * (baseUrl `/api`, so routes mount under `/api`).
 *
 * Response shapes mirror @opencode-ai/sdk: endpoints return data directly
 * (Array<Session>, Session, Array<{info,parts}>, {id:SessionStatus}), and
 * prompt/abort return 204 (no body).
 */

import { Router } from "express";
import type { Request, Response } from "express";
import type { Express } from "express";
import fs from "node:fs";
import path from "node:path";
import type {
	Session,
	SessionHandle,
	SessionRegistry,
	SessionRuntime,
} from "@pichamber/agent";
import { listModelProviders } from "@pichamber/agent";
import { nextEventId, toOpencodeEvent, type OpencodeEvent } from "./sseEvents.js";
import { resolveAgentDir } from "./piRuntime.js";


/**
 * Global panel-event bus. Store-derived events flow through each SSE
 * connection's registry subscription, but panel state (git branch, lsp, mcp)
 * lives in the web layer and needs a way to fan out to every open /event
 * stream. subscribePanelEvents is called once per SSE connection.
 */
const panelListeners = new Set<(event: OpencodeEvent) => void>();
export function broadcastPanelEvent(
	type: string,
	properties: Record<string, unknown>,
): void {
	const event: OpencodeEvent = { id: nextEventId(), type, properties };
	for (const l of panelListeners) l(event);
}
export function subscribePanelEvents(
	listener: (event: OpencodeEvent) => void,
): () => void {
	panelListeners.add(listener);
	return () => {
		panelListeners.delete(listener);
	};
}


function toOpencodeSession(h: SessionHandle): Session {
	return {
		id: h.id,
		slug: h.id,
		projectID: "default",
		directory: h.directory,
		title: h.title,
		version: "0",
		tokens: h.tokens,
		time: { created: h.createdAt, updated: h.updatedAt },
	};
}

const CONFIG_DIR = path.join(process.env.HOME ?? "/root", ".config", "openchamber");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
		// Parse at the boundary: settings must be a plain object (never scalar/array).
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as Record<string, unknown>;
	} catch {
		return {};
	}
}

function writeSettings(settings: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
	// Atomic write: temp file + rename so a crash can't leave a partial/empty file.
	const tmp = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
	fs.renameSync(tmp, SETTINGS_PATH);
}

function withProject(s: Session): Session {
	return {
		...s,
		project: { id: "project-1", name: "pichamber", worktree: s.directory },
	} as Session;
}

/** The single primary agent pi exposes (pi has no user-defined agents). */
const buildAgent = {
	name: "build",
	description: "Default coding agent",
	mode: "primary",
	native: true,
	permission: [
		{ permission: "bash", pattern: "*", action: "allow" },
		{ permission: "edit", pattern: "**", action: "allow" },
		{ permission: "webfetch", pattern: "**", action: "allow" },
	],
};

/** First provider/model from pi models.json, as an opencode `model` ref. */
async function defaultModel(): Promise<string | undefined> {
	try {
		const { default: defaults } = await listModelProviders();
		const [providerID] = Object.keys(defaults);
		if (!providerID) return undefined;
		const modelID = defaults[providerID];
		return modelID ? `${providerID}/${modelID}` : providerID;
	} catch {
		return undefined;
	}
}

/** The opencode Config object: the model + agent pi actually has. */
async function configObject(): Promise<Record<string, unknown>> {
	const model = await defaultModel();
	return {
		...(model ? { model } : {}),
		agent: { build: buildAgent },
	};
}

export function createOpencodeRoutes(
	app: Express,
	registry: SessionRegistry,
): void {
	const router = Router();

	// Filesystem browsing is confined to the home directory: the UI reads
	// workspace + config files under $HOME, but must not reach system paths
	// (/etc, /var, …). This keeps the directory picker working while closing
	// the arbitrary-file-read (LFI) hole for non-browser clients.
	const home = path.resolve(process.env.HOME ?? "/root");
	const isWithinHome = (p: string): boolean => {
		const resolved = path.resolve(p);
		return resolved === home || resolved.startsWith(home + path.sep);
	};
	// Never expose credential/material paths, even though they live under HOME.
	const isSensitivePath = (p: string): boolean =>
		/(^|\/)(\.ssh|\.aws|\.docker|\.kube|\.config\/gh|\.gnupg)(\/|$)/.test(p) ||
		/(^|\/)(\.env(\.\w+)?|\.git-credentials|\.netrc|\.gitconfig|id_rsa|id_ed25519)(\/|$)/.test(p);

	const getRuntime = async (id: string): Promise<SessionRuntime | null> => {
		const existing = registry.get(id);
		if (existing) return existing;
		return registry.open(id);
	};

	const paramId = (req: Request): string => {
		const v = req.params["id"];
		if (typeof v === "string") return v;
		if (Array.isArray(v)) return v[0] ?? "";
		return "";
	};

	// --- session routes ---

	router.get("/session", async (_req, res: Response) => {
		const handles = await registry.list();
		res.json(handles.map((h) => withProject(toOpencodeSession(h))));
	});

	router.get("/experimental/session", async (_req, res: Response) => {
		const handles = await registry.list();
		res.json(handles.map((h) => withProject(toOpencodeSession(h))));
	});

	router.post("/session", async (_req, res: Response) => {
		const rt = await registry.create();
		res.status(201).json(withProject(rt.store.getSession()));
	});

	router.get("/session/status", (_req, res: Response) => {
		const status: Record<string, { type: string }> = {};
		for (const rt of registry.runtimesList()) {
			status[rt.id] = { type: rt.store.getStatus() };
		}
		res.json(status);
	});

	router.get("/session/:id", async (req: Request, res: Response) => {
		const rt = await getRuntime(paramId(req));
		if (!rt) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		res.json(withProject(rt.store.getSession()));
	});

	router.get("/session/:id/message", async (req: Request, res: Response) => {
		const rt = await getRuntime(paramId(req));
		if (!rt) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		const records = rt.store.getMessages().map((info) => ({
			info,
			parts: rt.store.getParts(info.id),
		}));
		res.json(records);
	});

	router.get("/session/:id/todo", async (req: Request, res: Response) => {
		const rt = await getRuntime(paramId(req));
		if (!rt) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		res.json(rt.store.getTodos());
	});

	const promptHandler = async (req: Request, res: Response) => {
		const rt = await getRuntime(paramId(req));
		if (!rt) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		const parts = req.body?.parts as
			| Array<{ type?: string; text?: string }>
			| undefined;
		const text = (parts ?? [])
			.map((p) => p.text ?? "")
			.join("")
			.trim();
		if (!text) {
			res.status(400).json({ error: "empty prompt" });
			return;
		}
		// Reject concurrent prompts while the session is already streaming.
		if (rt.store.getStatus() === "busy") {
			res.status(409).json({ error: "session is busy" });
			return;
		}
		const messageID =
			typeof req.body?.messageID === "string" ? req.body.messageID : undefined;
		rt.store.pushUser(text, messageID);
		rt.client.prompt(text).catch((err: unknown) => {
			console.error(`[prompt] session ${rt.id} failed:`, err);
		});
		res.status(204).end();
	};
	router.post("/session/:id/prompt", promptHandler);
	router.post("/session/:id/prompt_async", promptHandler);

	router.post("/session/:id/abort", async (req: Request, res: Response) => {
		const rt = await getRuntime(paramId(req));
		if (!rt) {
			res.status(404).json({ error: "session not found" });
			return;
		}
		void rt.client.abort();
		res.status(204).end();
	});

	// --- SSE (fan out across every live runtime) ---

	const sseHandler = (req: Request, res: Response) => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(": connected\n\n");

		const unsubscribe = registry.subscribeAll((change, id) => {
			const rt = registry.get(id);
			if (!rt) return;
			const event = toOpencodeEvent(change, rt.store.getSession());
			if (event) res.write(`data: ${JSON.stringify(event)}\n\n`);

			// lsp.updated: an lsp* tool finished a scan — nudge the UI to reload
			// its LSP panel (the reducer only calls onLoadLsp).
			if (
				change.type === "part_updated" &&
				change.part.type === "tool" &&
				change.part.state.status === "completed" &&
				change.part.tool.includes("lsp")
			) {
				res.write(
					`data: ${JSON.stringify({ id: nextEventId(), type: "lsp.updated", properties: { sessionID: id } })}\n\n`,
				);
			}
		});

		// Panel events broadcast from the web layer (git branch changes, etc.).
		const unsubscribePanel = subscribePanelEvents((event) => {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		});

		// MCP tool-set changes (agent layer detects register/unregister).
		const unsubscribeMcpTools = registry.subscribeMcpToolsChanged(() => {
			res.write(
				`data: ${JSON.stringify({ id: nextEventId(), type: "mcp.tools.changed", properties: { server: "mcp" } })}\n\n`,
			);
		});

		// Permission prompts (pi permission extensions via the injected uiContext).
		const unsubscribePermissions = registry.permissionBroker.subscribe((prompt) => {
			// question.asked: pi's uiContext.input is a free-text question.
			if (prompt.kind === "input") {
				const qevent = {
					id: nextEventId(),
					type: "question.asked",
					properties: {
						id: prompt.id,
						sessionID: prompt.sessionId,
						questions: [{ question: prompt.title, header: prompt.title.slice(0, 30), options: [] }],
					},
				};
				res.write(`data: ${JSON.stringify(qevent)}\n\n`);
				return;
			}

			// Map pi's uiContext prompts onto opencode's permission-card shape so
			// the vendored PermissionCard renders the tool + command correctly.
			const command = prompt.title.match(/Dangerous command:\s*\n\n([\s\S]*?)\n\nAllow\?/)?.[1]?.trim();
			const isDangerousBash = prompt.kind === "select" && command !== undefined;
			const writeEdit = prompt.title.match(/^Allow (write|edit)\?/)?.[1];
			const tool = isDangerousBash ? "bash" : writeEdit ?? prompt.kind;
			const event = {
				id: nextEventId(),
				type: "permission.asked",
				properties: {
					id: prompt.id,
					sessionID: prompt.sessionId,
					permission: tool,
					patterns: [],
					metadata: {
						kind: prompt.kind,
						title: prompt.title,
						message: prompt.message,
						options: prompt.options,
						...(command ? { command, description: "Dangerous shell command" } : {}),
					},
					always: [],
				},
			};
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		});

		req.on("close", () => {
			unsubscribe();
			unsubscribePermissions();
			unsubscribePanel();
			unsubscribeMcpTools();
		});
	};
	router.get("/event", sseHandler);
	router.get("/global/event", sseHandler);

	// Permission reply — opencode posts { reply: "once" | "always" | "reject", message? }.
	router.post("/permission/:id/reply", (req: Request, res: Response) => {
		const id = typeof req.params["id"] === "string" ? req.params["id"] : "";
		const reply = req.body?.reply;
		const allowed = reply !== "reject";
		const message = typeof req.body?.message === "string" ? req.body.message : undefined;
		const ok = registry.permissionBroker.respond(id, allowed, message);
		res.json(ok);
	});

	// Question reply — opencode posts { answers: string[][] } (one answer array
	// per question; pi's input prompt has a single free-text answer).
	router.post("/session/:id/question/:requestId/reply", (req: Request, res: Response) => {
		const requestId = typeof req.params["requestId"] === "string" ? req.params["requestId"] : "";
		const answers = req.body?.answers;
		const first = Array.isArray(answers) && Array.isArray(answers[0]) ? answers[0] : [];
		const value = first.length > 0 ? String(first[0]) : "";
		const ok = registry.permissionBroker.respond(requestId, true, value);
		res.json(ok);
	});

	// --- config / project stubs (opencode endpoints the UI bootstraps) ---

	router.get("/global/health", (_req, res: Response) => {
		res.json({ ok: true });
	});

	// opencode's health check: the UI's checkHealth() gates bootstrap on
	// `{ healthy: true }` — a wrong shape here puts the app in Startup-failed.
	router.get("/opencode/health", (_req, res: Response) => {
		res.json({ healthy: true });
	});
	router.get("/global/config", async (_req, res: Response) => {
		res.json(await configObject());
	});
	router.get("/config", async (_req, res: Response) => {
		res.json(await configObject());
	});

	// Agents — the UI gates sending on having at least one primary agent.
	// Return a single default 'build' agent (pi is the only backend).
	router.get("/agent", (_req, res: Response) => {
		res.json([buildAgent]);
	});

	router.get("/config/providers", async (_req, res: Response) => {
		try {
			const list = await listModelProviders();
			res.json({ providers: list.providers, default: list.default });
		} catch {
			res.json({ providers: [], default: {} });
		}
	});

	// Shared settings (theme, projects, activeProjectId, …) — persisted to
	// ~/.config/openchamber/settings.json. The UI's project store syncs its
	// project list from the PUT response; returning the merged settings (not a
	// stub) is what keeps an added project from being immediately wiped.
	router.get("/config/settings", (_req, res: Response) => {
		res.json(readSettings());
	});
	router.put("/config/settings", (req: Request, res: Response) => {
		const incoming = req.body && typeof req.body === "object" ? req.body : {};
		const merged = { ...readSettings(), ...(incoming as Record<string, unknown>) };
		writeSettings(merged);
		res.json(merged);
	});

	// LSP server status — pi has no managed LSP servers (lsp_diagnostics is a
	// runtime tool, not a per-session server registry), so this is honestly empty.
	router.get("/lsp", (_req, res: Response) => {
		res.json([]);
	});

	// MCP status + config — pi has no MCP server support, so these are empty.
	router.get("/mcp", (_req, res: Response) => {
		res.json({});
	});
	router.get("/config/mcp", (_req, res: Response) => {
		res.json([]);
	});

	router.get("/project", (_req, res: Response) => {
		res.json(projectsFromSettings(registry.cwd));
	});
	router.get("/project/current", (_req, res: Response) => {
		res.json(currentProject(registry.cwd));
	});
	router.get("/path", (_req, res: Response) => {
		const home = process.env.HOME ?? "";
		res.json({
			home,
			state: resolveAgentDir(),
			config: CONFIG_DIR,
			worktree: registry.cwd,
			directory: registry.cwd,
		});
	});

	router.get("/fs/list", (req: Request, res: Response) => {
		const dir = typeof req.query.path === "string" ? req.query.path : "/";
		if (!isWithinHome(dir) || isSensitivePath(dir)) {
			res.json({ directory: dir, entries: [] });
			return;
		}
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			const list = entries.map((e) => ({
				name: e.name,
				path: path.join(dir, e.name),
				isDirectory: e.isDirectory(),
			}));
			res.json({ directory: dir, entries: list });
		} catch {
			res.json({ directory: dir, entries: [] });
		}
	});

	router.get("/fs/home", (_req, res: Response) => {
		res.json({ home: process.env.HOME ?? "/root" });
	});

	router.get("/fs/read", (req: Request, res: Response) => {
		const p = typeof req.query.path === "string" ? req.query.path : "";
		if (!isWithinHome(p) || isSensitivePath(p)) {
			res.status(403).type("text/plain").send("");
			return;
		}
		try {
			const content = fs.readFileSync(p, "utf8");
			res.type("text/plain").send(content);
		} catch {
			res.status(404).type("text/plain").send("");
		}
	});

	app.use("/api", router);
}

const project = {
	id: "project-1",
	worktree: "", // always overridden with the session cwd (see projectsFromSettings)
	name: "pichamber",
	vcs: "git",
	time: { created: Date.now(), updated: Date.now() },
	sandboxes: [],
};

type OpencodeProject = {
	id: string;
	worktree: string;
	name: string;
	vcs: string;
	time: { created: number; updated: number };
	sandboxes: unknown[];
};

/** Map settings.projects (UI ProjectEntry[]) into opencode Project shapes. */
function projectsFromSettings(cwd: string): OpencodeProject[] {
	const settings = readSettings();
	const entries = Array.isArray(settings.projects)
		? (settings.projects as Array<Record<string, unknown>>)
		: [];
	if (entries.length === 0) return [{ ...project, worktree: cwd }];
	return entries.map((p) => {
		const pPath = typeof p.path === "string" ? p.path : cwd;
		const label = typeof p.label === "string" && p.label ? p.label : "";
		const name = label || path.basename(pPath);
		return {
			id: typeof p.id === "string" ? p.id : `project-${pPath}`,

			worktree: pPath,
			name,
			vcs: "git",
			time: {
				created: typeof p.addedAt === "number" ? p.addedAt : Date.now(),
				updated: typeof p.lastOpenedAt === "number" ? p.lastOpenedAt : Date.now(),
			},
			sandboxes: [],
		};
	});
}

/** The project whose worktree matches the current session directory. */
function currentProject(cwd: string): OpencodeProject {
	const list = projectsFromSettings(cwd);
	return list.find((p) => p.worktree === cwd) ?? { ...project, worktree: cwd };
}
