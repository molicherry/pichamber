#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-git-scenario-"));
try {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Release Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "release@example.invalid"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "two\n");
  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  if (!status.includes("tracked.txt")) throw new Error("git status did not expose the disposable change");
  execFileSync("git", ["-C", root, "stash", "push", "-qm", "release-test"]);
  execFileSync("git", ["-C", root, "branch", "release-scenario"]);
  const refs = execFileSync("git", ["-C", root, "show-ref", "--verify", "refs/heads/release-scenario"], { encoding: "utf8" });
  if (!refs) throw new Error("branch scenario failed");
  let injectionRejected = false;
  try { execFileSync("git", ["-C", root, "show-ref", "--verify", "--help"], { stdio: "ignore" }); } catch { injectionRejected = true; }
  if (!injectionRejected) throw new Error("ref option-injection negative case unexpectedly succeeded");
  console.log("disposable git status/stash/branch/failure scenario passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
