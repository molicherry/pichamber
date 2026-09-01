#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const result = spawnSync("bun", ["test", "scripts/release"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
