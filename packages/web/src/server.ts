/**
 * express app: owns an AgentClient and exposes prompt/abort/events routes.
 */

import express from "express";
import cors from "cors";
import path from "node:path";
import type { Response } from "express";
import type { AgentClient, AgentEvent } from "@pichamber/agent";
import { broadcast, type SseSink } from "./sse.js";

export function createApp(client: AgentClient): express.Express {
	const app = express();
	app.use(cors());
	app.use(express.json());

	const clients = new Set<SseSink>();

	// Single subscription, fan-out to every connected SSE client.
	client.subscribe((event: AgentEvent) => {
		broadcast(clients, event);
	});

	app.get("/api/events", (req, res: Response) => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(": connected\n\n");

		const sink: SseSink = { write: (chunk) => res.write(chunk) };
		clients.add(sink);

		req.on("close", () => {
			clients.delete(sink);
		});
	});

	app.post("/api/prompt", (req, res: Response) => {
		const text = req.body?.text;
		if (typeof text !== "string" || text.trim() === "") {
			res.status(400).json({ error: "text is required" });
			return;
		}
		if (client.getSnapshot().isStreaming) {
			res.status(409).json({ error: "agent is already streaming" });
			return;
		}

		// Fire-and-forget: results stream via SSE.
		void client.prompt(text).catch((err: unknown) => {
			const message = err instanceof Error ? err.message : String(err);
			broadcast(clients, { type: "status", status: "error", error: message });
		});

		res.status(202).json({ accepted: true });
	});

	app.post("/api/abort", (_req, res: Response) => {
		void client.abort();
		res.status(202).json({ accepted: true });
	});

	app.get("/api/health", (_req, res: Response) => {
		res.status(200).json({ ok: true });
	});

	// Static hosting for the built UI (production mode).
	const uiDist = process.env.UI_DIST ?? path.resolve(process.cwd(), "../ui/dist");
	app.use(express.static(uiDist));
	// SPA fallback: any non-API GET returns index.html.
	app.get(/^(?!\/api).*/, (_req, res) => {
		res.sendFile(path.join(uiDist, "index.html"));
	});

	return app;
}
