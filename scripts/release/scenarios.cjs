#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readManifest, selectScenarios } = require("./manifest.cjs");
const {
  createRunDirectory,
  packageIdentity,
  sanitizedChildEnvironment,
  secretValues,
  resolveBrowserExecutable,
} = require("./environment.cjs");
const { runScenarios, assertRequiredPassed } = require("./runner.cjs");
const { packDist, validateDist } = require("./artifact.cjs");

async function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--profile");
  const profile = index >= 0 ? args[index + 1] : "ci";
  const { manifest } = readManifest();
  const scenarios = selectScenarios(manifest, profile);
  const temp = createRunDirectory("pichamber-release-scenarios-");
  let succeeded = false;
  try {
    const inheritedSecrets = secretValues(process.env);
    const browserExecutable = resolveBrowserExecutable(process.cwd(), process.env);
    const prerequisiteEnv = {
      ...process.env,
      ...(browserExecutable ? { PICAMBER_RELEASE_BROWSER_EXECUTABLE: browserExecutable } : {}),
    };
    const env = sanitizedChildEnvironment(prerequisiteEnv, {
      HOME: temp.home,
      PI_CODING_AGENT_DIR: temp.agent,
      PICAMBER_WORKSPACE: temp.workspace,
      PICAMBER_SCENARIO_ROOT: temp.root,
    });
    const sourceScenarios = scenarios.filter((scenario) => scenario.stage === "source");
    const sourceResults = await runScenarios(sourceScenarios, {
      stage: "source",
      cwd: process.cwd(),
      env,
      logDir: temp.logs,
      evidenceRoot: temp.root,
      redactValues: inheritedSecrets,
    });
    assertRequiredPassed(sourceResults, sourceScenarios);

    const artifactScenarios = scenarios.filter((scenario) => scenario.stage === "artifact");
    let artifactResults = [];
    if (artifactScenarios.length > 0) {
      const packages = packageIdentity();
      const { dist } = validateDist(process.cwd(), packages.version);
      const artifact = packDist(dist, path.join(temp.root, "artifacts"));
      const artifactEnv = sanitizedChildEnvironment(env, { PICAMBER_QUALIFIED_TARBALL: artifact.path });
      artifactResults = await runScenarios(artifactScenarios, {
        stage: "artifact",
        cwd: process.cwd(),
        env: artifactEnv,
        logDir: temp.logs,
        evidenceRoot: temp.root,
        redactValues: inheritedSecrets,
      });
      assertRequiredPassed(artifactResults, artifactScenarios);
    }

    for (const result of [...sourceResults, ...artifactResults]) {
      console.log(`${result.status.padEnd(11)} ${result.id}${result.reason ? ` - ${result.reason}` : ""}`);
    }
    console.log(`scenario logs were local-only temporary files under: ${temp.logs}`);
    succeeded = true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`failed scenario logs retained locally under: ${temp.logs}`);
    throw error;
  } finally {
    if (succeeded) fs.rmSync(temp.root, { recursive: true, force: true });
  }
}

main().catch(() => process.exit(1));
