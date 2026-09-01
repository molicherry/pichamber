#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readManifest, selectScenarios } = require("./manifest.cjs");
const { gitIdentity, packageIdentity } = require("./environment.cjs");
const {
	readEvidence,
	validateEvidence,
	sha256File,
} = require("./evidence.cjs");
const { hashDirectory } = require("./qualify.cjs");
const { fingerprint } = require("./runner.cjs");

function findEvidence(root, version, head) {
	const base = path.join(root, version, head);
	if (!fs.existsSync(base))
		throw new Error(`no local qualification evidence for ${version}/${head}`);
	const found = [];
	for (const name of fs.readdirSync(base)) {
		const file = path.join(base, name, "qualification.json");
		if (fs.existsSync(file)) found.push(file);
	}
	if (!found.length)
		throw new Error(
			`no completed local qualification evidence for ${version}/${head}`,
		);
	return found.sort(
		(a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
	)[0];
}
function distTag(version) {
	return version.includes("-") ? "next" : "latest";
}

function validatePublish(root = process.cwd(), explicitEvidence) {
	const git = gitIdentity(root, { requireClean: true });
	const packages = packageIdentity(root);
	const manifest = readManifest(path.join(root, "release-scenarios.json"));
	const evidenceRoot = path.resolve(
		process.env.PICAMBER_RELEASE_EVIDENCE_DIR ||
			path.join(root, ".release-evidence"),
	);
	const evidenceFile = explicitEvidence
		? path.resolve(explicitEvidence)
		: findEvidence(evidenceRoot, packages.version, git.head);
	const evidence = readEvidence(evidenceFile);
	const artifactPath = path.resolve(evidence.artifact?.path || "");
	if (!fs.existsSync(artifactPath))
		throw new Error("qualified artifact is missing");
	const artifactSha256 = sha256File(artifactPath);
	const expectedScenarios = selectScenarios(manifest.manifest, "full").map(
		(scenario) => ({
			id: scenario.id,
			required: scenario.required,
			commandFingerprint: fingerprint(scenario.command),
		}),
	);
	const validated = validateEvidence(evidence, {
		version: packages.version,
		gitHead: git.head,
		gitTree: git.tree,
		manifestHash: manifest.hash,
		artifactSha256,
		artifactPath,
		scenarios: expectedScenarios,
	});
	const dist = path.join(root, "dist");
	if (
		!fs.existsSync(dist) ||
		hashDirectory(dist) !== validated.artifact.distSha256
	)
		throw new Error("dist build output changed after qualification");
	return {
		evidenceFile,
		evidence: validated,
		artifactPath,
		tag: distTag(packages.version),
	};
}

function publish({
	dryRun = false,
	evidenceFile,
	spawn = spawnSync,
	root = process.cwd(),
} = {}) {
	const plan = validatePublish(root, evidenceFile);
	if (dryRun) {
		console.log(
			JSON.stringify(
				{
					ok: true,
					dryRun: true,
					artifact: plan.artifactPath,
					sha256: plan.evidence.artifactSha256,
					tag: plan.tag,
					evidence: plan.evidenceFile,
					note: "Validation only: npm was not invoked and no network request or upload occurred.",
				},
				null,
				2,
			),
		);
		return;
	}
	const result = spawn(
		"npm",
		[
			"publish",
			plan.artifactPath,
			"--access",
			"public",
			"--tag",
			plan.tag,
			"--registry=https://registry.npmjs.org/",
		],
		{
			stdio: "inherit",
			env: {
				...process.env,
				PICAMBER_QUALIFICATION_EVIDENCE: plan.evidenceFile,
				PICAMBER_QUALIFIED_ARTIFACT: plan.artifactPath,
			},
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`npm publish exited ${result.status}`);
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const evidenceIndex = args.indexOf("--evidence");
	const evidenceFile = evidenceIndex >= 0 ? args[evidenceIndex + 1] : undefined;
	try {
		publish({ dryRun, evidenceFile });
	} catch (error) {
		console.error(
			`release publish rejected: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
module.exports = { findEvidence, distTag, validatePublish, publish };
