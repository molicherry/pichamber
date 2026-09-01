#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { sha256File } = require("./evidence.cjs");
const { sanitizedChildEnvironment } = require("./environment.cjs");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateDist(root, expectedVersion) {
  const dist = path.join(root, "dist");
  const manifest = readJson(path.join(dist, "package.json"));
  if (manifest.name !== "@molicherry/pichamber") throw new Error(`unexpected dist package name '${manifest.name}'`);
  if (manifest.version !== expectedVersion) throw new Error(`dist version '${manifest.version}' does not match '${expectedVersion}'`);
  if (manifest.private === true) throw new Error("dist package must not be private");
  if (manifest.engines?.node !== ">=22.0.0") throw new Error("dist must require Node >=22.0.0");
  if (manifest.scripts?.prepublishOnly !== "node scripts/prepublish-check.cjs") {
    throw new Error("dist lacks the defensive prepublishOnly guard");
  }
  for (const relative of [
    "bin/cli.js",
    "server/index.js",
    "ui/index.html",
    "LICENSE",
    "README.md",
    "scripts/prepublish-check.cjs",
  ]) {
    if (!fs.existsSync(path.join(dist, relative))) throw new Error(`dist is missing ${relative}`);
  }
  return { dist, manifest };
}

function packDist(dist, destination, execute = execFileSync) {
  fs.mkdirSync(destination, { recursive: true });
  const output = execute(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    {
      cwd: dist,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      env: sanitizedChildEnvironment(process.env, { PICAMBER_PACKING_ONLY: "1" }),
    },
  );
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0].filename !== "string") {
    throw new Error("npm pack returned an unexpected result");
  }
  const artifact = path.resolve(destination, parsed[0].filename);
  if (!fs.existsSync(artifact)) throw new Error(`packed artifact was not created: ${artifact}`);
  return { path: artifact, sha256: sha256File(artifact), size: fs.statSync(artifact).size };
}

function installTarball(tarball, installDir, execute = execFileSync) {
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, "package.json"), '{"name":"pichamber-release-smoke","private":true}\n');
  const userConfig = path.join(installDir, ".npmrc");
  const registry = process.env.PICAMBER_RELEASE_INSTALL_REGISTRY || "https://registry.npmjs.org/";
  let parsedRegistry;
  try { parsedRegistry = new URL(registry); } catch { throw new Error("release install registry must be a valid URL"); }
  if (parsedRegistry.username || parsedRegistry.password) throw new Error("release install registry URL must not contain credentials");
  fs.writeFileSync(userConfig, `registry=${registry}\naudit=false\nfund=false\n`, { mode: 0o600 });
  execute(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-package-lock", "--foreground-scripts", tarball],
    {
      cwd: installDir,
      stdio: "inherit",
      env: sanitizedChildEnvironment(process.env, {
        HOME: installDir,
        npm_config_userconfig: userConfig,
        npm_config_registry: registry,
        npm_config_ignore_scripts: "false",
      }),
    },
  );
  const cli = path.join(installDir, "node_modules", ".bin", "pichamber");
  if (!fs.existsSync(cli)) throw new Error("clean installation did not create the pichamber CLI");
  return cli;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startInstalledCli(cli, state, logFile) {
  const port = await freePort();
  const output = fs.openSync(logFile, "a", 0o600);
  const child = spawn(cli, [], {
    cwd: state.workspace,
    env: sanitizedChildEnvironment(process.env, {
      HOME: state.home,
      PI_CODING_AGENT_DIR: state.agent,
      PICAMBER_WORKSPACE: state.workspace,
      PORT: String(port),
      HOST: "127.0.0.1",
      PICAMBER_PASSWORD: "",
      PICAMBER_TOKEN: "",
    }),
    stdio: ["ignore", output, output],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fs.closeSync(output);
      throw new Error(`installed CLI exited before health check (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/opencode/health`);
      const body = await response.json();
      if (response.ok && body.healthy === true) return { child, baseUrl, output };
    } catch {}
    await delay(200);
  }
  child.kill("SIGTERM");
  fs.closeSync(output);
  throw new Error("installed CLI did not become healthy within 30 seconds");
}

async function stopChild(instance) {
  if (instance.child.exitCode === null) {
    instance.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => instance.child.once("exit", resolve)),
      delay(3000),
    ]);
    if (instance.child.exitCode === null) instance.child.kill("SIGKILL");
  }
  fs.closeSync(instance.output);
}

module.exports = { validateDist, packDist, installTarball, startInstalledCli, stopChild };
