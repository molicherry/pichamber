"use strict";

const { describe, expect, it } = require("bun:test");
const { readManifest, selectScenarios, validateManifest } = require("./manifest.cjs");

function fixture() {
  return structuredClone(readManifest().manifest);
}

describe("release manifest", () => {
  it("parses the repository manifest and selects CI/full from the same inventory", () => {
    const manifest = fixture();
    const ci = selectScenarios(manifest, "ci");
    const full = selectScenarios(manifest, "full");
    expect(ci.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(ci.length);
    expect(ci.every((scenario) => manifest.scenarios.includes(scenario))).toBe(true);
  });

  it("rejects unknown profiles and duplicate scenario IDs", () => {
    const manifest = fixture();
    expect(() => selectScenarios(manifest, "not-a-profile")).toThrow("unknown profile");
    manifest.scenarios.push(structuredClone(manifest.scenarios[0]));
    expect(() => validateManifest(manifest)).toThrow("duplicate scenario id");
  });

  it("rejects malformed prerequisites and missing required supported-capability coverage", () => {
    const malformed = fixture();
    malformed.scenarios[0].prerequisites.push("node maybe");
    expect(() => validateManifest(malformed)).toThrow("unparseable prerequisite");

    const uncovered = fixture();
    uncovered.capabilities.push({ id: "new-supported-capability", status: "supported", description: "must be covered" });
    expect(() => validateManifest(uncovered)).toThrow("has no required full scenario");
  });

  it("requires concrete browser coverage without network-model credentials", () => {
    const manifest = fixture();
    const browser = manifest.capabilities.find((capability) => capability.id === "browser-critical-path");
    expect(browser?.status).toBe("supported");
    const scenario = manifest.scenarios.find((item) => item.capabilities.includes("browser-critical-path"));
    expect(scenario?.required).toBe(true);
    expect(scenario?.profiles).toContain("full");
    expect(scenario?.command).toEqual(["bun", "scripts/release/scenarios/browser-critical.cjs"]);
    expect(() => validateManifest(manifest)).not.toThrow();
  });
});
