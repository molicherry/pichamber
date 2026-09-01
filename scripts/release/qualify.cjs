#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readManifest, selectScenarios } = require("./manifest.cjs");
const {
  gitIdentity,
  packageIdentity,
  toolchains,
  assertScenarioPrerequisites,
  sanitizedChildEnvironment,
  secretValues,
  resolveBrowserExecutable,
  createRunDirectory,
} = require("./environment.cjs");
const { EVIDENCE_SCHEMA_VERSION, EVIDENCE_VALIDITY_MS, writeEvidenceAtomic } = require("./evidence.cjs");
const { runScenarios, assertRequiredPassed } = require("./runner.cjs");
const { validateDist, packDist } = require("./artifact.cjs");

function hashDirectory(directory) {
  const hash = crypto.createHash("sha256");
  function visit(current, relative = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name); const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full, rel); else if (entry.isFile()) { hash.update(rel); hash.update("\0"); hash.update(fs.readFileSync(full)); hash.update("\0"); }
    }
  }
  visit(directory); return hash.digest("hex");
}

async function qualify({ dryRun = false } = {}) {
  const root = process.cwd();
  const manifestData = readManifest(path.join(root, "release-scenarios.json"));
  const scenarios = selectScenarios(manifestData.manifest, "full");
  const gitBefore = gitIdentity(root, { requireClean: true });
  const packages = packageIdentity(root);
  const tools = toolchains();
  if (!tools.minimumNodeProven) throw new Error(`qualification must run under the minimum supported Node major (22); found ${tools.node}`);
  const browserExecutable = resolveBrowserExecutable(root, process.env);
  const prerequisiteEnv = {
    ...process.env,
    ...(browserExecutable ? { PICAMBER_RELEASE_BROWSER_EXECUTABLE: browserExecutable } : {}),
  };
  assertScenarioPrerequisites(scenarios, prerequisiteEnv);
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, version: packages.version, gitHead: gitBefore.head, manifestHash: manifestData.hash, scenarios: scenarios.map((s) => s.id), note: "No scenarios, build, pack, install, publication, or upload was performed." }, null, 2));
    return null;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceRoot = path.resolve(process.env.PICAMBER_RELEASE_EVIDENCE_DIR || path.join(root, ".release-evidence"));
  const runEvidence = path.join(evidenceRoot, packages.version, gitBefore.head, stamp);
  const logs = path.join(runEvidence, "logs"); const artifacts = path.join(runEvidence, "artifacts");
  fs.mkdirSync(logs, { recursive: true }); fs.mkdirSync(artifacts, { recursive: true });
  const temp = createRunDirectory();
  const startedAt = new Date().toISOString();
  const inheritedSecrets = secretValues(process.env);
  const baseEnv = sanitizedChildEnvironment(prerequisiteEnv, {
    HOME: temp.home,
    PI_CODING_AGENT_DIR: temp.agent,
    PICAMBER_WORKSPACE: temp.workspace,
    PICAMBER_SCENARIO_ROOT: temp.root,
    PICAMBER_RELEASE_EVIDENCE_ROOT: runEvidence,
  });
  try {
    const sourceScenarios = scenarios.filter((s) => s.stage === "source");
    const sourceResults = await runScenarios(sourceScenarios, {
      stage: "source",
      cwd: root,
      env: baseEnv,
      logDir: logs,
      evidenceRoot: runEvidence,
      redactValues: inheritedSecrets,
    });
    assertRequiredPassed(sourceResults, sourceScenarios);
    const { dist } = validateDist(root, packages.version);
    const distSha256 = hashDirectory(dist);
    const artifact = packDist(dist, artifacts);
    const artifactEnv = sanitizedChildEnvironment(baseEnv, { PICAMBER_QUALIFIED_TARBALL: artifact.path });
    const artifactScenarios = scenarios.filter((s) => s.stage === "artifact");
    const artifactResults = await runScenarios(artifactScenarios, {
      stage: "artifact",
      cwd: root,
      env: artifactEnv,
      logDir: logs,
      evidenceRoot: runEvidence,
      redactValues: inheritedSecrets,
    });
    assertRequiredPassed(artifactResults, artifactScenarios);
    const gitAfter = gitIdentity(root, { requireClean: true });
    if (gitAfter.head !== gitBefore.head || gitAfter.tree !== gitBefore.tree) throw new Error("git identity changed during qualification");
    const completedAt = new Date().toISOString();
    const evidence = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      validityMs: EVIDENCE_VALIDITY_MS,
      startedAt, completedAt,
      result: "passed",
      version: packages.version,
      publishPackage: packages.publishPackage,
      packageVersions: packages.versions,
      gitHead: gitBefore.head,
      gitTree: gitBefore.tree,
      worktreeClean: true,
      manifestHash: manifestData.hash,
      toolchains: tools,
      platform: { os: process.platform, arch: process.arch },
      artifact: { path: artifact.path, sha256: artifact.sha256, size: artifact.size, distSha256 },
      artifactSha256: artifact.sha256,
      scenarios: [...sourceResults, ...artifactResults],
      redaction: { credentialsPersisted: false, conversationContentPersisted: false, localOnly: true },
    };
    const evidenceFile = path.join(runEvidence, "qualification.json");
    writeEvidenceAtomic(evidenceFile, evidence);
    console.log(`QUALIFIED ${packages.version}\nevidence: ${evidenceFile}\nartifact: ${artifact.path}\nsha256: ${artifact.sha256}`);
    return evidenceFile;
  } finally {
    fs.rmSync(temp.root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  qualify({ dryRun }).catch((error) => { console.error(`release qualification failed: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
module.exports = { qualify, hashDirectory };
