import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
} from "./agent-sdk-types.js";
import type { ProviderOverride } from "./provider-launch-config.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";

// Spec 04 §5: saving or deleting a custom API provider refreshes that provider once; other
// providers keep their client, their processes and their snapshot entries, and a provider whose
// endpoint refuses goes to `error` without being retried.

const DISABLED_BUILTINS: Record<string, ProviderOverride> = {
  claude: { enabled: false },
  copilot: { enabled: false },
  opencode: { enabled: false },
  pi: { enabled: false },
};

function codexClient(fetchCatalog: AgentClient["fetchCatalog"]): AgentClient {
  return {
    provider: "codex",
    capabilities: {
      supportsStreaming: false,
      supportsSessionPersistence: false,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
    fetchCatalog,
    async isAvailable() {
      return true;
    },
  };
}

function countingCatalog() {
  return vi.fn(async () => ({
    models: [{ provider: "codex", id: "gpt-test", label: "GPT test" }] as AgentModelDefinition[],
    modes: [] as AgentMode[],
  }));
}

const CWD_A = resolve("/tmp/jagentdesk-config-change-a");
const CWD_B = resolve("/tmp/jagentdesk-config-change-b");

async function warm(manager: ProviderSnapshotManager, provider: AgentProvider): Promise<void> {
  await manager.getProvider({ provider, wait: true });
  await manager.getProvider({ cwd: CWD_A, provider, wait: true });
  await manager.getProvider({ cwd: CWD_B, provider, wait: true });
}

describe("ProviderSnapshotManager config changes", () => {
  test("adding a custom provider leaves other providers' entries and catalogs alone", async () => {
    const fetchCatalog = countingCatalog();
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: DISABLED_BUILTINS,
      extraClients: { codex: codexClient(fetchCatalog) },
    });
    try {
      await warm(manager, "codex");
      expect(fetchCatalog).toHaveBeenCalledTimes(3);
      const listener = vi.fn();
      manager.on("change", listener);

      manager.applyMutableProviderConfig(undefined, {
        baseOverrides: { ...DISABLED_BUILTINS, fx: { extends: "codex", label: "FX" } },
        changedProviders: ["fx"],
      });

      for (const cwd of [undefined, CWD_A, CWD_B]) {
        const codex = manager.getSnapshot(cwd).find((entry) => entry.provider === "codex");
        expect(codex?.status).toBe("ready");
      }
      expect(fetchCatalog).toHaveBeenCalledTimes(3);
      // Every snapshot still announces the new provider.
      const announced = listener.mock.calls
        .flatMap(([entries]) => entries as Array<{ provider: string }>)
        .map((entry) => entry.provider);
      expect(announced).toContain("fx");
    } finally {
      manager.destroy();
    }
  });

  test("keeps the client of an unchanged provider and replaces the changed one", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        ...DISABLED_BUILTINS,
        claude: { enabled: true },
        "zai-a": { extends: "claude", label: "A" },
        "zai-b": { extends: "claude", label: "B" },
      },
    });
    try {
      const before = manager.getAgentManagerProviderState().clients;
      const staged = manager.stageMutableProviderConfig(undefined, {
        baseOverrides: {
          ...DISABLED_BUILTINS,
          claude: { enabled: true },
          "zai-a": { extends: "claude", label: "A" },
          "zai-b": { extends: "claude", label: "B renamed" },
        },
      });
      const after = staged.agentManagerState.clients;
      staged.rollback();

      expect(after.claude).toBe(before.claude);
      expect(after["zai-a"]).toBe(before["zai-a"]);
      expect(after["zai-b"]).not.toBe(before["zai-b"]);
    } finally {
      manager.destroy();
    }
  });

  test("a changed base provider also replaces the providers derived from it", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        ...DISABLED_BUILTINS,
        claude: { enabled: true },
        "zai-a": { extends: "claude", label: "A" },
      },
    });
    try {
      const before = manager.getAgentManagerProviderState().clients;
      const staged = manager.stageMutableProviderConfig(undefined, {
        baseOverrides: {
          ...DISABLED_BUILTINS,
          claude: { enabled: true, env: { CLAUDE_TEST_FLAG: "1" } },
          "zai-a": { extends: "claude", label: "A" },
        },
      });
      const after = staged.agentManagerState.clients;
      staged.rollback();

      expect(after.claude).not.toBe(before.claude);
      expect(after["zai-a"]).not.toBe(before["zai-a"]);
    } finally {
      manager.destroy();
    }
  });

  test("the registry's client forwards retire to the provider's own client", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: { ...DISABLED_BUILTINS, opencode: { enabled: true } },
    });
    try {
      // OpenCode's client owns a helper server; a wrapper without retire would leak it.
      expect(typeof manager.getAgentManagerProviderState().clients.opencode?.retire).toBe(
        "function",
      );
    } finally {
      manager.destroy();
    }
  });

  test("retires a client the registry replaced, once the change is published", () => {
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: {
        ...DISABLED_BUILTINS,
        claude: { enabled: true },
        "zai-a": { extends: "claude", label: "A", enabled: false },
      },
    });
    try {
      const claude = manager.getAgentManagerProviderState().clients.claude!;
      const retire = vi.fn(async () => {});
      claude.retire = retire;

      const staged = manager.stageMutableProviderConfig(undefined, {
        baseOverrides: { ...DISABLED_BUILTINS, claude: { enabled: false } },
      });
      expect(retire).not.toHaveBeenCalled();
      staged.rollback();

      manager.applyMutableProviderConfig(undefined, {
        baseOverrides: { ...DISABLED_BUILTINS, claude: { enabled: false } },
      });
      expect(retire).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });

  test("a provider whose endpoint refuses shows error once and is not retried in the background", async () => {
    const checkApiProviderEndpoint = vi.fn(async (provider: AgentProvider) => {
      if (provider === "fx") throw new Error("The models endpoint answered HTTP 401");
    });
    const timers: Array<() => void> = [];
    let now = 0;
    const manager = new ProviderSnapshotManager({
      logger: createTestLogger(),
      providerOverrides: DISABLED_BUILTINS,
      extraClients: { codex: codexClient(countingCatalog()) },
      checkApiProviderEndpoint,
      backgroundRefresh: {
        intervalMs: 1_000,
        timers: {
          now: () => now,
          schedule: (run) => {
            timers.push(run);
            return () => {};
          },
        },
      },
    });
    try {
      await warm(manager, "codex");
      manager.applyMutableProviderConfig(undefined, {
        baseOverrides: { ...DISABLED_BUILTINS, fx: { extends: "codex", label: "FX" } },
        changedProviders: ["fx"],
      });

      for (const cwd of [undefined, CWD_A, CWD_B]) {
        const entry = await manager.getProvider({ cwd, provider: "fx", wait: true });
        expect(entry.status).toBe("error");
        expect(entry.error).toContain("HTTP 401");
      }
      // Three snapshots refreshed at once share one check.
      expect(checkApiProviderEndpoint).toHaveBeenCalledTimes(1);

      // Background ticks well past the interval never ask the refusing endpoint again.
      now = 10_000;
      for (let tick = 0; tick < 6; tick += 1) timers.shift()?.();
      await new Promise((settle) => setTimeout(settle, 0));
      expect(checkApiProviderEndpoint).toHaveBeenCalledTimes(1);
    } finally {
      manager.destroy();
    }
  });
});
