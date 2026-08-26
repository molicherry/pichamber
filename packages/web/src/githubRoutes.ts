/**
 * opencode-compatible `/api/github/*` routes — GitHub PR surface.
 * Backed by the `gh` CLI (already authenticated on this host). Returns
 * `connected: false` shapes when gh is unavailable/unauthenticated so the
 * UI degrades gracefully instead of erroring.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function gh(
	directory: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFileAsync("gh", args, {
			cwd: directory,
			maxBuffer: 64 * 1024 * 1024,
			env: { ...process.env, NO_COLOR: "1" },
		});
		return { stdout, stderr, code: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
			code: e.code ?? 1,
		};
	}
}

function ghConnected(): boolean {
	try {
		execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Resolve the repo directory within HOME (mirrors gitRoutes' confinement). */
function dirOf(req: Request, fallback: string): string {
	const d = req.query.directory;
	if (typeof d === "string" && d.trim()) {
		const resolved = path.resolve(d.trim());
		const home = path.resolve(process.env.HOME ?? "/root");
		if (resolved === home || resolved.startsWith(home + path.sep))
			return d.trim();
	}
	return fallback;
}

type PrJson = {
	number: number;
	title: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	url: string;
	isDraft: boolean;
	baseRefName: string;
	headRefName: string;
};

function mapPr(p: PrJson): {
	number: number;
	title: string;
	url: string;
	state: "open" | "closed" | "merged";
	draft: boolean;
	base: string;
	head: string;
} {
	return {
		number: p.number,
		title: p.title,
		url: p.url,
		state:
			p.state === "MERGED"
				? "merged"
				: p.state === "CLOSED"
					? "closed"
					: "open",
		draft: p.isDraft,
		base: p.baseRefName,
		head: p.headRefName,
	};
}

async function repoRef(
	directory: string,
): Promise<{ owner: string; repo: string; url: string } | null> {
	const r = await gh(directory, [
		"repo",
		"view",
		"--json",
		"nameWithOwner,url",
	]);
	if (r.code !== 0) return null;
	try {
		const data = JSON.parse(r.stdout) as { nameWithOwner: string; url: string };
		const [owner, repo] = data.nameWithOwner.split("/");
		return { owner: owner ?? "", repo: repo ?? "", url: data.url };
	} catch {
		return null;
	}
}

const PR_JSON_FIELDS = "number,title,state,url,isDraft,baseRefName,headRefName";

export function createGithubRoutes(
	app: import("express").Express,
	defaultCwd: string,
): void {
	const router = Router();

	router.get("/github/pr/status", async (req: Request, res: Response) => {
		const directory = dirOf(req, defaultCwd);
		if (!ghConnected()) {
			res.json({
				connected: false,
				branch: req.query.branch ?? null,
				pr: null,
			});
			return;
		}
		const branch = typeof req.query.branch === "string" ? req.query.branch : "";
		const r = await gh(directory, ["pr", "view", "--json", PR_JSON_FIELDS]);
		if (r.code !== 0) {
			res.json({
				connected: true,
				branch,
				pr: null,
				repo: await repoRef(directory),
			});
			return;
		}
		let pr = null;
		try {
			pr = mapPr(JSON.parse(r.stdout) as PrJson);
		} catch {
			pr = null;
		}
		res.json({ connected: true, branch, pr, repo: await repoRef(directory) });
	});

	router.post("/github/pr/create", async (req: Request, res: Response) => {
		if (!ghConnected()) {
			res.status(503).json({ error: "gh CLI is not authenticated" });
			return;
		}
		const directory =
			typeof req.body?.directory === "string" && req.body.directory
				? req.body.directory
				: defaultCwd;
		const title =
			typeof req.body?.title === "string" ? req.body.title.trim() : "";
		const head = typeof req.body?.head === "string" ? req.body.head.trim() : "";
		const base = typeof req.body?.base === "string" ? req.body.base.trim() : "";
		const body = typeof req.body?.body === "string" ? req.body.body : "";
		const draft = req.body?.draft === true;
		if (!title || !head || !base) {
			res.status(400).json({ error: "title, head and base are required" });
			return;
		}
		const args = [
			"pr",
			"create",
			"--title",
			title,
			"--head",
			head,
			"--base",
			base,
		];
		if (body) args.push("--body", body);
		if (draft) args.push("--draft");
		const r = await gh(directory, args);
		if (r.code !== 0) {
			res.status(500).json({ error: r.stderr || "gh pr create failed" });
			return;
		}
		// gh pr create prints the PR URL (e.g. https://github.com/o/r/pull/123).
		const m = r.stdout.match(/pull\/(\d+)/);
		const number = m ? Number(m[1]) : 0;
		const view = await gh(directory, [
			"pr",
			"view",
			String(number),
			"--json",
			PR_JSON_FIELDS,
		]);
		let pr;
		try {
			pr = mapPr(JSON.parse(view.stdout) as PrJson);
		} catch {
			pr = {
				number,
				title,
				url: r.stdout.trim(),
				state: draft ? "open" : "open",
				draft,
				base,
				head,
			};
		}
		res.status(201).json(pr);
	});

	router.get("/github/pulls/list", async (req: Request, res: Response) => {
		const directory = dirOf(req, defaultCwd);
		if (!ghConnected()) {
			res.json({ connected: false, prs: [] });
			return;
		}
		const query = typeof req.query.query === "string" ? req.query.query : "";
		const args = ["pr", "list", "--json", `${PR_JSON_FIELDS},author`];
		if (query) args.push("--search", query);
		const r = await gh(directory, args);
		if (r.code !== 0) {
			res.json({ connected: true, repo: await repoRef(directory), prs: [] });
			return;
		}
		let prs: Array<{
			number: number;
			title: string;
			url: string;
			state: "open" | "closed" | "merged";
			draft: boolean;
			base: string;
			head: string;
			author: { login: string } | null;
		}> = [];
		try {
			const list = JSON.parse(r.stdout) as Array<
				PrJson & { author?: { login: string } }
			>;
			prs = list.map((p) => ({
				...mapPr(p),
				author: p.author ? { login: p.author.login } : null,
			}));
		} catch {
			prs = [];
		}
		res.json({
			connected: true,
			repo: await repoRef(directory),
			prs,
			hasMore: false,
		});
	});

	app.use("/api", router);
}
