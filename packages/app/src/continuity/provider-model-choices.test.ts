import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import {
  addableModels,
  addableProviders,
  DEFAULT_MODEL_CHOICE,
  describeProviderModel,
  toProviderModelRef,
} from "./provider-model-choices";

const claude: ProviderSnapshotEntry = {
  provider: "claude",
  status: "ready",
  enabled: true,
  label: "Claude",
  models: [
    { provider: "claude", id: "opus", label: "Opus 5.5" },
    { provider: "claude", id: "sonnet", label: "Sonnet 5.5" },
    { provider: "claude", id: "hidden", label: "Hidden", isSelectable: false },
  ],
};
const codex: ProviderSnapshotEntry = {
  provider: "codex",
  status: "ready",
  enabled: true,
  label: "Codex",
  models: [{ provider: "codex", id: "gpt-6.2-sol", label: "GPT-6.2-Sol" }],
};
const copilotOff: ProviderSnapshotEntry = { provider: "copilot", status: "ready", enabled: false };
const opencodeBroken: ProviderSnapshotEntry = {
  provider: "opencode",
  status: "unavailable",
  enabled: true,
};
const piLoading: ProviderSnapshotEntry = { provider: "pi", status: "loading", enabled: true };

describe("addableProviders", () => {
  it("offers only enabled, ready providers", () => {
    expect(
      addableProviders([claude, codex, copilotOff, opencodeBroken, piLoading], []).map(
        (choice) => choice.provider,
      ),
    ).toEqual(["claude", "codex"]);
  });

  it("hides a provider already listed with its default model", () => {
    expect(
      addableProviders([claude, codex], [{ provider: "codex", model: null }]).map(
        (choice) => choice.provider,
      ),
    ).toEqual(["claude"]);
  });

  it("keeps a provider listed only with a specific model", () => {
    expect(
      addableProviders([claude, codex], [{ provider: "codex", model: "gpt-6.2-sol" }]).map(
        (choice) => choice.provider,
      ),
    ).toEqual(["claude", "codex"]);
  });
});

describe("addableModels", () => {
  it("starts with Default model and lists only the chosen provider's selectable models", () => {
    expect(addableModels(claude, [], "Default model")).toEqual([
      { id: DEFAULT_MODEL_CHOICE, label: "Default model" },
      { id: "opus", label: "Opus 5.5" },
      { id: "sonnet", label: "Sonnet 5.5" },
    ]);
  });

  it("hides models already in the list", () => {
    expect(
      addableModels(
        claude,
        [
          { provider: "claude", model: "opus" },
          { provider: "codex", model: "sonnet" },
        ],
        "Default model",
      ).map((choice) => choice.id),
    ).toEqual([DEFAULT_MODEL_CHOICE, "sonnet"]);
  });

  it("is empty until a provider is chosen", () => {
    expect(addableModels(undefined, [], "Default model")).toEqual([]);
  });
});

describe("toProviderModelRef", () => {
  it("stores Default model as a null model", () => {
    expect(toProviderModelRef("codex", DEFAULT_MODEL_CHOICE)).toEqual({
      provider: "codex",
      model: null,
    });
    expect(toProviderModelRef("codex", "gpt-6.2-sol")).toEqual({
      provider: "codex",
      model: "gpt-6.2-sol",
    });
  });
});

describe("describeProviderModel", () => {
  it("reads the snapshot's provider and model names", () => {
    expect(
      describeProviderModel({ provider: "codex", model: "gpt-6.2-sol" }, [codex], "Default model"),
    ).toEqual({ providerLabel: "Codex", modelLabel: "GPT-6.2-Sol" });
    expect(
      describeProviderModel({ provider: "claude", model: null }, [claude], "Default model"),
    ).toEqual({ providerLabel: "Claude", modelLabel: "Default model" });
  });

  it("falls back to the model id when the provider no longer lists it", () => {
    expect(
      describeProviderModel({ provider: "codex", model: "retired" }, [codex], "Default model")
        .modelLabel,
    ).toBe("retired");
  });
});
