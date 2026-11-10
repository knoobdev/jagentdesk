import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { MemorySecretStore } from "../database/secret-store.js";
import { extractProviderOverrides } from "../config.js";
import { loadPersistedConfig } from "../persisted-config.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { ProviderCatalogSession } from "../session/provider/provider-catalog-session.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { ProviderUsageService } from "../../services/quota-fetcher/service.js";
import { createCustomProviderService } from "./service.js";
import { writeAgentProviderEntry } from "./config-storage.js";

// Spec 34.6 integration: a providers.custom.save/delete hot-reloads the provider
// registry and PUSHES a providers_snapshot_update to every connected session —
// including sessions that have not pulled a snapshot yet (a fresh daemon process).
// Found by the coordinator's live test: save succeeded but no push ever arrived.

function createHome(): string {
  return mkdtempSync(path.join(tmpdir(), "jagentdesk-cp-hot-reload-"));
}

function disableBuiltins(home: string): void {
  for (const builtin of ["claude", "codex", "copilot", "opencode", "pi", "omp"]) {
    writeAgentProviderEntry(home, builtin, { enabled: false });
  }
}

function makeSession(manager: ProviderSnapshotManager) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new ProviderCatalogSession({
    host: {
      emit: (msg) => emitted.push(msg),
      isProviderVisibleToClient: () => true,
      supportsCustomModeIcons: () => true,
      listProviderAvailability: async () => [],
      listDraftFeatures: async () => [],
    },
    providerSnapshotManager: manager,
    providerUsageService: {} as ProviderUsageService,
    logger: createTestLogger(),
  });
  session.start();
  return { emitted };
}

/** Bootstrap-shaped wiring: reloadRegistry re-extracts config.json as base overrides. */
function makeHarness(home: string) {
  let manager: ProviderSnapshotManager = null as unknown as ProviderSnapshotManager;
  const service = createCustomProviderService({
    jagentdeskHome: home,
    logger: createTestLogger(),
    secretStore: new MemorySecretStore(),
    getTailnetSocks: () => null,
    reloadRegistry: (removeProviders) => {
      const persisted = loadPersistedConfig(home);
      const baseOverrides = extractProviderOverrides(
        persisted.agents?.providers as Record<string, unknown> | undefined,
      );
      manager.applyMutableProviderConfig(undefined, {
        baseOverrides: baseOverrides ?? {},
        removeProviders,
      });
    },
  });
  manager = new ProviderSnapshotManager({
    logger: createTestLogger(),
    openCodeProviderInjection: (providerId) => service.materializeOpenCodeProvider(providerId),
    claudeSpawnEnv: (providerId) => service.materializeClaudeEnv(providerId),
  });
  const { emitted } = makeSession(manager);
  return { service, manager, emitted };
}

function snapshotPushes(emitted: SessionOutboundMessage[]): Array<{
  cwd?: string;
  entries: Array<{ provider: string; status: string; description?: string; models?: unknown[] }>;
}> {
  return emitted
    .filter((msg) => msg.type === "providers_snapshot_update")
    .map((msg) => (msg as { payload: { cwd?: string; entries: never[] } }).payload);
}

const LOCAL_QWEN = {
  id: "local-qwen",
  label: "Local Qwen",
  protocol: "openai" as const,
  baseUrl: "http://127.0.0.1:11434",
  models: [
    {
      id: "qwen2.5:3b",
      label: "Qwen 2.5 3B",
      thinkingOptions: [{ id: "think", label: "think" }],
    },
  ],
};

describe("providers.custom.save hot-reload push (spec 34.6)", () => {
  test("save pushes providers_snapshot_update to a session that never pulled, and the entry reaches ready with the declared models", async () => {
    const home = createHome();
    disableBuiltins(home);
    const { service, manager, emitted } = makeHarness(home);
    try {
      // No snapshot pull happened before the save — the live-test scenario.
      await service.save({
        mode: "create",
        provider: { ...LOCAL_QWEN, description: "Runs on my box" },
      });

      const pushes = snapshotPushes(emitted);
      expect(pushes.length).toBeGreaterThan(0);
      const pushedEntry = pushes
        .flatMap((push) => push.entries)
        .find((entry) => entry.provider === "local-qwen");
      expect(pushedEntry).toBeDefined();
      // The api provider's own description, never the opencode base description.
      expect(pushedEntry?.description).toBe("Runs on my box");

      // An api provider with declared models reaches ready without runtime
      // discovery (replacement models + the base's static modes).
      const entry = await manager.getProvider({ provider: "local-qwen", wait: true });
      expect(entry.status).toBe("ready");
      expect(entry.models?.map((model) => model.id)).toEqual(["local-qwen/qwen2.5:3b"]);
      expect(entry.models?.[0]?.thinkingOptions?.map((option) => option.id)).toEqual(["think"]);
    } finally {
      manager.destroy();
    }
  });

  test("delete pushes a providers_snapshot_update without the removed provider", async () => {
    const home = createHome();
    disableBuiltins(home);
    const { service, manager, emitted } = makeHarness(home);
    try {
      await service.save({ mode: "create", provider: LOCAL_QWEN });
      emitted.length = 0;
      await service.delete("local-qwen");

      const pushes = snapshotPushes(emitted);
      expect(pushes.length).toBeGreaterThan(0);
      for (const push of pushes) {
        expect(push.entries.some((entry) => entry.provider === "local-qwen")).toBe(false);
      }
      expect(manager.hasProvider("local-qwen")).toBe(false);
    } finally {
      manager.destroy();
    }
  });
});
