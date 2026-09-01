#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { sanitizedChildEnvironment } = require("../environment.cjs");

const files = [
	"packages/ui/src/sync/__tests__/event-pipeline.test.js",
	"packages/ui/src/lib/runtime-fetch.test.ts",
	"packages/ui/src/lib/router/serializeRoute.test.ts",
	"packages/ui/src/components/auth/SessionAuthGate.test.ts",
];

for (const file of files) {
	const result = spawnSync("bun", ["test", file], {
		cwd: process.cwd(),
		stdio: "inherit",
		env: sanitizedChildEnvironment(process.env),
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`stable UI test group failed: ${file} (exit ${result.status})`,
		);
	}
}

process.stdout.write(
	`stable isolated UI contract groups passed (${files.length} files)\n`,
);
