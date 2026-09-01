"use strict";

const { describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	EVIDENCE_SCHEMA_VERSION,
	EVIDENCE_VALIDITY_MS,
	readEvidence,
	validateEvidence,
	writeEvidenceAtomic,
} = require("./evidence.cjs");

function validEvidence(now = Date.now()) {
	return {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		validityMs: EVIDENCE_VALIDITY_MS,
		result: "passed",
		completedAt: new Date(now).toISOString(),
		version: "0.1.2-rc.2",
		gitHead: "a".repeat(40),
		gitTree: "b".repeat(40),
		manifestHash: "c".repeat(64),
		artifactSha256: "d".repeat(64),
		artifact: {
			path: "/tmp/pichamber.tgz",
			sha256: "d".repeat(64),
			distSha256: "e".repeat(64),
		},
		scenarios: [
			{
				id: "required",
				required: true,
				status: "passed",
				commandFingerprint: "f".repeat(64),
			},
		],
		redaction: {
			credentialsPersisted: false,
			conversationContentPersisted: false,
			localOnly: true,
		},
	};
}

describe("qualification evidence", () => {
	it("writes a complete receipt atomically with private permissions", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-evidence-"));
		try {
			const file = path.join(root, "nested", "qualification.json");
			const evidence = validEvidence();
			writeEvidenceAtomic(file, evidence);
			expect(readEvidence(file)).toEqual(evidence);
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			expect(fs.readdirSync(path.dirname(file))).toEqual([
				"qualification.json",
			]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unsupported schemas, expired receipts, and partial JSON", () => {
		const now = Date.now();
		const unsupported = validEvidence(now);
		unsupported.schemaVersion = 99;
		expect(() => validateEvidence(unsupported, {}, now)).toThrow(
			"unsupported evidence schema",
		);

		const expired = validEvidence(now - EVIDENCE_VALIDITY_MS - 1);
		expect(() => validateEvidence(expired, {}, now)).toThrow("expired");

		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pichamber-partial-evidence-"),
		);
		try {
			const file = path.join(root, "qualification.json");
			fs.writeFileSync(file, '{"schemaVersion":1');
			expect(() => readEvidence(file)).toThrow("missing or invalid");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects identity, manifest, artifact, schema-shape, and required-status mismatches", () => {
		const evidence = validEvidence();
		expect(() => validateEvidence(evidence, { version: "different" })).toThrow(
			"version mismatch",
		);
		expect(() => validateEvidence(evidence, { gitTree: "changed" })).toThrow(
			"gitTree mismatch",
		);
		expect(() =>
			validateEvidence(evidence, { manifestHash: "changed" }),
		).toThrow("manifestHash mismatch");
		expect(() =>
			validateEvidence(evidence, { artifactSha256: "changed" }),
		).toThrow("artifactSha256 mismatch");

		const invalidArtifact = validEvidence();
		invalidArtifact.artifact = null;
		expect(() => validateEvidence(invalidArtifact)).toThrow(
			"artifact is invalid",
		);

		const skipped = validEvidence();
		skipped.scenarios[0].status = "skipped";
		expect(() => validateEvidence(skipped)).toThrow(
			"non-passing required scenarios",
		);

		const partial = validEvidence();
		expect(() =>
			validateEvidence(partial, {
				scenarios: [
					{
						id: "required",
						required: true,
						commandFingerprint: "f".repeat(64),
					},
					{
						id: "also-required",
						required: true,
						commandFingerprint: "a".repeat(64),
					},
				],
			}),
		).toThrow("scenario set mismatch");

		const changedCommand = validEvidence();
		expect(() =>
			validateEvidence(changedCommand, {
				scenarios: [
					{ id: "required", required: true, commandFingerprint: "changed" },
				],
			}),
		).toThrow("command fingerprint mismatch");
	});
});
