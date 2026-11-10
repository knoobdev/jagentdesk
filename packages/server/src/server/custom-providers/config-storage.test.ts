import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  providerApiKeySecretId,
  readAgentProviderEntries,
  writeAgentProviderEntry,
} from "./config-storage.js";

function createHome(): string {
  return mkdtempSync(path.join(tmpdir(), "jagentdesk-cp-storage-"));
}

describe("config-storage", () => {
  test("writes an agents.providers entry and reads it back", () => {
    const home = createHome();
    writeAgentProviderEntry(home, "my-models", {
      extends: "opencode",
      label: "My models",
      api: { protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1", via: "direct" },
      models: [{ id: "m1", label: "m1" }],
    });
    const entries = readAgentProviderEntries(home);
    expect(entries["my-models"]).toEqual({
      extends: "opencode",
      label: "My models",
      api: { protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1", via: "direct" },
      models: [{ id: "m1", label: "m1" }],
    });
  });

  test("preserves every other config.json key verbatim", () => {
    const home = createHome();
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        version: 1,
        someTopLevel: { nested: [1, 2, 3] },
        agents: {
          providers: {
            "hand-written": { extends: "claude", label: "Hand", env: { KEY: "value" } },
          },
          metadataGeneration: { providers: [] },
        },
        log: { level: "info" },
      }),
    );
    writeAgentProviderEntry(home, "api-one", {
      extends: "opencode",
      label: "API one",
      api: { protocol: "openai", baseUrl: "http://x/v1", via: "direct" },
    });
    const parsed = JSON.parse(readFileSync(path.join(home, "config.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(parsed["someTopLevel"]).toEqual({ nested: [1, 2, 3] });
    expect(parsed["log"]).toEqual({ level: "info" });
    const agents = parsed["agents"] as Record<string, unknown>;
    expect(agents["metadataGeneration"]).toEqual({ providers: [] });
    const providers = agents["providers"] as Record<string, unknown>;
    expect(providers["hand-written"]).toEqual({
      extends: "claude",
      label: "Hand",
      env: { KEY: "value" },
    });
    expect(providers["api-one"]).toMatchObject({ label: "API one" });
  });

  test("null removes the entry and keeps the rest", () => {
    const home = createHome();
    writeAgentProviderEntry(home, "a", { extends: "opencode", label: "A" });
    writeAgentProviderEntry(home, "b", { extends: "opencode", label: "B" });
    writeAgentProviderEntry(home, "a", null);
    const entries = readAgentProviderEntries(home);
    expect(Object.keys(entries)).toEqual(["b"]);
  });

  test("returns an empty map for a missing or corrupt config.json", () => {
    const home = createHome();
    expect(readAgentProviderEntries(home)).toEqual({});
    writeFileSync(path.join(home, "config.json"), "not json");
    expect(readAgentProviderEntries(home)).toEqual({});
  });

  test("secret id uses the provider.apikey.<id> namespace", () => {
    expect(providerApiKeySecretId("my-models")).toBe("provider.apikey.my-models");
  });
});
