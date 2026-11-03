import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { commandInvocation, planSpecKitInit, specKitIntegrationFor } from "./layout.js";
import { loadSpecKitSources, type SpecKitScriptVariant } from "./vendor.js";

// Fixtures are the real `specify init` 1.3.0 output, recorded by
// scripts/capture-speckit-fixtures.mjs (spec 28.8 criterion 1).
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

interface FixtureFile {
  sha256: string;
  mode: string;
}

function readFixture(name: string): Record<string, FixtureFile> {
  const fixture = JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), "utf8")) as {
    files: Record<string, FixtureFile>;
  };
  return fixture.files;
}

function normalizeTimestamps(text: string): string {
  return text.replace(/"(installed_at|updated_at)": "[^"]*"/g, '"$1": "<timestamp>"');
}

async function generated(
  provider: string,
  script: SpecKitScriptVariant,
): Promise<Record<string, FixtureFile>> {
  const files = planSpecKitInit({
    sources: await loadSpecKitSources(),
    integration: specKitIntegrationFor(provider),
    script,
    now: Date.UTC(2026, 10, 4, 1, 2, 3, 456),
  });
  const entries = files
    .map((file) => {
      const hash = createHash("sha256").update(normalizeTimestamps(file.content), "utf8");
      return [file.path, { sha256: hash.digest("hex"), mode: file.mode.toString(8) }] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries);
}

describe("spec-kit init layout", () => {
  it.each([
    ["claude", "sh", "claude-sh"],
    ["claude", "ps", "claude-ps"],
    ["codex", "sh", "codex-sh"],
    ["copilot", "sh", "copilot-sh"],
    ["opencode", "sh", "opencode-sh"],
    ["pi", "sh", "pi-sh"],
    ["omp", "sh", "omp-sh"],
  ] as const)("writes what specify init writes for %s (%s)", async (provider, script, fixture) => {
    expect(await generated(provider, script)).toEqual(readFixture(fixture));
  });

  it("formats manifest timestamps like Python isoformat", async () => {
    const files = planSpecKitInit({
      sources: await loadSpecKitSources(),
      integration: specKitIntegrationFor("claude"),
      script: "sh",
      now: Date.UTC(2026, 10, 4, 1, 2, 3, 456),
    });
    const manifest = files.find(
      (file) => file.path === ".specify/integrations/claude.manifest.json",
    );
    expect(manifest?.content).toContain('"installed_at": "2026-11-04T01:02:03.456000+00:00"');
  });

  it("installs no command directory for a generic ACP provider", async () => {
    const files = planSpecKitInit({
      sources: await loadSpecKitSources(),
      integration: specKitIntegrationFor("my-acp-agent"),
      script: "sh",
      now: 0,
    });
    const outsideSpecify = files.filter((file) => !file.path.startsWith(".specify/"));
    expect(outsideSpecify).toEqual([]);
    const initOptions = files.find((file) => file.path === ".specify/init-options.json");
    expect(JSON.parse(initOptions?.content ?? "{}")).toEqual({
      allow_symlinks: false,
      feature_numbering: "sequential",
      here: true,
      script: "sh",
      speckit_version: "1.3.0",
    });
  });

  it("invokes commands with each provider's syntax", () => {
    expect(commandInvocation(specKitIntegrationFor("claude"), "specify")).toBe("/speckit-specify");
    expect(commandInvocation(specKitIntegrationFor("codex"), "plan")).toBe("$speckit-plan");
    expect(commandInvocation(specKitIntegrationFor("copilot"), "tasks")).toBe("/speckit-tasks");
    expect(commandInvocation(specKitIntegrationFor("opencode"), "plan")).toBe("/speckit.plan");
    expect(commandInvocation(specKitIntegrationFor("pi"), "plan")).toBe("/speckit.plan");
    expect(commandInvocation(specKitIntegrationFor("omp"), "plan")).toBe("/speckit.plan");
  });
});
