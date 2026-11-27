import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { buildFavoriteModelKey } from "@/hooks/use-form-preferences";
import type { ProviderSelectorProvider } from "@/provider-selection/provider-selection";
import { ModelBrowser, type ModelBrowserState } from "./model-browser";

// Load translations so controls expose their real accessible names.
void testI18n;

const testQueryClient = new QueryClient();

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
    serverId: null,
    profiles: null,
    showAll: () => {},
    view: { kind: "provider", providerId: provider, providerLabel: "Claude" },
    searchQuery: "",
    isSearchFocused: false,
    header: { title: "Model" },
    keyboard: { keys: [], onKeyDown: () => false },
    selectedModelLabel: "Sonnet",
    triggerLabel: "Sonnet",
    desktopFixedHeight: undefined,
    isProviderView: true,
    explicitActiveKey: null,
    preferredActiveKey: null,
    setActiveKey: () => {},
    focusSearchInput: () => {},
    registerKeyboardHandler: () => {},
    prepareToOpen: () => {},
    reset: () => {},
    drillDown: () => {},
  };
}

function mountBrowser() {
  const onSelect = vi.fn<(provider: string, modelId: string) => void>();
  const onCreateProfile = vi.fn<() => void>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={testQueryClient}>
        <ModelBrowser state={buildState()} onSelect={onSelect} onCreateProfile={onCreateProfile} />
      </QueryClientProvider>,
    ),
  );
  mounted.push({ root, container });
  return { container, onSelect, onCreateProfile };
}

describe("model browser rows on web", () => {
  it("keeps the profile action out of the row's button", () => {
    const { container } = mountBrowser();
    const favorite = container.querySelector(
      `[data-testid="model-create-profile-${provider}-${modelId}"]`,
    );
    expect(favorite).not.toBeNull();
    expect(container.querySelector("button button")).toBeNull();
  });

  it("creates a profile without selecting the model", () => {
    const { container, onSelect, onCreateProfile } = mountBrowser();
    const favorite = container.querySelector<HTMLElement>(
      `[data-testid="model-create-profile-${provider}-${modelId}"]`,
    );
    act(() => favorite?.click());
    expect(onCreateProfile).toHaveBeenCalledWith(expect.objectContaining({ provider, modelId }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
