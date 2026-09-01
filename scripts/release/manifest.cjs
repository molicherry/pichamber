#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MANIFEST_SCHEMA_VERSION = 1;
const STATUS_VALUES = new Set(["supported", "unsupported"]);
const SCENARIO_STAGES = new Set(["source", "artifact"]);

function fail(message) {
  throw new Error(`release manifest: ${message}`);
}

function readManifest(file = path.resolve("release-scenarios.json")) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
  let value;
  try { value = JSON.parse(raw); } catch (error) {
    fail(`invalid JSON in ${file}: ${error.message}`);
  }
  validateManifest(value);
  return { manifest: value, raw, hash: crypto.createHash("sha256").update(raw).digest("hex"), file };
}

function nonEmptyStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || !v.trim())) {
    fail(`${label} must be a non-empty array of non-empty strings`);
  }
}

function validatePrerequisite(value, label) {
  if (value === "git" || value === "node>=22" || value === "bun=1.4.0" || value === "linux-x64") return;
  if (/^(command|env):[A-Za-z0-9_.-]+$/.test(value)) return;
  fail(`${label} has unparseable prerequisite '${value}'`);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("root must be an object");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) fail(`unsupported schemaVersion '${manifest.schemaVersion}'`);
  nonEmptyStrings(manifest.profiles, "profiles");
  const profiles = new Set(manifest.profiles);
  if (!profiles.has("ci") || !profiles.has("full")) fail("profiles must include ci and full");
  if (profiles.size !== manifest.profiles.length) fail("profiles contain duplicates");

  if (!manifest.supportedMatrix || typeof manifest.supportedMatrix !== "object" || Array.isArray(manifest.supportedMatrix)) {
    fail("supportedMatrix must be an object");
  }
  nonEmptyStrings(manifest.supportedMatrix.platforms, "supportedMatrix platforms");
  nonEmptyStrings(manifest.supportedMatrix.surfaces, "supportedMatrix surfaces");
  if (!Array.isArray(manifest.supportedMatrix.unsupportedPlatforms) || !Array.isArray(manifest.supportedMatrix.unsupportedSurfaces)) {
    fail("supportedMatrix unsupported lists must be arrays");
  }
  for (const key of ["node", "bun"]) {
    if (typeof manifest.supportedMatrix[key] !== "string" || !manifest.supportedMatrix[key].trim()) {
      fail(`supportedMatrix ${key} must be a non-empty string`);
    }
  }
  const supportedPlatforms = new Set(manifest.supportedMatrix.platforms);

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) fail("capabilities must be non-empty");
  const capabilities = new Map();
  for (const cap of manifest.capabilities) {
    if (!cap || typeof cap.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(cap.id)) fail("capability has invalid id");
    if (capabilities.has(cap.id)) fail(`duplicate capability id '${cap.id}'`);
    if (!STATUS_VALUES.has(cap.status)) fail(`capability '${cap.id}' has invalid status`);
    if (typeof cap.description !== "string" || !cap.description.trim()) fail(`capability '${cap.id}' lacks description`);
    capabilities.set(cap.id, cap);
  }

  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) fail("scenarios must be non-empty");
  const scenarios = new Map();
  for (const scenario of manifest.scenarios) {
    if (!scenario || typeof scenario.id !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(scenario.id)) fail("scenario has invalid id");
    if (scenarios.has(scenario.id)) fail(`duplicate scenario id '${scenario.id}'`);
    scenarios.set(scenario.id, scenario);
    if (typeof scenario.description !== "string" || !scenario.description.trim()) fail(`scenario '${scenario.id}' lacks description`);
    nonEmptyStrings(scenario.command, `scenario '${scenario.id}' command`);
    nonEmptyStrings(scenario.profiles, `scenario '${scenario.id}' profiles`);
    for (const profile of scenario.profiles) if (!profiles.has(profile)) fail(`scenario '${scenario.id}' references unknown profile '${profile}'`);
    if (typeof scenario.required !== "boolean") fail(`scenario '${scenario.id}' required must be boolean`);
    nonEmptyStrings(scenario.tags, `scenario '${scenario.id}' tags`);
    nonEmptyStrings(scenario.platforms, `scenario '${scenario.id}' platforms`);
    if (scenario.required && scenario.profiles.includes("full")) {
      for (const platform of scenario.platforms) {
        if (!supportedPlatforms.has(platform)) fail(`required full scenario '${scenario.id}' targets unsupported platform '${platform}'`);
      }
    }
    if (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs < 1000) fail(`scenario '${scenario.id}' timeoutMs is invalid`);
    if (typeof scenario.passCriteria !== "string" || !scenario.passCriteria.trim()) fail(`scenario '${scenario.id}' lacks passCriteria`);
    if (!SCENARIO_STAGES.has(scenario.stage)) fail(`scenario '${scenario.id}' has invalid stage`);
    if (!Array.isArray(scenario.prerequisites)) fail(`scenario '${scenario.id}' prerequisites must be an array`);
    scenario.prerequisites.forEach((p, i) => {
      if (typeof p !== "string") fail(`scenario '${scenario.id}' prerequisite ${i} is not a string`);
      validatePrerequisite(p, `scenario '${scenario.id}'`);
    });
    nonEmptyStrings(scenario.capabilities, `scenario '${scenario.id}' capabilities`);
    for (const cap of scenario.capabilities) if (!capabilities.has(cap)) fail(`scenario '${scenario.id}' references unknown capability '${cap}'`);
  }

  for (const cap of capabilities.values()) {
    if (cap.status === "supported") {
      const covered = [...scenarios.values()].some((s) => s.required && s.profiles.includes("full") && s.capabilities.includes(cap.id));
      if (!covered) fail(`supported capability '${cap.id}' has no required full scenario`);
    }
  }
  return manifest;
}

function selectScenarios(manifest, profile) {
  if (!manifest.profiles.includes(profile)) fail(`unknown profile '${profile}'`);
  return manifest.scenarios.filter((scenario) => scenario.profiles.includes(profile));
}

module.exports = { readManifest, validateManifest, selectScenarios };
