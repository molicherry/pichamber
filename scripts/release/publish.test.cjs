"use strict";

const { describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
	EVIDENCE_VALIDITY_MS,
	sha256File,
	writeEvidenceAtomic,
} = require("./evidence.cjs");
const { gitIdentity } = require("./environment.cjs");
const { readManifest } = require("./manifest.cjs");
const { hashDirectory } = require("./qualify.cjs");
const { fingerprint } = require("./runner.cjs");
const { publish, validatePublish } = require("./publish.cjs");

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function manifestFixture() {
	return {
		schemaVersion: 1,
		profiles: ["ci", "full"],
		supportedMatrix: {
			platforms: ["linux-x64"],
			node: "22.x",
			bun: "1.4.0",
			surfaces: ["fixture"],
			unsupportedPlatforms: [],
			unsupportedSurfaces: [],
		},
		capabilities: [
			{ id: "fixture", status: "supported", description: "fixture capability" },
		],
		scenarios: [
			{
				id: "fixture.pass",
				description: "fixture scenario",
				command: [process.execPath, "-e", "process.exit(0)"],
				profiles: ["ci", "full"],
				required: true,
				tags: ["fixture"],
				prerequisites: [],
				platforms: ["linux-x64"],
				timeoutMs: 1000,
				stage: "source",
				capabilities: ["fixture"],
				passCriteria: "exits zero",
			},
		],
	};
}

function createFixture() {
	const base = fs.mkdtempSync(
		path.join(os.tmpdir(), "pichamber-publish-test-"),
	);
	const root = path.join(base, "repo");
	fs.mkdirSync(root);
	writeJson(path.join(root, "package.json"), {
		name: "root",
		version: "9.0.0",
		private: true,
	});
	writeJson(path.join(root, "packages/agent/package.json"), {
		name: "agent",
		version: "1.0.0",
		private: true,
	});
	writeJson(path.join(root, "packages/ui/package.json"), {
		name: "ui",
		version: "2.0.0",
		private: true,
	});
	writeJson(path.join(root, "packages/web/package.json"), {
		name: "web",
		version: "0.1.2-rc.2",
		private: true,
	});
	writeJson(path.join(root, "release-scenarios.json"), manifestFixture());
	fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
	const dist = path.join(root, "dist");
	fs.mkdirSync(dist);
	fs.writeFileSync(path.join(dist, "payload.txt"), "qualified-dist");
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "config", "user.name", "Release Test"]);
	execFileSync("git", [
		"-C",
		root,
		"config",
		"user.email",
		"release@example.invalid",
	]);
	execFileSync("git", ["-C", root, "add", "."]);
	execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);

	const artifactPath = path.join(base, "pichamber.tgz");
	fs.writeFileSync(artifactPath, "qualified-artifact");
	const evidenceFile = path.join(base, "qualification.json");

	function evidence(overrides = {}) {
		const git = gitIdentity(root);
		const manifest = readManifest(path.join(root, "release-scenarios.json"));
		const artifactSha256 = sha256File(artifactPath);
		return {
			schemaVersion: 1,
			validityMs: EVIDENCE_VALIDITY_MS,
			result: "passed",
			completedAt: new Date().toISOString(),
			version: "0.1.2-rc.2",
			gitHead: git.head,
			gitTree: git.tree,
			manifestHash: manifest.hash,
			artifactSha256,
			artifact: {
				path: artifactPath,
				sha256: artifactSha256,
				distSha256: hashDirectory(dist),
			},
			scenarios: [
				{
					id: "fixture.pass",
					required: true,
					status: "passed",
					commandFingerprint: fingerprint(
						manifestFixture().scenarios[0].command,
					),
				},
			],
			redaction: {
				credentialsPersisted: false,
				conversationContentPersisted: false,
				localOnly: true,
			},
			...overrides,
		};
	}

	function writeEvidence(value = evidence()) {
		writeEvidenceAtomic(evidenceFile, value);
	}

	writeEvidence();
	return {
		base,
		root,
		dist,
		artifactPath,
		evidenceFile,
		evidence,
		writeEvidence,
	};
}

function cleanup(fixture) {
	fs.rmSync(fixture.base, { recursive: true, force: true });
}

describe("publish validation", () => {
	it("accepts valid evidence and derives prerelease/stable tags without rebuilding", () => {
		const fixture = createFixture();
		try {
			const plan = validatePublish(fixture.root, fixture.evidenceFile);
			expect(plan.artifactPath).toBe(fixture.artifactPath);
			expect(plan.tag).toBe("next");
		} finally {
			cleanup(fixture);
		}
	});

	it("rejects stale identity, changed manifest, and changed or missing artifacts", () => {
		const stale = createFixture();
		try {
			stale.writeEvidence(stale.evidence({ gitTree: "stale-tree" }));
			expect(() => validatePublish(stale.root, stale.evidenceFile)).toThrow(
				"gitTree mismatch",
			);
		} finally {
			cleanup(stale);
		}

		const changedManifest = createFixture();
		try {
			const oldEvidence = changedManifest.evidence();
			fs.appendFileSync(
				path.join(changedManifest.root, "release-scenarios.json"),
				"\n",
			);
			execFileSync("git", [
				"-C",
				changedManifest.root,
				"add",
				"release-scenarios.json",
			]);
			execFileSync("git", [
				"-C",
				changedManifest.root,
				"commit",
				"-qm",
				"change manifest",
			]);
			const current = gitIdentity(changedManifest.root);
			changedManifest.writeEvidence({
				...oldEvidence,
				gitHead: current.head,
				gitTree: current.tree,
			});
			expect(() =>
				validatePublish(changedManifest.root, changedManifest.evidenceFile),
			).toThrow("manifestHash mismatch");
		} finally {
			cleanup(changedManifest);
		}

		const changedArtifact = createFixture();
		try {
			fs.appendFileSync(changedArtifact.artifactPath, "changed");
			expect(() =>
				validatePublish(changedArtifact.root, changedArtifact.evidenceFile),
			).toThrow("artifactSha256 mismatch");
			fs.rmSync(changedArtifact.artifactPath);
			expect(() =>
				validatePublish(changedArtifact.root, changedArtifact.evidenceFile),
			).toThrow("qualified artifact is missing");
		} finally {
			cleanup(changedArtifact);
		}
	});

	it("rejects incomplete or command-mismatched scenario evidence", () => {
		const fixture = createFixture();
		try {
			fixture.writeEvidence(
				fixture.evidence({
					scenarios: [
						{
							id: "unexpected.pass",
							required: true,
							status: "passed",
							commandFingerprint: "f".repeat(64),
						},
					],
				}),
			);
			expect(() => validatePublish(fixture.root, fixture.evidenceFile)).toThrow(
				"scenario set mismatch",
			);

			fixture.writeEvidence(
				fixture.evidence({
					scenarios: [
						{
							id: "fixture.pass",
							required: true,
							status: "passed",
							commandFingerprint: "changed",
						},
					],
				}),
			);
			expect(() => validatePublish(fixture.root, fixture.evidenceFile)).toThrow(
				"command fingerprint mismatch",
			);
		} finally {
			cleanup(fixture);
		}
	});

	it("dry-runs and intercepts publication without any network process", () => {
		const fixture = createFixture();
		try {
			let calls = 0;
			publish({
				root: fixture.root,
				evidenceFile: fixture.evidenceFile,
				dryRun: true,
				spawn: () => {
					calls += 1;
					throw new Error("must not spawn");
				},
			});
			expect(calls).toBe(0);

			let invocation;
			publish({
				root: fixture.root,
				evidenceFile: fixture.evidenceFile,
				spawn: (command, args, options) => {
					invocation = { command, args, options };
					return { status: 0 };
				},
			});
			expect(invocation.command).toBe("npm");
			expect(invocation.args.slice(0, 2)).toEqual([
				"publish",
				fixture.artifactPath,
			]);
			expect(invocation.options.env.PICAMBER_QUALIFICATION_EVIDENCE).toBe(
				fixture.evidenceFile,
			);
		} finally {
			cleanup(fixture);
		}
	});

	it("rejects direct lifecycle publication without qualification variables", () => {
		const result = spawnSync(
			process.execPath,
			[path.join(__dirname, "prepublish-check.cjs")],
			{
				encoding: "utf8",
				env: { PATH: process.env.PATH },
			},
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"direct publication from dist is not qualified",
		);
	});
});
