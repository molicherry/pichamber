#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const EVIDENCE_VALIDITY_MS = 24 * 60 * 60 * 1000;
function reject(message) {
  console.error(`pichamber publish rejected: ${message}`);
  process.exit(1);
}
function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const evidenceFile = process.env.PICAMBER_QUALIFICATION_EVIDENCE;
const artifact = process.env.PICAMBER_QUALIFIED_ARTIFACT;
if (!evidenceFile || !artifact) reject("use `bun run release:publish`; direct publication from dist is not qualified");
let evidence;
try {
  evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
} catch (error) {
  reject(`cannot read qualification evidence: ${error.message}`);
}
if (evidence.schemaVersion !== 1 || evidence.result !== "passed" || evidence.validityMs !== EVIDENCE_VALIDITY_MS) {
  reject("qualification evidence is unsupported or unsuccessful");
}
const completed = Date.parse(evidence.completedAt);
if (!Number.isFinite(completed) || Date.now() - completed > EVIDENCE_VALIDITY_MS || completed > Date.now() + 60_000) {
  reject("qualification evidence is expired or has an invalid timestamp");
}
if (path.resolve(evidence.artifact?.path || "") !== path.resolve(artifact)) {
  reject("qualified artifact does not match the publish artifact");
}
if (!fs.existsSync(artifact)) reject("qualified artifact is missing");
if (sha256File(artifact) !== evidence.artifactSha256 || evidence.artifact?.sha256 !== evidence.artifactSha256) {
  reject("qualified artifact hash does not match evidence");
}
console.log("pichamber qualification lifecycle guard passed");
