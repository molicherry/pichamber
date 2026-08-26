/**
 * opencode-compatible `/api/git/*` routes — core git panel surface.
 * Backed by the git CLI (child_process), shapes mirror
 * packages/ui/src/lib/api/types.ts.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { broadcastPanelEvent } from "./opencode.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Run `git -C <dir> ...` and return stdout, or null on any error. */
async function git(directory: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", directory, ...args], {
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	} catch {
		return null;
	}
}

/** Run `git -C <dir> ...` and return stdout/stderr/exit-code (for merge/rebase conflict detection). */
async function gitFull(
	directory: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", ["-C", directory, ...args], {
			maxBuffer: 64 * 1024 * 1024,
		});
		return { stdout, stderr, code: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number };
		return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
	}
}

/** Paths with merge conflicts (unmerged entries). */
async function getConflictFiles(directory: string): Promise<string[]> {
	const out = await git(directory, ["diff", "--name-only", "--diff-filter=U"]);
	return (out ?? "").split("\n").filter(Boolean);
}

/** Parse `git diff --shortstat` output into insertion/deletion counts. */
function parseShortstat(stat: string): { insertions: number; deletions: number } {
	const ins = stat.match(/(\d+) insertion/);
	const del = stat.match(/(\d+) deletion/);
	return { insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}

/** Reject ref-like inputs that could be parsed as git options (option injection). */
function isSafeRef(ref: string): boolean {
	return ref.length > 0 && !ref.startsWith("-") && !ref.includes(" ");
}

/** Broadcast the current branch to SSE listeners (vcs.branch.updated). */
async function broadcastBranchChange(directory: string): Promise<void> {
	const branch = ((await git(directory, ["branch", "--show-current"])) ?? "").trim();
	broadcastPanelEvent("vcs.branch.updated", { branch: branch || null });
}

function dirOf(req: Request, fallback: string): string {
	const d = req.query.directory;
	if (typeof d === "string" && d.trim()) {
		const resolved = path.resolve(d.trim());
		const home = path.resolve(process.env.HOME ?? "/root");
		// Confine git operations to the home directory; reject arbitrary system paths.
		if (resolved === home || resolved.startsWith(home + path.sep)) {
			return d.trim();
		}
	}
	return fallback;
}

function parseBranchHeader(line: string): {
	current: string;
	tracking: string | null;
	ahead: number;
	behind: number;
} {
	// "## main...origin/main [ahead 1, behind 2]" or "## HEAD (no branch)"
	const body = line.slice(3).trim();
	let ahead = 0;
	let behind = 0;
	const bracket = body.match(/\[(.*)\]$/);
	let base = body;
	if (bracket) {
		base = body.slice(0, bracket.index ?? 0).trim();
		for (const part of (bracket[1] ?? "").split(",")) {
			const [k, v] = part.trim().split(/\s+/);
			const n = Number(v);
			if (k === "ahead") ahead = Number.isFinite(n) ? n : 0;
			if (k === "behind") behind = Number.isFinite(n) ? n : 0;
		}
	}
	// Detached HEAD: `## HEAD (no branch)`
	if (base === "HEAD (no branch)") {
		return { current: "HEAD", tracking: null, ahead, behind };
	}
	// Unborn branch: `## No commits yet on <branch>`
	const unborn = base.match(/^No commits yet on (.+)$/);
	if (unborn) {
		return { current: (unborn[1] ?? "").trim(), tracking: null, ahead, behind };
	}
	const sep = base.indexOf("...");
	if (sep >= 0) {
		return {
			current: base.slice(0, sep).trim(),
			tracking: base.slice(sep + 3).trim(),
			ahead,
			behind,
		};
	}
	return { current: base, tracking: null, ahead, behind };
}

export function createGitRoutes(
	app: import("express").Express,
	defaultCwd: string,
	generateText?: (prompt: string, systemPrompt?: string) => Promise<string>,
): void {
	const router = Router();

	router.get("/git/check", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
		res.json({ isGitRepository: out?.trim() === "true" });
	});

	router.get("/git/status", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const out = await git(dir, ["status", "--porcelain=v1", "-z", "-b"]);
		if (out === null) {
			res.status(500).json({ error: "not a git repository" });
			return;
		}
		// -z emits NUL-separated, unquoted paths; renames carry a second path.
		const tokens = out.split("\0");
		let current = "";
		let tracking: string | null = null;
		let ahead = 0;
		let behind = 0;
		const files: Array<{ path: string; index: string; working_dir: string }> = [];
		let i = 0;
		if ((tokens[0] ?? "").startsWith("## ")) {
			const parsed = parseBranchHeader(tokens[0] ?? "");
			current = parsed.current;
			tracking = parsed.tracking;
			ahead = parsed.ahead;
			behind = parsed.behind;
			i = 1;
		}
		for (; i < tokens.length; i++) {
			const token = tokens[i] ?? "";
			if (token.length < 3) continue;
			const index = token[0] ?? " ";
			const working = token[1] ?? " ";
			let filePath = token.slice(3);
			// Rename/copy: a second NUL-separated token is the new path.
			if (index === "R" || working === "R" || index === "C" || working === "C") {
				i++;
				const next = tokens[i] ?? "";
				if (next) filePath = next;
			}
			if (!filePath) continue;
			files.push({ path: filePath, index, working_dir: working });
		}
		res.json({
			current,
			tracking,
			ahead,
			behind,
			upstreamComparison: null,
			files,
			isClean: files.length === 0,
			mergeInProgress: null,
			rebaseInProgress: null,
			attentionReason: null,
		});
	});

	router.get("/git/diff", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const filePath = typeof req.query.path === "string" ? req.query.path : "";
		const staged = req.query.staged === "true";
		const context = Number(req.query.context);
		const args = ["diff"];
		if (staged) args.push("--cached");
		if (Number.isFinite(context) && context >= 0) args.push(`-U${context}`);
		if (filePath) args.push("--", filePath);
		const diff = await git(dir, args);
		res.json({ diff: diff ?? "" });
	});

	router.get("/git/file-diff", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const filePath = typeof req.query.path === "string" ? req.query.path : "";
		const staged = req.query.staged === "true";
		if (!filePath) {
			res.status(400).json({ error: "path is required" });
			return;
		}
		// original = HEAD version; modified = staged (index) or working-tree content.
		const original = (await git(dir, ["show", `HEAD:${filePath}`])) ?? "";
		let modified: string;
		if (staged) {
			modified = (await git(dir, ["show", `:${filePath}`])) ?? "";
		} else {
			const resolved = path.resolve(dir, filePath);
			const root = path.resolve(dir);
			if (resolved !== root && !resolved.startsWith(root + path.sep)) {
				res.status(400).json({ error: "path is outside the repository" });
				return;
			}
			try {
				modified = fs.readFileSync(resolved, "utf8");
			} catch {
				modified = "";
			}
		}
		res.json({ original, modified, path: filePath, isBinary: false });
	});

	router.get("/git/branches", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const currentOut = await git(dir, ["branch", "--show-current"]);
		const current = currentOut?.trim() ?? "";
		const out = await git(dir, [
			"for-each-ref",
			"--format=%(refname:short)",
			"refs/heads",
		]);
		const all = (out ?? "").split("\n").filter(Boolean);
		const branches: Record<string, unknown> = {};
		for (const name of all) {
			const commit = (
				(await git(dir, ["rev-parse", "--short", name])) ?? ""
			).trim();
			branches[name] = {
				current: name === current,
				name,
				commit,
				label: name,
			};
		}
		res.json({ all, current, branches, defaultBranches: {} });
	});

	router.get("/git/log", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const maxCount = Number(req.query.maxCount) || 50;
		const format = "%H%x1f%aI%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%P%x00";
		const out = await git(dir, [
			"log",
			`-${Math.min(maxCount, 500)}`,
			`--pretty=format:${format}`,
		]);
		const entries = (out ?? "")
			.split("\x00")
			.filter(Boolean)
			.map((line) => {
				const [
					hash,
					date,
					message,
					body,
					author_name,
					author_email,
					parentsRaw,
				] = line.split("\x1f");
				return {
					hash: hash ?? "",
					date: date ?? "",
					message: message ?? "",
					refs: "",
					body: body ?? "",
					author_name: author_name ?? "",
					author_email: author_email ?? "",
					filesChanged: 0,
					insertions: 0,
					deletions: 0,
					parents: (parentsRaw ?? "").split(" ").filter(Boolean),
				};
			});
		res.json({
			all: entries,
			latest: entries[0] ?? null,
			total: entries.length,
		});
	});

	router.post("/git/stage", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const paths = Array.isArray(req.body?.paths)
			? (req.body.paths as string[])
			: [];
		if (paths.length === 0) {
			res.status(400).json({ error: "paths is required" });
			return;
		}
		const staged = await git(dir, ["add", "--", ...paths]);
		if (staged === null) {
			res.status(500).json({ error: "stage failed" });
			return;
		}
		res.json({ success: true });
	});

	router.post("/git/unstage", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const paths = Array.isArray(req.body?.paths)
			? (req.body.paths as string[])
			: [];
		if (paths.length === 0) {
			res.status(400).json({ error: "paths is required" });
			return;
		}
		const unstaged = await git(dir, ["reset", "HEAD", "--", ...paths]);
		if (unstaged === null) {
			res.status(500).json({ error: "unstage failed" });
			return;
		}
		res.json({ success: true });
	});

	router.post("/git/commit", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const message =
			typeof req.body?.message === "string" ? req.body.message.trim() : "";
		if (!message) {
			res.status(400).json({ error: "message is required" });
			return;
		}
		const addAll = req.body?.addAll === true;
		const files = Array.isArray(req.body?.files)
			? (req.body.files as string[])
			: [];
		if (addAll) {
			await git(dir, ["add", "-A"]);
		} else if (files.length > 0) {
			await git(dir, ["add", "--", ...files]);
		}
		const commitOut = await git(dir, ["commit", "-m", message]);
		if (commitOut === null) {
			res.status(500).json({ error: "commit failed" });
			return;
		}
		const hash = (
			(await git(dir, ["rev-parse", "--short", "HEAD"])) ?? ""
		).trim();
		const branch = (
			(await git(dir, ["branch", "--show-current"])) ?? ""
		).trim();
		res.json({
			success: true,
			commit: hash,
			branch,
			summary: { changes: 0, insertions: 0, deletions: 0 },
		});
	});

	router.get("/git/global-identity", async (_req: Request, res: Response) => {
		res.json({ userName: null, userEmail: null, sshCommand: null });
	});

	router.get("/git/current-identity", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const userName =
			((await git(dir, ["config", "user.name"])) ?? "").trim() || null;
		const userEmail =
			((await git(dir, ["config", "user.email"])) ?? "").trim() || null;
		if (!userName && !userEmail) {
			res.json(null);
			return;
		}
		res.json({ userName, userEmail, sshCommand: null });
	});

	router.get("/git/remotes", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const out = await git(dir, ["remote", "-v"]);
		const remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }> =
			[];
		const seen = new Map<
			string,
			{ name: string; fetchUrl: string; pushUrl: string }
		>();
		for (const line of (out ?? "").split("\n")) {
			const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
			if (!m) continue;
			const name = m[1] ?? "";
			const url = m[2] ?? "";
			const entry = seen.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
			if (m[3] === "fetch") entry.fetchUrl = url;
			else entry.pushUrl = url;
			seen.set(name, entry);
		}
		for (const e of seen.values()) remotes.push(e);
		res.json(remotes);
	});

	// ===== worktree =====

	router.get("/git/worktrees", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const out = await git(dir, ["worktree", "list", "--porcelain"]);
		const worktrees: Array<{ head: string; name: string; branch: string; path: string }> = [];
		let cur: { head: string; name: string; branch: string; path: string } | null = null;
		for (const line of (out ?? "").split("\n")) {
			if (line.startsWith("worktree ")) {
				if (cur) worktrees.push(cur);
				const p = line.slice(9).trim();
				cur = { head: "", name: path.basename(p), branch: "", path: p };
			} else if (cur && line.startsWith("HEAD ")) {
				cur.head = line.slice(5).trim();
			} else if (cur && line.startsWith("branch refs/heads/")) {
				cur.branch = line.slice("branch refs/heads/".length).trim();
			}
		}
		if (cur) worktrees.push(cur);
		res.json(worktrees);
	});

	router.get("/git/worktree-type", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const out = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
		const isMain = (out ?? "").trim() === "true";
		const gitDir = (await git(dir, ["rev-parse", "--git-dir"])) ?? "";
		const commonDir = (await git(dir, ["rev-parse", "--git-common-dir"])) ?? "";
		// A linked worktree has --git-dir under the common dir's worktrees/ subdir.
		const isLinked = isMain && gitDir.trim() !== commonDir.trim();
		res.json({ isLinkedWorktree: isLinked });
	});

	router.post("/git/worktrees", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const payload = (req.body ?? {}) as {
			mode?: string; worktreeName?: string; name?: string; branchName?: string;
			existingBranch?: string; startRef?: string;
		};
		const mode = payload.mode === "existing" ? "existing" : "new";
		const branchName = (payload.branchName ?? "").trim();
		const existingBranch = (payload.existingBranch ?? "").trim();
		const startRef = (payload.startRef ?? "").trim();
		const worktreeName = (payload.worktreeName ?? payload.name ?? "").trim()
			|| (mode === "new" ? branchName : existingBranch)
			|| "worktree";
		// Worktree name must be a single safe path segment (no traversal).
		if (!/^[A-Za-z0-9._-]+$/.test(worktreeName)) {
			res.status(400).json({ error: "invalid worktree name" });
			return;
		}
		const targetPath = path.join(path.dirname(dir), worktreeName);
		const args = ["worktree", "add"];
		if (mode === "new") {
			if (branchName) args.push("-b", branchName);
		} else {
			if (!existingBranch) { res.status(400).json({ error: "existingBranch is required" }); return; }
		}
		args.push(targetPath);
		if (mode === "existing") args.push(existingBranch);
		else if (startRef) args.push(startRef);
		const r = await gitFull(dir, args);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "worktree create failed" }); return; }
		const head = ((await git(targetPath, ["rev-parse", "HEAD"])) ?? "").trim();
		const branch = mode === "new" ? branchName || head : existingBranch;
		res.json({ head, name: worktreeName, branch, path: targetPath });
	});

	router.delete("/git/worktrees", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const target = typeof req.body?.directory === "string" ? req.body.directory : "";
		const deleteLocalBranch = req.body?.deleteLocalBranch === true;
		if (!target) { res.status(400).json({ error: "directory is required" }); return; }
		// Confine removal to the repository's sibling worktrees (same parent).
		const parent = path.resolve(path.dirname(dir));
		const resolved = path.resolve(target);
		if (resolved === parent || !resolved.startsWith(parent + path.sep)) {
			res.status(403).json({ error: "worktree outside repository parent" });
			return;
		}
		const args = ["worktree", "remove", "--force", resolved];
		const r = await gitFull(dir, args);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "worktree remove failed" }); return; }
		if (deleteLocalBranch) {
			// Real branch from the worktree's own HEAD, not a basename guess.
			const br = ((await git(resolved, ["branch", "--show-current"])) ?? "").trim();
			if (br) await git(dir, ["branch", "-D", br]);
		}
		res.json({ success: true });
	});

	router.post("/git/worktrees/validate", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const payload = (req.body ?? {}) as { worktreeName?: string; name?: string; branchName?: string; existingBranch?: string };
		const worktreeName = (payload.worktreeName ?? payload.name ?? "").trim();
		const branchName = (payload.branchName ?? "").trim();
		const existingBranch = (payload.existingBranch ?? "").trim();
		const errors: Array<{ code: string; message: string }> = [];
		if (worktreeName) {
			const targetPath = path.join(path.dirname(dir), worktreeName);
			if (fs.existsSync(targetPath)) errors.push({ code: "path_exists", message: `Path already exists: ${targetPath}` });
		}
		if (branchName) {
			const exists = await git(dir, ["rev-parse", "--verify", `refs/heads/${branchName}`]);
			if (exists !== null) errors.push({ code: "branch_exists", message: `Branch ${branchName} already exists` });
		}
		if (existingBranch) {
			const exists = await git(dir, ["rev-parse", "--verify", `refs/heads/${existingBranch}`]);
			if (exists === null) errors.push({ code: "branch_missing", message: `Branch ${existingBranch} does not exist` });
		}
		res.json({ ok: errors.length === 0, errors });
	});

	router.get("/git/worktrees/bootstrap-status", async (_req: Request, res: Response) => {
		res.json({ status: "ready", error: null, updatedAt: Date.now() });
	});

	// ===== stash =====

	router.get("/git/stashes", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const out = await git(dir, ["stash", "list", "--format=%gd%x1f%H%x1f%gs%x1f%cr%x00"]);
		const stashes: Array<{ ref: string; message: string; relativeTime: string; hash: string }> = [];
		for (const chunk of (out ?? "").split("\x00")) {
			if (!chunk.trim()) continue;
			const [ref, hash, subject, rel] = chunk.split("\x1f");
			const msg = (subject ?? "").replace(/^(WIP )?on [^:]+:\s*/i, "");
			stashes.push({ ref: ref ?? "", message: msg, relativeTime: rel ?? "", hash: hash ?? "" });
		}
		res.json({ stashes });
	});

	router.post("/git/stashes/file-counts", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const refs = Array.isArray(req.body?.refs) ? (req.body.refs as string[]) : [];
		const counts: Record<string, number> = {};
		for (const ref of refs) {
			const out = await git(dir, ["stash", "show", "--name-only", ref]);
			counts[ref] = (out ?? "").split("\n").filter(Boolean).length;
		}
		res.json({ counts });
	});

	router.post("/git/stash", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
		const args = ["stash", "push"];
		if (message) args.push("-m", message);
		const r = await gitFull(dir, args);
		const created = r.code === 0 && !r.stdout.includes("No local changes to save");
		res.json({ success: r.code === 0, created, message: message || "", output: r.stdout || r.stderr });
	});

	const stashRefOp = (op: "apply" | "pop" | "drop") => async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const ref = typeof req.body?.ref === "string" ? req.body.ref : "";
		if (!ref) { res.status(400).json({ error: "ref is required" }); return; }
		const r = await gitFull(dir, ["stash", op, ref]);
		res.json({ success: r.code === 0, ref });
	};
	router.post("/git/stash/apply", stashRefOp("apply"));
	router.post("/git/stash/pop", stashRefOp("pop"));
	router.post("/git/stash/drop", stashRefOp("drop"));

	// ===== branch =====

	router.post("/git/checkout", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
		if (!branch) { res.status(400).json({ error: "branch is required" }); return; }
		if (!isSafeRef(branch)) { res.status(400).json({ error: "invalid branch" }); return; }
		const r = await gitFull(dir, ["checkout", branch]);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "checkout failed" }); return; }
		res.json({ success: true, branch });
		void broadcastBranchChange(dir);
	});

	router.post("/git/branches", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const name = typeof req.body?.name === "string" ? req.body.name : "";
		const startPoint = typeof req.body?.startPoint === "string" ? req.body.startPoint : undefined;
		if (!name) { res.status(400).json({ error: "name is required" }); return; }
		const args = ["branch", name];
		if (startPoint) args.push(startPoint);
		const r = await gitFull(dir, args);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "create branch failed" }); return; }
		res.json({ success: true, branch: name });
	});

	router.put("/git/branches/rename", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const oldName = typeof req.body?.oldName === "string" ? req.body.oldName : "";
		const newName = typeof req.body?.newName === "string" ? req.body.newName : "";
		if (!oldName || !newName) { res.status(400).json({ error: "oldName and newName are required" }); return; }
		const r = await gitFull(dir, ["branch", "-m", oldName, newName]);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "rename branch failed" }); return; }
		res.json({ success: true, branch: newName });
		void broadcastBranchChange(dir);
	});

	router.delete("/git/branches", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const name = typeof req.body?.name === "string" ? req.body.name : "";
		const force = req.body?.force === true;
		if (!name) { res.status(400).json({ error: "name is required" }); return; }
		const args = ["branch", force ? "-D" : "-d", name];
		const r = await gitFull(dir, args);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "delete branch failed" }); return; }
		res.json({ success: true });
	});

	// ===== merge / rebase =====

	router.post("/git/merge", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
		if (!branch) { res.status(400).json({ error: "branch is required" }); return; }
		if (!isSafeRef(branch)) { res.status(400).json({ error: "invalid branch" }); return; }
		const r = await gitFull(dir, ["merge", branch]);
		const conflict = r.code !== 0;
		const conflictFiles = conflict ? await getConflictFiles(dir) : [];
		res.json({ success: !conflict, conflict, conflictFiles });
	});

	router.post("/git/merge/abort", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const r = await gitFull(dir, ["merge", "--abort"]);
		res.json({ success: r.code === 0 });
	});

	router.post("/git/merge/continue", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const r = await gitFull(dir, ["merge", "--continue"]);
		const conflict = r.code !== 0;
		res.json({ success: !conflict, conflict, conflictFiles: conflict ? await getConflictFiles(dir) : [] });
	});

	router.post("/git/rebase", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const onto = typeof req.body?.onto === "string" ? req.body.onto : "";
		if (!onto) { res.status(400).json({ error: "onto is required" }); return; }
		if (!isSafeRef(onto)) { res.status(400).json({ error: "invalid onto" }); return; }
		const r = await gitFull(dir, ["rebase", onto]);
		const conflict = r.code !== 0;
		res.json({ success: !conflict, conflict, conflictFiles: conflict ? await getConflictFiles(dir) : [] });
	});

	router.post("/git/rebase/abort", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const r = await gitFull(dir, ["rebase", "--abort"]);
		res.json({ success: r.code === 0 });
	});

	router.post("/git/rebase/continue", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const r = await gitFull(dir, ["rebase", "--continue"]);
		const conflict = r.code !== 0;
		res.json({ success: !conflict, conflict, conflictFiles: conflict ? await getConflictFiles(dir) : [] });
	});

	// ===== commit operations =====

	router.post("/git/checkout-commit", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const hash = typeof req.body?.hash === "string" ? req.body.hash : "";
		if (!hash) { res.status(400).json({ error: "hash is required" }); return; }
		if (!isSafeRef(hash)) { res.status(400).json({ error: "invalid hash" }); return; }
		const r = await gitFull(dir, ["checkout", hash]);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "checkout failed" }); return; }
		res.json({ success: true, hash, detached: true });
		void broadcastBranchChange(dir);
	});

	router.post("/git/cherry-pick", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const hash = typeof req.body?.hash === "string" ? req.body.hash : "";
		if (!hash) { res.status(400).json({ error: "hash is required" }); return; }
		if (!isSafeRef(hash)) { res.status(400).json({ error: "invalid hash" }); return; }
		const r = await gitFull(dir, ["cherry-pick", hash]);
		res.json({ success: r.code === 0, conflict: r.code !== 0, conflictFiles: r.code !== 0 ? await getConflictFiles(dir) : [] });
	});

	router.post("/git/revert-commit", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const hash = typeof req.body?.hash === "string" ? req.body.hash : "";
		if (!hash) { res.status(400).json({ error: "hash is required" }); return; }
		if (!isSafeRef(hash)) { res.status(400).json({ error: "invalid hash" }); return; }
		const r = await gitFull(dir, ["revert", "--no-edit", hash]);
		res.json({ success: r.code === 0, conflict: r.code !== 0, conflictFiles: r.code !== 0 ? await getConflictFiles(dir) : [] });
	});

	router.post("/git/reset-to-commit", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const hash = typeof req.body?.hash === "string" ? req.body.hash : "";
		const mode = req.body?.mode === "hard" || req.body?.mode === "soft" ? req.body.mode : "mixed";
		if (!hash) { res.status(400).json({ error: "hash is required" }); return; }
		if (!isSafeRef(hash)) { res.status(400).json({ error: "invalid hash" }); return; }
		const r = await gitFull(dir, ["reset", `--${mode}`, hash]);
		res.json({ success: r.code === 0, hash, mode });
	});

	router.post("/git/revert", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const filePath = typeof req.body?.path === "string" ? req.body.path : "";
		const scope = req.body?.scope === "working" ? "working" : "all";
		if (!filePath) { res.status(400).json({ error: "path is required" }); return; }
		const args = scope === "working" ? ["checkout", "--", filePath] : ["checkout", "HEAD", "--", filePath];
		const r = await gitFull(dir, args);
		if (r.code !== 0) { res.status(500).json({ error: r.stderr || "revert failed" }); return; }
		res.json({ success: true });
	});

	// ===== push / pull / fetch =====

	router.post("/git/push", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const remote = typeof req.body?.remote === "string" ? req.body.remote : "";
		const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
		if (remote && !isSafeRef(remote)) { res.status(400).json({ error: "invalid remote" }); return; }
		if (branch && !isSafeRef(branch)) { res.status(400).json({ error: "invalid branch" }); return; }
		const args = ["push"];
		if (remote) args.push(remote);
		if (branch) args.push(branch);
		const r = await gitFull(dir, args);
		const currentBranch = ((await git(dir, ["branch", "--show-current"])) ?? "").trim();
		const pushed = r.code === 0 && currentBranch
			? [{ local: currentBranch, remote: `${remote || "origin"}/${branch || currentBranch}` }]
			: [];
		res.json({ success: r.code === 0, pushed, repo: "", ref: (r.stdout ?? "").trim() || null });
	});

	router.post("/git/pull", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const remote = typeof req.body?.remote === "string" ? req.body.remote : "";
		const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
		if (remote && !isSafeRef(remote)) { res.status(400).json({ error: "invalid remote" }); return; }
		if (branch && !isSafeRef(branch)) { res.status(400).json({ error: "invalid branch" }); return; }
		const rebase = req.body?.rebase === true;
		const args = ["pull"];
		if (rebase) args.push("--rebase");
		if (remote) args.push(remote);
		if (branch) args.push(branch);
		const r = await gitFull(dir, args);
		const files = r.code === 0
			? ((await git(dir, ["diff", "--name-only", "ORIG_HEAD", "HEAD"])) ?? "").split("\n").filter(Boolean)
			: [];
		const shortstat = r.code === 0
			? ((await git(dir, ["diff", "--shortstat", "ORIG_HEAD", "HEAD"])) ?? "")
			: "";
		const stat = parseShortstat(shortstat);
		res.json({ success: r.code === 0, summary: { changes: files.length, insertions: stat.insertions, deletions: stat.deletions }, files, insertions: stat.insertions, deletions: stat.deletions });
	});

	router.post("/git/fetch", async (req: Request, res: Response) => {
		const dir = dirOf(req, defaultCwd);
		const remote = typeof req.body?.remote === "string" ? req.body.remote : "";
		const branch = typeof req.body?.branch === "string" ? req.body.branch : "";
		if (remote && !isSafeRef(remote)) { res.status(400).json({ error: "invalid remote" }); return; }
		if (branch && !isSafeRef(branch)) { res.status(400).json({ error: "invalid branch" }); return; }
		const args = ["fetch"];
		if (remote) args.push(remote);
		if (branch) args.push(branch);
		const r = await gitFull(dir, args);
		res.json({ success: r.code === 0 });
	});

	// ===== LLM generation (commit message / PR description) =====

	router.post("/git/commit-message", async (req: Request, res: Response) => {
		if (!generateText) { res.status(501).json({ error: "LLM generation unavailable" }); return; }
		const dir = dirOf(req, defaultCwd);
		const files = Array.isArray(req.body?.files) ? (req.body.files as string[]) : [];
		if (files.length === 0) { res.status(400).json({ error: "files is required" }); return; }
		const diff =
			(await git(dir, ["diff", "--cached", "--", ...files])) ??
			(await git(dir, ["diff", "--", ...files])) ??
			"";
		const text = await generateText(
			`Write a concise conventional-commit message for the staged changes below. First line = subject (type: summary), then blank line, then bullet highlights.\n\n${diff}`,
			"You generate git commit messages. Output subject then highlights only.",
		);
		const lines = text.trim().split("\n").map((l) => l.trim()).filter(Boolean);
		const subject = (lines[0] ?? "").replace(/^[-*]\s*/, "");
		const highlights = lines.slice(1).map((l) => l.replace(/^[-*]\s*/, "")).filter(Boolean);
		res.json({ message: { subject, highlights } });
	});

	router.post("/git/pr-description", async (req: Request, res: Response) => {
		if (!generateText) { res.status(501).json({ error: "LLM generation unavailable" }); return; }
		const dir = dirOf(req, defaultCwd);
		const base = typeof req.body?.base === "string" ? req.body.base : "";
		const head = typeof req.body?.head === "string" ? req.body.head : "";
		const context = typeof req.body?.context === "string" ? req.body.context : "";
		const diff = base && head ? ((await git(dir, ["diff", `${base}...${head}`])) ?? "") : "";
		const text = await generateText(
			`Write a pull request title and description for these changes (base=${base}, head=${head}). First line = title, then blank line, then description.${context ? `\n\nContext: ${context}` : ""}${diff ? `\n\nDiff:\n${diff}` : ""}`,
			"You write pull request titles and descriptions. Output title then body only.",
		);
		const idx = text.indexOf("\n");
		const title = idx >= 0 ? text.slice(0, idx).trim() : text.trim();
		const body = idx >= 0 ? text.slice(idx + 1).trim() : "";
		res.json({ title, body });
	});

	app.use("/api", router);
}
