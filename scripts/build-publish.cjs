#!/usr/bin/env node
/**
 * Build the publishable `@molicherry/pichamber` distributable into `dist/`.
 *
 * The workspace is TypeScript-source-only (runs via tsx/bun); this script
 * assembles a self-contained npm package:
 *
 *   dist/
 *     package.json   publish manifest (name @molicherry/pichamber, bin/main/files)
 *     bin/cli.js     entry — defaults UI_DIST to the bundled UI, then boots the server
 *     server/        bundled web + agent (pi SDK / express / ws / node-pty stay external)
 *     ui/            vite build of packages/ui (served by the web server)
 *     LICENSE        MIT
 *     README.md
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
process.chdir(root);

const sh = (cmd) => {
	console.log(`+ ${cmd}`);
	try {
		execSync(cmd, { stdio: "inherit" });
	} catch (err) {
		throw new Error(
			`command failed: ${cmd}\n${err && err.message ? err.message : err}`,
		);
	}
};

const readJson = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		throw new Error(
			`failed to read/parse ${file}: ${err && err.message ? err.message : err}`,
		);
	}
};

// 1. Build the UI (vite → packages/ui/dist).
sh("bun run --filter @pichamber/ui build");

// 2. Bundle web + agent into dist/server/index.js.
//    Runtime deps are kept external so they resolve from node_modules at
//    install time (node-pty is a native module and cannot be bundled).
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync(path.join("dist", "server"), { recursive: true });
fs.mkdirSync(path.join("dist", "bin"), { recursive: true });
sh(
	[
		"bun build packages/web/src/index.ts",
		"--target=node",
		"--format=esm",
		"--outdir=dist/server",
		"--external @earendil-works/pi-coding-agent",
		"--external typebox",
		"--external express",
		"--external cors",
		"--external ws",
		"--external node-pty",
	].join(" "),
);

// 3. Copy UI build + license + readme.
fs.cpSync(path.join("packages", "ui", "dist"), path.join("dist", "ui"), {
	recursive: true,
});
if (fs.existsSync("LICENSE.pi")) {
	fs.copyFileSync("LICENSE.pi", path.join("dist", "LICENSE"));
}
if (fs.existsSync("README.md")) {
	fs.copyFileSync("README.md", path.join("dist", "README.md"));
}

// 4. CLI entry: pin the bundled UI as the default UI_DIST, then boot.
fs.writeFileSync(
	path.join("dist", "bin", "cli.js"),
	[
		"#!/usr/bin/env node",
		'import path from "node:path";',
		'import { fileURLToPath } from "node:url";',
		"const here = path.dirname(fileURLToPath(import.meta.url));",
		'process.env.UI_DIST ??= path.resolve(here, "../ui");',
		'await import("../server/index.js");',
		"",
	].join("\n"),
);

// 5. Write the publish manifest, pulling runtime deps from the workspace so
//    they can't drift. `@pichamber/agent` is bundled in, so it is dropped.
const web = readJson(path.join("packages", "web", "package.json"));
const agent = readJson(path.join("packages", "agent", "package.json"));

const dependencies = {};
for (const [name, version] of Object.entries(agent.dependencies ?? {})) {
	dependencies[name] = version;
}
for (const [name, version] of Object.entries(web.dependencies ?? {})) {
	if (name === "@pichamber/agent") continue; // bundled into server/index.js
	dependencies[name] = version;
}

const manifest = {
	name: "@molicherry/pichamber",
	version: web.version,
	description:
		"pichamber — pi coding agent web workspace (opencode-compatible HTTP + SSE + built UI)",
	license: "MIT",
	type: "module",
	bin: { pichamber: "bin/cli.js" },
	main: "server/index.js",
	files: ["bin", "server", "ui", "LICENSE", "README.md"],
	engines: { node: ">=22.0.0" },
	repository: {
		type: "git",
		url: "git+https://github.com/molicherry/pichamber.git",
	},
	dependencies,
};

fs.writeFileSync(
	path.join("dist", "package.json"),
	JSON.stringify(manifest, null, 2) + "\n",
);

console.log("Built dist/: " + fs.readdirSync("dist").join(", "));
