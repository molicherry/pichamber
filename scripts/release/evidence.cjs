#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const EVIDENCE_SCHEMA_VERSION = 1;
const EVIDENCE_VALIDITY_MS = 24 * 60 * 60 * 1000;
const SCENARIO_STATUSES = new Set([
	"passed",
	"failed",
	"skipped",
	"unsupported",
]);

function sha256File(file) {
	const hash = crypto.createHash("sha256");
	hash.update(fs.readFileSync(file));
	return hash.digest("hex");
}

function writeEvidenceAtomic(file, evidence) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
		fs.fsyncSync(fd);
	} catch (error) {
		try {
			fs.closeSync(fd);
		} catch {}
		try {
			fs.unlinkSync(temp);
		} catch {}
		throw error;
	}
	fs.closeSync(fd);
	try {
		fs.renameSync(temp, file);
		const dirFd = fs.openSync(path.dirname(file), "r");
		try {
			fs.fsyncSync(dirFd);
		} finally {
			fs.closeSync(dirFd);
		}
	} catch (error) {
		try {
			fs.unlinkSync(temp);
		} catch {}
		throw error;
	}
}

function readEvidence(file) {
	let value;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(
			`qualification evidence is missing or invalid: ${error.message}`,
		);
	}
	return value;
}

function requireString(value, label) {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`qualification evidence ${label} is invalid`);
}

function validateEvidence(evidence, expected = {}, now = Date.now()) {
	if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
		throw new Error("qualification evidence must be an object");
	}
	if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
		throw new Error(`unsupported evidence schema '${evidence.schemaVersion}'`);
	}
	if (evidence.validityMs !== EVIDENCE_VALIDITY_MS)
		throw new Error("qualification evidence validity policy mismatch");
	if (evidence.result !== "passed")
		throw new Error("qualification evidence is not successful");
	requireString(evidence.completedAt, "completedAt");
	const completed = Date.parse(evidence.completedAt);
	if (
		!Number.isFinite(completed) ||
		completed > now + 60_000 ||
		now - completed > EVIDENCE_VALIDITY_MS
	) {
		throw new Error(
			"qualification evidence is expired or has an invalid timestamp",
		);
	}
	for (const key of [
		"version",
		"gitHead",
		"gitTree",
		"manifestHash",
		"artifactSha256",
	]) {
		requireString(evidence[key], key);
		if (expected[key] !== undefined && evidence[key] !== expected[key]) {
			throw new Error(`qualification evidence ${key} mismatch`);
		}
	}
	if (
		!evidence.artifact ||
		typeof evidence.artifact !== "object" ||
		Array.isArray(evidence.artifact)
	) {
		throw new Error("qualification evidence artifact is invalid");
	}
	requireString(evidence.artifact.path, "artifact.path");
	requireString(evidence.artifact.sha256, "artifact.sha256");
	requireString(evidence.artifact.distSha256, "artifact.distSha256");
	if (evidence.artifact.sha256 !== evidence.artifactSha256) {
		throw new Error("qualification evidence artifact hashes disagree");
	}
	if (
		expected.artifactPath &&
		path.resolve(evidence.artifact.path) !== path.resolve(expected.artifactPath)
	) {
		throw new Error("qualification evidence artifact path mismatch");
	}
	if (!Array.isArray(evidence.scenarios) || evidence.scenarios.length === 0) {
		throw new Error("qualification evidence has no scenario results");
	}
	const ids = new Set();
	const scenariosById = new Map();
	for (const scenario of evidence.scenarios) {
		if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
			throw new Error("qualification evidence scenario result is invalid");
		}
		requireString(scenario.id, "scenario id");
		if (ids.has(scenario.id))
			throw new Error(
				`qualification evidence has duplicate scenario '${scenario.id}'`,
			);
		ids.add(scenario.id);
		scenariosById.set(scenario.id, scenario);
		if (
			typeof scenario.required !== "boolean" ||
			!SCENARIO_STATUSES.has(scenario.status)
		) {
			throw new Error(
				`qualification evidence scenario '${scenario.id}' has an invalid status`,
			);
		}
	}
	if (expected.scenarios !== undefined) {
		if (!Array.isArray(expected.scenarios))
			throw new Error("expected qualification scenarios are invalid");
		const expectedIds = new Set(
			expected.scenarios.map((scenario) => scenario.id),
		);
		const unexpected = [...ids].filter((id) => !expectedIds.has(id));
		const missing = expected.scenarios
			.filter((scenario) => !ids.has(scenario.id))
			.map((scenario) => scenario.id);
		if (unexpected.length || missing.length || ids.size !== expectedIds.size) {
			throw new Error(
				`qualification evidence scenario set mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
			);
		}
		for (const expectedScenario of expected.scenarios) {
			const actual = scenariosById.get(expectedScenario.id);
			if (actual.required !== expectedScenario.required) {
				throw new Error(
					`qualification evidence scenario '${expectedScenario.id}' required flag mismatch`,
				);
			}
			if (
				expectedScenario.commandFingerprint !== undefined &&
				actual.commandFingerprint !== expectedScenario.commandFingerprint
			) {
				throw new Error(
					`qualification evidence scenario '${expectedScenario.id}' command fingerprint mismatch`,
				);
			}
		}
	}
	const unacceptable = evidence.scenarios.filter(
		(scenario) => scenario.required && scenario.status !== "passed",
	);
	if (unacceptable.length) {
		throw new Error(
			`qualification evidence contains non-passing required scenarios: ${unacceptable.map((scenario) => scenario.id).join(", ")}`,
		);
	}
	if (
		evidence.redaction?.credentialsPersisted !== false ||
		evidence.redaction?.localOnly !== true
	) {
		throw new Error(
			"qualification evidence redaction/local-only declaration is invalid",
		);
	}
	return evidence;
}

module.exports = {
	EVIDENCE_SCHEMA_VERSION,
	EVIDENCE_VALIDITY_MS,
	sha256File,
	writeEvidenceAtomic,
	readEvidence,
	validateEvidence,
};
