#!/usr/bin/env bun
"use strict";

/** Run the P0 UI E2E cases in isolated subprocesses and summarize. */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const casesDir = path.join(__dirname, "cases");
const only = process.argv.slice(2).filter((a) => a.startsWith("p0-"));

const all = fs
	.readdirSync(casesDir)
	.filter((f) => f.endsWith(".cjs"))
	.map((f) => f.replace(/\.cjs$/, ""))
	.sort();
const selected = only.length ? only : all;

const results = [];
for (const id of selected) {
	const script = path.join(casesDir, `${id}.cjs`);
	if (!fs.existsSync(script)) {
		results.push({ id, status: "skipped", reason: "missing case file" });
		continue;
	}
	const started = Date.now();
	const result = spawnSync("bun", [script], {
		stdio: "inherit",
		timeout: 180_000,
	});
	const durationMs = Date.now() - started;
	results.push({
		id,
		status: result.status === 0 ? "passed" : "failed",
		durationMs,
		exitCode: result.status,
		error: result.error?.message,
	});
}

const passed = results.filter((r) => r.status === "passed");
const failed = results.filter((r) => r.status !== "passed");
console.log("\n=== P0 UI E2E summary ===");
for (const r of results)
	console.log(
		`${r.status.padEnd(8)} ${r.id}${r.durationMs ? ` (${r.durationMs}ms)` : ""}${r.error ? ` — ${r.error}` : ""}`,
	);
console.log(
	`\n${passed.length} passed, ${failed.length} failed, ${results.length} total`,
);
process.exit(failed.length ? 1 : 0);
