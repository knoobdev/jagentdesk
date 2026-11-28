import { readSpeechSettings } from "./speech/speech-settings.js";
import type { PersistedConfig } from "./persisted-config.js";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonConfigStore, applyMutableProviderConfigToOverrides } from "./daemon-config-store.js";
import { loadConfig } from "./config.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

describe("applyMutableProviderConfigToOverrides", () => {
  test("merges mutable provider fields onto provider overrides", () => {
    expect(
      applyMutableProviderConfigToOverrides(
        {
          gemini: {
            extends: "acp",
            label: "Gemini",
            command: ["gemini", "--acp"],
          },
        },
        {
          gemini: {
            enabled: false,
            description: "Gemini ACP",
            env: { GEMINI_AUTO_UPDATE: "0" },
          },
          claude: {
            additionalModels: [
              {
                id: "claude-custom",
                label: "claude-custom",
              },
            ],
          },
        },
      ),
    ).toEqual({
      gemini: {
        extends: "acp",
        label: "Gemini",
        description: "Gemini ACP",
        command: ["gemini", "--acp"],
        env: { GEMINI_AUTO_UPDATE: "0" },
        enabled: false,
      },
      claude: {
        additionalModels: [
          {
            id: "claude-custom",
            label: "claude-custom",
          },
        ],
      },
    });
  });
});

describe("DaemonConfigStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("patch persists provider enabled flags into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const initial = loadPersistedConfig(jagentdeskHome);
    const configPath = path.join(jagentdeskHome, "config.json");
    // Reuse the validated serializer through the store path by seeding the file directly.
    // This keeps the test focused on the merge behavior.
    const seeded =
      JSON.stringify(
        {
          ...initial,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      ) + "\n";
    writeFileSync(configPath, seeded);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      providers: {
        gemini: { enabled: false },
      },
    });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.providers?.gemini).toEqual({
      extends: "acp",
      label: "Gemini",
      command: ["gemini", "--acp"],
      enabled: false,
    });
  });

  test("patch removes provider entries from config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const configPath = path.join(jagentdeskHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    expect(next.providers.claude).toEqual({ enabled: false });
    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.providers?.gemini).toBeUndefined();
    expect(persisted.agents?.providers?.claude).toEqual({ enabled: false });
  });

  test("patch removes the providers object when the last provider is deleted", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const configPath = path.join(jagentdeskHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: { gemini: {} },
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ removeProviders: ["gemini"] });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.providers).toBeUndefined();
  });

  test("patch removes deleted providers from metadata generation", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const configPath = path.join(jagentdeskHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
              claude: {
                enabled: false,
              },
            },
            metadataGeneration: {
              providers: [
                { provider: "gemini", model: "flash" },
                { provider: "claude", model: "haiku" },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {
          gemini: {},
          claude: { enabled: false },
        },
        metadataGeneration: {
          providers: [
            { provider: "gemini", model: "flash" },
            { provider: "claude", model: "haiku" },
          ],
        },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.metadataGeneration.providers).toEqual([{ provider: "claude", model: "haiku" }]);
    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
    });
  });

  test("patch persists provider removal when in-memory config is already clean", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const configPath = path.join(jagentdeskHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            providers: {
              gemini: {
                extends: "acp",
                label: "Gemini",
                command: ["gemini", "--acp"],
              },
            },
            metadataGeneration: {
              providers: [{ provider: "gemini", model: "flash" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const next = store.patch({ removeProviders: ["gemini"] });

    expect(next.providers.gemini).toBeUndefined();
    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.providers).toBeUndefined();
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists plugins and the global plugin switch across restarts", () => {
    // Before this, plugins lived only in memory: a daemon restart dropped every installed plugin.
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);
    const initial = {
      mcp: { injectIntoAgents: false },
      browserTools: { enabled: false },
      providers: {},
      metadataGeneration: { providers: [] },
      autoArchiveAfterMerge: false,
      enableTerminalAgentHooks: false,
      appendSystemPrompt: "",
    };
    const store = new DaemonConfigStore(jagentdeskHome, initial, undefined);

    store.patch({
      pluginsEnabled: true,
      plugins: {
        monitor: { source: "directory", path: "/plugins/monitor", enabled: true },
        themes: { source: "directory", path: "/plugins/themes", enabled: false },
      },
    });
    let persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.pluginsEnabled).toBe(true);
    expect(Object.keys(persisted.plugins ?? {}).sort()).toEqual(["monitor", "themes"]);

    store.patch({ removePlugins: ["themes"] });
    persisted = loadPersistedConfig(jagentdeskHome);
    expect(Object.keys(persisted.plugins ?? {})).toEqual(["monitor"]);
  });

  test("patch persists append system prompt into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("preserves stored profile systemPrompt when omitted by an older client and clears on empty string", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);
    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      agentProfiles: [
        {
          id: "profile_ui",
          name: "UI work",
          provider: "claude",
          model: "claude-opus-5",
          systemPrompt: "  Focus on layout and design tokens.  ",
        },
      ],
    });
    expect(loadPersistedConfig(jagentdeskHome).daemon?.agentProfiles?.[0]?.systemPrompt).toBe(
      "Focus on layout and design tokens.",
    );

    // An older client edits the profile without sending `systemPrompt`.
    store.patch({
      agentProfiles: [
        {
          id: "profile_ui",
          name: "UI work updated",
          provider: "claude",
          model: "claude-opus-5",
        },
      ],
    });
    expect(loadPersistedConfig(jagentdeskHome).daemon?.agentProfiles?.[0]).toMatchObject({
      name: "UI work updated",
      systemPrompt: "Focus on layout and design tokens.",
    });

    // A newer client explicitly clears `systemPrompt` by sending an empty string.
    store.patch({
      agentProfiles: [
        {
          id: "profile_ui",
          name: "UI work updated",
          provider: "claude",
          model: "claude-opus-5",
          systemPrompt: "",
        },
      ],
    });
    expect(loadPersistedConfig(jagentdeskHome).daemon?.agentProfiles?.[0]).not.toHaveProperty(
      "systemPrompt",
    );
  });

  test("patch persists browser tools opt-in into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ browserTools: { enabled: true } });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.daemon?.browserTools).toEqual({ enabled: true });
  });

  test("patch persists fingerprint profiles and the active profile into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);
    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: true },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        appendSystemPrompt: "",
      },
      undefined,
    );
    const profile = generateFingerprintProfile({
      id: "bfp_a1b2c3",
      name: "work",
      os: "windows",
      nowMs: 1_790_000_000_000,
    });

    store.patch({ browserTools: { profiles: [profile] } });
    store.patch({ browserTools: { activeProfileId: profile.id } });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.daemon?.browserTools?.profiles).toEqual([profile]);
    expect(persisted.daemon?.browserTools?.activeProfileId).toBe(profile.id);
    expect(persisted.daemon?.browserTools?.enabled).toBe(true);
  });

  test("patch persists provider additional models into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      providers: {
        claude: {
          additionalModels: [
            {
              id: "claude-custom",
              label: "claude-custom",
            },
          ],
        },
      },
    });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.providers?.claude).toEqual({
      additionalModels: [
        {
          id: "claude-custom",
          label: "claude-custom",
        },
      ],
    });
  });

  test("patch persists daemon append system prompt into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      appendSystemPrompt: "Prefer terse replies.",
    });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.daemon?.appendSystemPrompt).toBe("Prefer terse replies.");
  });

  test("patch persists enable terminal agent hooks into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({ enableTerminalAgentHooks: true });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.daemon?.enableTerminalAgentHooks).toBe(true);
  });

  test("patch persists metadata generation providers into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    store.patch({
      metadataGeneration: {
        providers: [
          { provider: "claude", model: "haiku" },
          { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
        ],
      },
    });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.metadataGeneration).toEqual({
      providers: [
        { provider: "claude", model: "haiku" },
        { provider: "codex", model: "gpt-5.4-mini", thinkingOptionId: "low" },
      ],
    });
  });

  test("patch persists clearing metadata generation providers into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const configPath = path.join(jagentdeskHome, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          agents: {
            metadataGeneration: {
              providers: [{ provider: "claude", model: "haiku" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
      },
      undefined,
    );

    store.patch({ metadataGeneration: { providers: [] } });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.metadataGeneration).toEqual({ providers: [] });
  });

  test("patch persists and clears host metadata generation instructions without clobbering providers", async () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [{ provider: "claude", model: "haiku" }] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
    );

    const updated = await store.patch({
      metadataGeneration: {
        instructions: "  Write in Simplified Chinese.\nDo not use em dashes.  ",
      },
    });
    expect(updated.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
      instructions: "Write in Simplified Chinese.\nDo not use em dashes.",
    });
    // JAgentDesk writes the whole mutable metadataGeneration block back to config.json.
    expect(loadPersistedConfig(jagentdeskHome).agents?.metadataGeneration).toEqual({
      providers: [{ provider: "claude", model: "haiku" }],
      instructions: "Write in Simplified Chinese.\nDo not use em dashes.",
    });

    // Updating providers preserves instructions.
    const withProviders = await store.patch({
      metadataGeneration: {
        providers: [{ provider: "codex", model: "gpt-5.4-mini" }],
      },
    });
    expect(withProviders.metadataGeneration).toEqual({
      providers: [{ provider: "codex", model: "gpt-5.4-mini" }],
      instructions: "Write in Simplified Chinese.\nDo not use em dashes.",
    });
    expect(loadPersistedConfig(jagentdeskHome).agents?.metadataGeneration).toEqual({
      providers: [{ provider: "codex", model: "gpt-5.4-mini" }],
      instructions: "Write in Simplified Chinese.\nDo not use em dashes.",
    });

    // Removing a provider preserves instructions.
    const afterRemove = await store.patch({ removeProviders: ["codex"] });
    expect(afterRemove.metadataGeneration).toEqual({
      providers: [],
      instructions: "Write in Simplified Chinese.\nDo not use em dashes.",
    });
    expect(loadPersistedConfig(jagentdeskHome).agents?.metadataGeneration).toEqual({
      providers: [],
      instructions: "Write in Simplified Chinese.\nDo not use em dashes.",
    });

    // Clearing instructions with whitespace removes the key while preserving providers.
    const cleared = await store.patch({
      metadataGeneration: { instructions: "   \n  " },
    });
    expect(cleared.metadataGeneration).toEqual({ providers: [] });
    expect(cleared.metadataGeneration.instructions).toBeUndefined();
    expect(loadPersistedConfig(jagentdeskHome).agents?.metadataGeneration).toEqual({
      providers: [],
    });
  });

  test("patch persists the host idle runtime cleanup opt-out for the next daemon start", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);
    writeFileSync(
      path.join(jagentdeskHome, "config.json"),
      `${JSON.stringify({
        version: 1,
        agents: { metadataGeneration: { providers: [{ provider: "claude" }] } },
      })}\n`,
    );
    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        idleRuntimeCleanup: true,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [{ provider: "claude" }] },
      },
      undefined,
    );

    expect(store.patch({ idleRuntimeCleanup: false }).idleRuntimeCleanup).toBe(false);

    expect(loadPersistedConfig(jagentdeskHome).agents).toEqual({
      metadataGeneration: { providers: [{ provider: "claude" }] },
      idleRuntimeCleanup: false,
    });
    expect(loadConfig(jagentdeskHome, { env: {} }).idleRuntimeCleanup).toBe(false);

    store.patch({ idleRuntimeCleanup: true });
    expect(loadConfig(jagentdeskHome, { env: {} }).idleRuntimeCleanup).toBe(true);
  });

  test("patch persists custom ACP provider overrides into config.json", () => {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-store-"));
    tempDirs.push(jagentdeskHome);

    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        metadataGeneration: { providers: [] },
      },
      undefined,
    );

    store.patch({
      providers: {
        "jagentdesk-e2e-acp": {
          extends: "acp",
          label: "JAgentDesk E2E ACP",
          description: "E2E ACP provider fixture",
          command: ["npx", "-y", "--version"],
          env: {},
        },
      },
    });

    const persisted = loadPersistedConfig(jagentdeskHome);
    expect(persisted.agents?.providers?.["jagentdesk-e2e-acp"]).toEqual({
      extends: "acp",
      label: "JAgentDesk E2E ACP",
      description: "E2E ACP provider fixture",
      command: ["npx", "-y", "--version"],
      env: {},
    });
  });
});

describe("DaemonConfigStore speech settings", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function createSpeechStore(initialPersisted?: unknown, env: NodeJS.ProcessEnv = {}) {
    const jagentdeskHome = mkdtempSync(path.join(tmpdir(), "jagentdesk-daemon-config-speech-"));
    tempDirs.push(jagentdeskHome);
    if (initialPersisted) {
      writeFileSync(
        path.join(jagentdeskHome, "config.json"),
        `${JSON.stringify(initialPersisted, null, 2)}\n`,
      );
    }
    const persisted = loadPersistedConfig(jagentdeskHome);
    const applied: PersistedConfig[] = [];
    const speech = {
      read: (next: PersistedConfig) => readSpeechSettings(next, env),
      apply: (next: PersistedConfig) => applied.push(next),
    };
    const store = new DaemonConfigStore(
      jagentdeskHome,
      {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      },
      undefined,
      {
        speech,
      },
    );
    return { jagentdeskHome, store, applied, persisted };
  }

  test("reads, patches, and clears local STT language without losing it on other saves", () => {
    const { jagentdeskHome, store } = createSpeechStore({
      features: { dictation: { stt: { language: "fr" } } },
    });
    expect(store.get().features?.dictation.stt).toEqual({ provider: "local", language: "fr" });
    store.patch({ features: { voiceMode: { enabled: true } } });
    expect(loadPersistedConfig(jagentdeskHome).features?.dictation?.stt).toEqual({
      provider: "local",
      language: "fr",
    });
    const patched = store.patch({
      features: { dictation: { stt: { provider: "local", language: "de" } } },
    });
    expect(patched.features?.dictation.stt).toEqual({ provider: "local", language: "de" });
    store.patch({ features: { dictation: { stt: { language: null } } } });
    expect(loadPersistedConfig(jagentdeskHome).features?.dictation?.stt).toEqual({
      provider: "local",
    });
  });

  test("reports language env overrides for both local STT sites", () => {
    const { store } = createSpeechStore(
      {},
      { JAGENTDESK_DICTATION_LANGUAGE: "fr", JAGENTDESK_VOICE_LANGUAGE: "de" },
    );
    expect(store.get().envOverrides).toMatchObject({
      "features.dictation.stt.language": "JAGENTDESK_DICTATION_LANGUAGE",
      "features.voiceMode.stt.language": "JAGENTDESK_VOICE_LANGUAGE",
    });
  });

  test("keeps voice mode off until it is turned on", () => {
    const { jagentdeskHome, store } = createSpeechStore();

    expect(store.get().features?.dictation.enabled).toBe(true);
    expect(store.get().features?.voiceMode.enabled).toBe(false);

    const result = store.patch({ features: { voiceMode: { enabled: true } } });

    expect(result.features?.voiceMode.enabled).toBe(true);
    expect(loadPersistedConfig(jagentdeskHome).features?.voiceMode?.enabled).toBe(true);
  });

  test("stores the OpenAI key without ever returning it", () => {
    const { jagentdeskHome, store, applied } = createSpeechStore();

    const result = store.patch({
      features: { dictation: { stt: { provider: "openai", apiKey: " sk-test " } } },
    });

    expect(result.features?.dictation.stt).toEqual({ provider: "openai", hasApiKey: true });
    expect(JSON.stringify(result)).not.toContain("sk-test");
    expect(loadPersistedConfig(jagentdeskHome).features?.dictation?.stt).toMatchObject({
      apiKey: "sk-test",
    });
    expect(applied).toHaveLength(1);
  });

  test("applies a replaced key even though the visible settings do not change", () => {
    const { store, applied } = createSpeechStore({
      version: 1,
      features: { dictation: { stt: { provider: "openai", apiKey: "sk-old" } } },
    });

    store.patch({ features: { dictation: { stt: { apiKey: "sk-new" } } } });

    expect(applied.map((next) => next.features?.dictation?.stt)).toEqual([
      { provider: "openai", apiKey: "sk-new" },
    ]);
  });

  test("switching provider clears the previous provider's model", () => {
    const { jagentdeskHome, store } = createSpeechStore({
      version: 1,
      features: { dictation: { stt: { provider: "local", model: "parakeet-tdt-0.6b-v3-int8" } } },
    });

    const result = store.patch({ features: { dictation: { stt: { provider: "openai" } } } });

    expect(result.features?.dictation.stt).toEqual({ provider: "openai", hasApiKey: false });
    expect(loadPersistedConfig(jagentdeskHome).features?.dictation?.stt).toEqual({
      provider: "openai",
    });
  });

  test("rejects a local model id outside the catalog without persisting it", () => {
    const { jagentdeskHome, store, applied } = createSpeechStore();

    expect(() =>
      store.patch({ features: { voiceMode: { tts: { provider: "local", model: "nope" } } } }),
    ).toThrow("Unknown local voice model: nope");
    expect(loadPersistedConfig(jagentdeskHome).features?.voiceMode).toBeUndefined();
    expect(applied).toEqual([]);
  });

  test("merges same-provider fields and replaces the whole variant when provider changes", () => {
    const { jagentdeskHome, store } = createSpeechStore();
    store.patch({
      features: {
        voiceMode: {
          stt: { provider: "openai", apiKey: "secret", baseUrl: "https://site/v1", model: "first" },
        },
      },
    });
    store.patch({ features: { voiceMode: { stt: { model: "second", baseUrl: null } } } });
    expect(loadPersistedConfig(jagentdeskHome).features?.voiceMode?.stt).toEqual({
      provider: "openai",
      apiKey: "secret",
      model: "second",
    });
    store.patch({ features: { voiceMode: { stt: { provider: "openai", model: "third" } } } });
    expect(store.get().features?.voiceMode.stt).toEqual({
      provider: "openai",
      model: "third",
      hasApiKey: true,
    });
    store.patch({ features: { voiceMode: { stt: { apiKey: "new-secret" } } } });
    store.patch({ features: { voiceMode: { stt: { provider: "local" } } } });
    store.patch({ features: { voiceMode: { stt: { provider: "openai" } } } });
    expect(store.get().features?.voiceMode.stt).toEqual({ provider: "openai", hasApiKey: false });
  });

  test("keeps a saved OpenAI key when a full variant patch omits the write-only key", () => {
    const { jagentdeskHome, store } = createSpeechStore({
      features: { voiceMode: { stt: { provider: "openai", apiKey: "saved-secret" } } },
    });
    const result = store.patch({
      features: { voiceMode: { stt: { provider: "openai", model: "whisper-1" } } },
    });
    expect(result.features?.voiceMode.stt).toEqual({
      provider: "openai",
      model: "whisper-1",
      hasApiKey: true,
    });
    expect(loadPersistedConfig(jagentdeskHome).features?.voiceMode?.stt).toEqual({
      provider: "openai",
      apiKey: "saved-secret",
      model: "whisper-1",
    });
    expect(JSON.stringify(result)).not.toContain("saved-secret");
  });

  test("loads a legacy host, redacts its key and writes the normalized config after any save", () => {
    const { jagentdeskHome, store } = createSpeechStore({
      providers: { openai: { apiKey: "legacy-secret", stt: { baseUrl: "https://old/v1" } } },
      builtinPlugins: { "browser-tools": { enabled: false } },
      daemon: { relay: { enabled: false, endpoint: "relay.jagentdesk.local:443" } },
      agents: {
        providers: {
          "local-api": {
            extends: "opencode",
            label: "Local API",
            api: { protocol: "openai", baseUrl: "http://127.0.0.1:11434/v1", via: "direct" },
          },
        },
      },
      features: { voiceMode: { enabled: true, stt: { provider: "openai" } } },
    });
    expect(store.get().features?.voiceMode.stt).toEqual({
      provider: "openai",
      baseUrl: "https://old/v1",
      hasApiKey: true,
    });
    expect(JSON.stringify(store.get())).not.toContain("legacy-secret");
    store.patch({ autoArchiveAfterMerge: true });
    const disk = JSON.parse(readFileSync(path.join(jagentdeskHome, "config.json"), "utf8"));
    expect(disk.providers).not.toHaveProperty("openai");
    expect(disk.features.voiceMode.stt.apiKey).toBe("legacy-secret");
    expect(disk.builtinPlugins).toEqual({ "browser-tools": { enabled: false } });
    expect(disk.daemon.relay).toEqual({ enabled: false, endpoint: "relay.jagentdesk.local:443" });
    expect(disk.agents.providers["local-api"].api).toEqual({
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      via: "direct",
    });
  });

  test("reports env overrides and removes fallback provenance after saving a key", () => {
    const { store } = createSpeechStore(
      { features: { voiceMode: { stt: { provider: "openai", model: "configured" } } } },
      {
        JAGENTDESK_VOICE_STT_PROVIDER: "local",
        OPENAI_API_KEY: "env-secret",
      },
    );
    expect(store.get().features?.voiceMode.stt.provider).toBe("local");
    expect(store.get().envOverrides).toEqual({
      "features.voiceMode.stt.provider": "JAGENTDESK_VOICE_STT_PROVIDER",
    });
    const other = createSpeechStore(
      { features: { voiceMode: { stt: { provider: "openai" } } } },
      {
        OPENAI_API_KEY: "env-secret",
        OPENAI_STT_BASE_URL: "https://env/v1",
        STT_MODEL: "override",
      },
    ).store;
    expect(other.get().envOverrides).toEqual({
      "features.voiceMode.stt.apiKey": "OPENAI_API_KEY",
      "features.voiceMode.stt.baseUrl": "OPENAI_STT_BASE_URL",
      "features.voiceMode.stt.model": "STT_MODEL",
    });
    expect(other.get().features?.voiceMode.stt.hasApiKey).toBe(false);
    other.patch({
      features: { voiceMode: { stt: { apiKey: "saved-secret", baseUrl: "https://saved/v1" } } },
    });
    expect(other.get().envOverrides).toEqual({ "features.voiceMode.stt.model": "STT_MODEL" });
    expect(JSON.stringify(other.get())).not.toContain("secret");
  });
});
