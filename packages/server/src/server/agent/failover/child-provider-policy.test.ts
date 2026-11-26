import { describe, expect, it } from "vitest";
import {
  checkChildProvider,
  parseProviderModel,
  rankChildProviders,
} from "./child-provider-policy.js";

const label = (provider: string) =>
  ({ claude: "Claude", codex: "Codex", opencode: "OpenCode" })[provider] ?? provider;

describe("parseProviderModel", () => {
  it("keeps slashes inside the model", () => {
    expect(parseProviderModel("opencode/openrouter/google/x")).toEqual({
      provider: "opencode",
      model: "openrouter/google/x",
    });
    expect(parseProviderModel("codex")).toEqual({ provider: "codex", model: null });
    expect(parseProviderModel(undefined)).toBeNull();
  });
});

describe("checkChildProvider", () => {
  const enabled = {
    enabled: true,
    allowed: [
      { provider: "opencode", model: "openai/gpt-5.4-mini" },
      { provider: "codex", model: null },
    ],
  };

  it("always allows the parent's own provider and an omitted provider", () => {
    for (const requested of [null, { provider: "claude", model: "opus" }]) {
      expect(
        checkChildProvider({
          config: { enabled: false, allowed: [] },
          parentProvider: "claude",
          requested,
          lastUserMessage: null,
          providerLabel: label,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("allows entries of the allowed list when enabled and rejects others clearly", () => {
    const check = (provider: string, model: string | null) =>
      checkChildProvider({
        config: enabled,
        parentProvider: "claude",
        requested: { provider, model },
        lastUserMessage: null,
        providerLabel: label,
      });
    expect(check("opencode", "openai/gpt-5.4-mini")).toEqual({ ok: true });
    expect(check("codex", "gpt-5.6")).toEqual({ ok: true });
    const rejected = check("opencode", "openai/gpt-5.5");
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? "" : rejected.error).toContain("not an allowed child provider");
    expect(rejected.ok ? "" : rejected.error).toContain("opencode/openai/gpt-5.4-mini");
  });

  it("when disabled, allows another provider only if the user named it", () => {
    const check = (lastUserMessage: string) =>
      checkChildProvider({
        config: { enabled: false, allowed: [] },
        parentProvider: "claude",
        requested: { provider: "codex", model: null },
        lastUserMessage,
        providerLabel: label,
      });
    expect(check("Spawn a helper on Codex to review this")).toEqual({ ok: true });
    const rejected = check("Spawn a helper to review this");
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? "" : rejected.error).toContain("your own provider (claude)");
  });
});

describe("rankChildProviders", () => {
  it("suggests the entry with the most quota left", () => {
    const entries = rankChildProviders({
      allowed: [
        { provider: "codex", model: null },
        { provider: "opencode", model: "x" },
      ],
      quota: (provider) =>
        provider === "codex"
          ? { remainingPercent: 12, resetsAt: "2026-11-26T20:00:00Z" }
          : { remainingPercent: 80, resetsAt: null },
    });
    expect(entries.map((entry) => [entry.provider, entry.suggested])).toEqual([
      ["codex", false],
      ["opencode", true],
    ]);
  });

  it("suggests the first entry when Usage knows none of them", () => {
    const entries = rankChildProviders({
      allowed: [
        { provider: "codex", model: null },
        { provider: "opencode", model: "x" },
      ],
      quota: () => ({ remainingPercent: null, resetsAt: null }),
    });
    expect(entries[0]?.suggested).toBe(true);
    expect(entries[1]?.suggested).toBe(false);
  });
});
