import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { buildFavoriteModelKey } from "@/hooks/use-form-preferences";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ModelBrowser, type ModelBrowserState } from "./model-browser";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

const provider = "claude";
const modelId = "sonnet";
const favoriteKey = buildFavoriteModelKey({ provider, modelId });

const providers: ProviderSelectorProvider[] = [
  {
    id: provider,
    label: "Claude",
    modelSelection: {
      kind: "models",
      rows: [{ favoriteKey, provider, providerLabel: "Claude", modelId, modelLabel: "Sonnet" }],
    },
  },
];

function buildState(): ModelBrowserState {
  return {
    providers,
    selectedProvider: provider,
    selectedModel: modelId,
    favoriteKeys: new Set([favoriteKey]),
    view: { kind: "all" },
    searchQuery: "",
    header: { title: "Model" },
    selectedModelLabel: "Sonnet",
    triggerLabel: "Sonnet",
    desktopFixedHeight: undefined,
    isProviderView: false,
    prepareToOpen: () => {},
    reset: () => {},
    drillDown: () => {},
  };
}

function mountBrowser() {
  const onSelect = vi.fn<(provider: string, modelId: string) => void>();
  const onToggleFavorite = vi.fn<(provider: string, modelId: string) => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ModelBrowser state={buildState()} onSelect={onSelect} onToggleFavorite={onToggleFavorite} />,
    ),
  );
  mounted.push({ root, container });
  return { container, onSelect, onToggleFavorite };
}

describe("model browser rows on web", () => {
  it("keeps the favorite toggle out of the row's button", () => {
    const { container } = mountBrowser();
    const favorite = container.querySelector(
      `[data-testid="favorite-model-${provider}-${modelId}"]`,
    );
    expect(favorite).not.toBeNull();
    expect(container.querySelector("button button")).toBeNull();
  });

  it("toggles the favorite without selecting the model", () => {
    const { container, onSelect, onToggleFavorite } = mountBrowser();
    const favorite = container.querySelector<HTMLElement>(
      `[data-testid="favorite-model-${provider}-${modelId}"]`,
    );
    act(() => favorite?.click());
    expect(onToggleFavorite).toHaveBeenCalledWith(provider, modelId);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
