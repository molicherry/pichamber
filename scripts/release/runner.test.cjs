"use strict";

const { describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sanitizedChildEnvironment } = require("./environment.cjs");
const {
	assertRequiredPassed,
	runProcess,
	runScenarios,
} = require("./runner.cjs");

function scenario(overrides = {}) {
	return {
		id: "scenario",
		command: [process.execPath, "-e", "process.exit(0)"],
		required: true,
		prerequisites: [],
		platforms: [`${process.platform}-${process.arch}`],
		timeoutMs: 5000,
		stage: "source",
		...overrides,
	};
}

describe("release scenario runner", () => {
	it("reports and rejects required failures, skips, and not-executed scenarios", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-runner-"));
		try {
			const failedScenario = scenario({
				id: "failed",
				command: [process.execPath, "-e", "process.exit(7)"],
			});
			const skippedScenario = scenario({
				id: "skipped",
				prerequisites: ["env:UNAVAILABLE_RELEASE_TEST_VALUE"],
			});
			const unsupportedScenario = scenario({
				id: "unsupported",
				platforms: ["not-this-platform"],
			});
			const results = await runScenarios(
				[failedScenario, skippedScenario, unsupportedScenario],
				{
					cwd: root,
					env: {},
					logDir: path.join(root, "logs"),
					evidenceRoot: root,
				},
			);
			expect(results.map((result) => [result.id, result.status])).toEqual([
				["failed", "failed"],
				["skipped", "skipped"],
				["unsupported", "unsupported"],
			]);
			expect(() =>
				assertRequiredPassed(results, [
					failedScenario,
					skippedScenario,
					unsupportedScenario,
				]),
			).toThrow(/failed.*skipped.*unsupported/s);
			expect(() =>
				assertRequiredPassed([], [scenario({ id: "missing" })]),
			).toThrow("not executed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not inherit named secrets and redacts known secret values from logs", async () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pichamber-runner-redaction-"),
		);
		try {
			const secret = "release-secret-value-123";
			const source = {
				PATH: process.env.PATH,
				RELEASE_API_KEY: secret,
				LEAK_VALUE: secret,
			};
			const env = sanitizedChildEnvironment(source);
			expect(env.RELEASE_API_KEY).toBeUndefined();
			const logFile = path.join(root, "redacted.log");
			const result = await runProcess(
				[
					process.execPath,
					"-e",
					'process.stdout.write(`${process.env.RELEASE_API_KEY || "not-inherited"}:${process.env.LEAK_VALUE}`)',
				],
				{ cwd: root, env, timeoutMs: 5000, logFile, redactValues: [secret] },
			);
			expect(result.code).toBe(0);
			const log = fs.readFileSync(logFile, "utf8");
			expect(log).toContain("not-inherited:[REDACTED]");
			expect(log).not.toContain(secret);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
