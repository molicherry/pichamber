#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function command(command, args, cwd) {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
function git(args, cwd = process.cwd()) {
	return command("git", args, cwd);
}
function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function packageIdentity(root = process.cwd()) {
	const files = [
		"package.json",
		"packages/agent/package.json",
		"packages/ui/package.json",
		"packages/web/package.json",
	];
	const manifests = Object.fromEntries(
		files.map((file) => [file, readJson(path.join(root, file))]),
	);
	const versions = Object.fromEntries(
		files.map((file) => [file, manifests[file].version]),
	);
	const publishFile = "packages/web/package.json";
	const publishManifest = manifests[publishFile];
	if (
		!publishManifest ||
		typeof publishManifest.version !== "string" ||
		!publishManifest.version.trim()
	) {
		throw new Error(`${publishFile} must declare the publish version`);
	}
	return {
		version: publishManifest.version,
		publishPackage: {
			file: publishFile,
			name: publishManifest.name,
			version: publishManifest.version,
		},
		versions,
	};
}

function gitIdentity(root = process.cwd(), { requireClean = true } = {}) {
	const head = git(["rev-parse", "HEAD"], root);
	const tree = git(["rev-parse", "HEAD^{tree}"], root);
	const status = git(["status", "--porcelain", "--untracked-files=all"], root);
	const clean = status.length === 0;
	if (requireClean && !clean) throw new Error(`worktree is dirty:\n${status}`);
	return { head, tree, clean, status };
}

function toolchains() {
	const node = process.version;
	const nodeMajor = Number(node.slice(1).split(".")[0]);
	if (!Number.isInteger(nodeMajor) || nodeMajor < 22)
		throw new Error(`Node 22+ is required; found ${node}`);
	const bun = command("bun", ["--version"]);
	if (bun !== "1.4.0") throw new Error(`Bun 1.4.0 is required; found ${bun}`);
	return {
		node,
		nodeMajor,
		minimumNodeProven: nodeMajor === 22,
		bun,
		npm: command("npm", ["--version"]),
		platform: process.platform,
		arch: process.arch,
	};
}

function evaluatePrerequisite(prerequisite, env = process.env) {
	if (prerequisite === "node>=22")
		return {
			ok: Number(process.versions.node.split(".")[0]) >= 22,
			detail: process.version,
		};
	if (prerequisite === "bun=1.4.0") {
		try {
			const version = command("bun", ["--version"]);
			return { ok: version === "1.4.0", detail: version };
		} catch (error) {
			return { ok: false, detail: error.message };
		}
	}
	if (prerequisite === "git") {
		try {
			return {
				ok: Boolean(command("git", ["--version"])),
				detail: "git available",
			};
		} catch (error) {
			return { ok: false, detail: error.message };
		}
	}
	if (prerequisite === "linux-x64")
		return {
			ok: process.platform === "linux" && process.arch === "x64",
			detail: `${process.platform}-${process.arch}`,
		};
	const [kind, value] = prerequisite.split(":", 2);
	if (kind === "env")
		return {
			ok: Boolean(env[value]),
			detail: env[value] ? `${value} set` : `${value} is not set`,
		};
	if (kind === "command") {
		try {
			command("sh", ["-c", `command -v -- "$1"`, "sh", value]);
			return { ok: true, detail: `${value} available` };
		} catch {
			return { ok: false, detail: `${value} unavailable` };
		}
	}
	return { ok: false, detail: `unknown prerequisite ${prerequisite}` };
}

function assertScenarioPrerequisites(
	scenarios,
	env = process.env,
	platform = `${process.platform}-${process.arch}`,
) {
	const failures = [];
	for (const scenario of scenarios) {
		if (!scenario.platforms.includes(platform)) {
			if (scenario.required)
				failures.push(
					`${scenario.id}: platform ${platform} is unsupported (expected ${scenario.platforms.join(", ")})`,
				);
			continue;
		}
		for (const prerequisite of scenario.prerequisites) {
			const result = evaluatePrerequisite(prerequisite, env);
			if (!result.ok && scenario.required)
				failures.push(`${scenario.id}: ${prerequisite} (${result.detail})`);
		}
	}
	if (failures.length)
		throw new Error(
			`required scenario prerequisites are not satisfied:\n${failures.join("\n")}`,
		);
}

const SECRET_ENV_NAME =
	/(?:^|_)(?:token|secret|password|credential|api_?key|auth)(?:$|_)/i;
function sanitizedChildEnvironment(source = process.env, overrides = {}) {
	const clean = {};
	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined && !SECRET_ENV_NAME.test(key)) clean[key] = value;
	}
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete clean[key];
		else clean[key] = value;
	}
	return clean;
}

function secretValues(source = process.env) {
	return Object.entries(source)
		.filter(
			([key, value]) =>
				SECRET_ENV_NAME.test(key) &&
				typeof value === "string" &&
				value.length >= 4,
		)
		.map(([, value]) => value)
		.sort((a, b) => b.length - a.length);
}

function resolveBrowserExecutable(root = process.cwd(), env = process.env) {
	const explicit = env.PICAMBER_RELEASE_BROWSER_EXECUTABLE;
	if (typeof explicit === "string" && explicit && fs.existsSync(explicit))
		return path.resolve(explicit);
	try {
		const entry = require.resolve("playwright", { paths: [root] });
		const { chromium } = require(entry);
		const executable = chromium.executablePath();
		return executable && fs.existsSync(executable) ? executable : undefined;
	} catch {
		return undefined;
	}
}

function createRunDirectory(prefix = "pichamber-release-") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const dirs = {};
	for (const name of ["home", "workspace", "agent", "logs", "install"]) {
		dirs[name] = path.join(root, name);
		fs.mkdirSync(dirs[name], { recursive: true });
	}
	return { root, ...dirs };
}

module.exports = {
	gitIdentity,
	packageIdentity,
	toolchains,
	evaluatePrerequisite,
	assertScenarioPrerequisites,
	sanitizedChildEnvironment,
	secretValues,
	resolveBrowserExecutable,
	createRunDirectory,
};
