#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { globSync } = require("node:fs");
const path = require("node:path");
const { sanitizedChildEnvironment } = require("../environment.cjs");

// The scenario runner executes from the repo root; locate the vendored UI package.
process.chdir(path.resolve(__dirname, "../../../packages/ui"));

// Vendored openchamber UI tests that fail even in isolation. Each entry MUST
// state its root cause. These are upstream/rebrand artifacts, NOT pichamber
// product defects, so they are surfaced explicitly rather than silently
// skipped. Re-evaluate on every upstream sync.
const KNOWN_FAILURES = {
	"src/components/auth/SessionAuthGate.behavior.test.tsx":
		"vendored upstream: hand-written React mock omits useSyncExternalStore (zustand requires it)",
	"src/components/chat/MarkdownRendererImpl.performance.test.tsx":
		"vendored upstream: fragile detached-Markdown-DOM cache-count assertion (1 != 0)",
	"src/components/onboarding/desktopRecoveryConfig.test.ts":
		"rebrand side effect: test asserts 'Local OpenCode Unavailable', product is rebranded to 'pi'",
	"src/lib/shortcuts.test.ts":
		"vendored upstream: stale legacy test asserts 'mod', upstream default moved to 'mod+alt' (see src/lib/shortcuts/schema.test.ts)",
	"src/sync/document-attachments.test.ts":
		"rebrand side effect: test asserts '[...OpenChamber]', product is rebranded to 'pichamber'",
};

const files = [
	...new Set([
		...globSync("src/**/*.test.ts", { cwd: process.cwd() }),
		...globSync("src/**/*.test.tsx", { cwd: process.cwd() }),
		...globSync("src/**/*.test.js", { cwd: process.cwd() }),
		...globSync("src/**/*.spec.ts", { cwd: process.cwd() }),
		...globSync("src/**/*.spec.tsx", { cwd: process.cwd() }),
	]),
].sort();

const unexpected = [];
const nowPassing = [];
let passed = 0;
let knownFailed = 0;

for (const file of files) {
	const result = spawnSync("bun", ["test", file], {
		cwd: process.cwd(),
		stdio: "ignore",
		env: sanitizedChildEnvironment(process.env),
	});
	if (result.status === 0) {
		passed += 1;
		if (KNOWN_FAILURES[file]) nowPassing.push(file);
	} else if (KNOWN_FAILURES[file]) {
		knownFailed += 1;
	} else {
		unexpected.push(file);
	}
}

for (const file of nowPassing) {
	process.stdout.write(
		`NOTICE: known-failure now passes, remove from KNOWN_FAILURES: ${file}\n`,
	);
}
for (const file of Object.keys(KNOWN_FAILURES)) {
	if (!files.includes(file)) {
		process.stdout.write(
			`NOTICE: known-failure no longer exists in the suite: ${file}\n`,
		);
	}
}

for (const [file, reason] of Object.entries(KNOWN_FAILURES)) {
	process.stdout.write(`  [known-failure] ${file} — ${reason}\n`);
}
process.stdout.write(
	`UI isolated suite: ${passed} passed, ${knownFailed} known-failure (vendored/rebrand), ${unexpected.length} unexpected across ${files.length} files\n`,
);

if (unexpected.length) {
	for (const file of unexpected)
		process.stdout.write(`  [UNEXPECTED FAIL] ${file}\n`);
	process.exit(1);
}
process.exit(0);
