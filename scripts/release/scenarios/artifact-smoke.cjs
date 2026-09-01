#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
	installTarball,
	startInstalledCli,
	stopChild,
} = require("../artifact.cjs");

async function main() {
	const tarball = process.env.PICAMBER_QUALIFIED_TARBALL;
	const runRoot = process.env.PICAMBER_SCENARIO_ROOT;
	if (!tarball || !runRoot)
		throw new Error(
			"artifact smoke requires PICAMBER_QUALIFIED_TARBALL and PICAMBER_SCENARIO_ROOT",
		);
	const install = path.join(runRoot, "artifact-smoke-install");
	const state = {
		home: path.join(runRoot, "artifact-home"),
		agent: path.join(runRoot, "artifact-agent"),
		workspace: path.join(runRoot, "artifact-workspace"),
	};
	Object.values(state).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
	const cli = installTarball(tarball, install);
	const evidenceRoot = process.env.PICAMBER_RELEASE_EVIDENCE_ROOT;
	const log = evidenceRoot
		? path.join(
				evidenceRoot,
				"logs",
				"artifact.clean-install-runtime.server.log",
			)
		: path.join(runRoot, "artifact-server.log");
	const first = await startInstalledCli(cli, state, log);
	try {
		const auth = await fetch(`${first.baseUrl}/auth/session`);
		if (!auth.ok || (await auth.json()).authenticated !== true)
			throw new Error("installed CLI open-mode auth bootstrap failed");
		const unknown = await fetch(
			`${first.baseUrl}/api/release-qualification-unknown`,
		);
		if (unknown.status !== 404)
			throw new Error(`unknown route returned ${unknown.status}, expected 404`);
	} finally {
		await stopChild(first);
	}
	const second = await startInstalledCli(cli, state, log);
	try {
		const health = await fetch(`${second.baseUrl}/api/opencode/health`);
		if (!health.ok || (await health.json()).healthy !== true)
			throw new Error("installed CLI failed health check after restart");
	} finally {
		await stopChild(second);
	}
	console.log(
		"packed artifact clean-install/start/auth/unknown-route/restart smoke passed",
	);
}
main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
