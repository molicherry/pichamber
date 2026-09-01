"use strict";

const { describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
	assertScenarioPrerequisites,
	gitIdentity,
	packageIdentity,
	resolveBrowserExecutable,
	sanitizedChildEnvironment,
	secretValues,
} = require("./environment.cjs");

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

describe("release environment", () => {
	it("uses packages/web/package.json as the independent publish version", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pichamber-package-identity-"),
		);
		try {
			writeJson(path.join(root, "package.json"), {
				name: "root",
				version: "9.0.0",
			});
			writeJson(path.join(root, "packages/agent/package.json"), {
				name: "agent",
				version: "1.0.0",
			});
			writeJson(path.join(root, "packages/ui/package.json"), {
				name: "ui",
				version: "2.0.0",
			});
			writeJson(path.join(root, "packages/web/package.json"), {
				name: "web",
				version: "0.1.2-rc.2",
			});
			const identity = packageIdentity(root);
			expect(identity.version).toBe("0.1.2-rc.2");
			expect(identity.publishPackage).toEqual({
				file: "packages/web/package.json",
				name: "web",
				version: "0.1.2-rc.2",
			});
			expect(identity.versions["package.json"]).toBe("9.0.0");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes secret/token/API-key environment variables but keeps ordinary values", () => {
		const source = {
			PATH: "/bin",
			RELEASE_TOKEN: "token-value",
			PROVIDER_API_KEY: "api-key-value",
			DB_PASSWORD: "password-value",
			AWS_SECRET_ACCESS_KEY: "secret-value",
			NORMAL_SETTING: "kept",
		};
		expect(sanitizedChildEnvironment(source)).toEqual({
			PATH: "/bin",
			NORMAL_SETTING: "kept",
		});
		expect(secretValues(source)).toEqual(
			expect.arrayContaining([
				"token-value",
				"api-key-value",
				"password-value",
				"secret-value",
			]),
		);
	});

	it("resolves an explicit local browser executable for the full gate", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pichamber-browser-executable-"),
		);
		try {
			const executable = path.join(root, "chromium");
			fs.writeFileSync(executable, "fixture");
			expect(
				resolveBrowserExecutable(root, {
					PICAMBER_RELEASE_BROWSER_EXECUTABLE: executable,
				}),
			).toBe(executable);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a dirty worktree", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pichamber-dirty-worktree-"),
		);
		try {
			writeJson(path.join(root, "tracked.json"), { clean: true });
			execFileSync("git", ["init", "-q", root]);
			execFileSync("git", ["-C", root, "config", "user.name", "Release Test"]);
			execFileSync("git", [
				"-C",
				root,
				"config",
				"user.email",
				"release@example.invalid",
			]);
			execFileSync("git", ["-C", root, "add", "tracked.json"]);
			execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
			expect(gitIdentity(root).clean).toBe(true);
			writeJson(path.join(root, "tracked.json"), { clean: false });
			expect(() => gitIdentity(root)).toThrow("worktree is dirty");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails closed when a required prerequisite or platform is unavailable", () => {
		const currentPlatform = `${process.platform}-${process.arch}`;
		const scenarios = [
			{
				id: "required",
				required: true,
				platforms: [currentPlatform],
				prerequisites: ["env:THIS_MUST_NOT_EXIST"],
			},
		];
		expect(() => assertScenarioPrerequisites(scenarios, {})).toThrow(
			"required scenario prerequisites are not satisfied",
		);

		const wrongPlatform = [
			{
				id: "wrong-platform",
				required: true,
				platforms: ["not-this-platform"],
				prerequisites: [],
			},
		];
		expect(() =>
			assertScenarioPrerequisites(wrongPlatform, {}, currentPlatform),
		).toThrow(`platform ${currentPlatform} is unsupported`);
	});
});
