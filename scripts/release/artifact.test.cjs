"use strict";

const { describe, expect, it } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installTarball, validateDist } = require("./artifact.cjs");

function createDist(root, version = "0.1.2-rc.2") {
  const dist = path.join(root, "dist");
  for (const relative of ["bin/cli.js", "server/index.js", "ui/index.html", "LICENSE", "README.md", "scripts/prepublish-check.cjs"]) {
    const file = path.join(dist, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative);
  }
  fs.writeFileSync(path.join(dist, "package.json"), JSON.stringify({
    name: "@molicherry/pichamber",
    version,
    type: "module",
    bin: { pichamber: "bin/cli.js" },
    engines: { node: ">=22.0.0" },
    scripts: { prepublishOnly: "node scripts/prepublish-check.cjs" },
  }));
  return dist;
}

describe("packed artifact helpers", () => {
  it("validates the generated publish manifest against the independent web version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-dist-"));
    try {
      createDist(root);
      expect(validateDist(root, "0.1.2-rc.2").manifest.version).toBe("0.1.2-rc.2");
      expect(() => validateDist(root, "0.1.2")).toThrow("does not match");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enables native dependency install scripts without inheriting npm tokens", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pichamber-install-"));
    const oldToken = process.env.NODE_AUTH_TOKEN;
    process.env.NODE_AUTH_TOKEN = "must-not-reach-npm";
    try {
      const tarball = path.join(root, "package.tgz");
      fs.writeFileSync(tarball, "fixture");
      let invocation;
      const cli = installTarball(tarball, path.join(root, "install"), (command, args, options) => {
        invocation = { command, args, options };
        const target = path.join(options.cwd, "node_modules", ".bin", "pichamber");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "#!/bin/sh\n");
      });
      expect(fs.existsSync(cli)).toBe(true);
      expect(invocation.command).toBe("npm");
      expect(invocation.args).toContain("--foreground-scripts");
      expect(invocation.args).not.toContain("--ignore-scripts");
      expect(invocation.options.env.npm_config_ignore_scripts).toBe("false");
      expect(invocation.options.env.NODE_AUTH_TOKEN).toBeUndefined();
      expect(invocation.options.env.HOME).toBe(invocation.options.cwd);
    } finally {
      if (oldToken === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = oldToken;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
