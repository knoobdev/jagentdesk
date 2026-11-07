/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    colors: {
      surface0: "#111",
      surface1: "#161616",
      surfaceWorkspace: "#0a0a0a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#333",
      accent: "#2563eb",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (component: unknown) => component,
  useUnistyles: () => ({ theme }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  // Module-level imports in prototype-player.tsx (via page-outline) need these to exist.
  useHostRuntimeConnectionStatus: () => "connected",
  getHostRuntimeStore: () => ({ getSnapshot: () => ({ client: null }) }),
}));
vi.mock("@/data/query", () => ({ useFetchQuery: () => ({ data: undefined }) }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress, disabled, testID }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        type: "button",
        // Mirror the real control: a disabled button neither fires nor reports enabled.
        ...(disabled ? { disabled: true } : {}),
        "data-testid": (testID as string | undefined) ?? undefined,
        onClick: () => (disabled ? undefined : (onPress as () => void)?.()),
      },
      children as React.ReactNode,
    ),
}));
vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("div", { "data-spinner": true }),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children, testID }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { "data-testid": (testID as string | undefined) ?? "figma-flow-trigger" },
      children as React.ReactNode,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({ children, onSelect, testID }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": (testID as string | undefined) ?? undefined,
        onClick: () => (onSelect as (() => void) | undefined)?.(),
      },
      children as React.ReactNode,
    ),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: () => React.createElement("input", { type: "checkbox" }),
}));
vi.mock("./frame-stage", () => ({
  FrameStage: () => React.createElement("div", { "data-testid": "figma-frame-stage" }),
}));

import { PlayerToolbar } from "./prototype-player";
import {
  currentFrameId,
  DEFAULT_OVERLAY_SETTINGS,
  emptyPlayerState,
  step,
  type PlayerContext,
  type PlayerState,
} from "./state-machine";

// G4 bug 5: the toolbar label must name the flow being played for the whole session, not the
// frame currently on stage — navigating to a frame that starts no flow used to drop it back to
// "Select a flow" while the user was still inside "Shopping".

const flows = [
  { nodeId: "2:1", name: "Shopping", pageId: "p1" },
  { nodeId: "3:1", name: "Checkout", pageId: "p1" },
];

function renderToolbar(
  player: { startFrameId: string | null },
  options?: {
    overlayNote?: string | null;
    startNote?: string | null;
    onClose?: () => void;
    pages?: { id: string; name: string; loaded: boolean }[] | null;
    flowPageId?: string | null;
    onSelectFlowPage?: (pageId: string) => void;
    flowPageNote?: string | null;
    flowPageRetrying?: boolean;
    onRetryFlowPage?: () => void;
  },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(
      <PlayerToolbar
        flows={flows}
        pages={options?.pages ?? null}
        flowPageId={options?.flowPageId ?? null}
        onSelectFlowPage={options?.onSelectFlowPage ?? null}
        flowPageNote={options?.flowPageNote ?? null}
        flowPageRetrying={options?.flowPageRetrying ?? false}
        onRetryFlowPage={options?.onRetryFlowPage ?? null}
        startFrameId={player.startFrameId}
        canGoBack={false}
        canRestart={player.startFrameId !== null}
        showHotspots
        onStartFlow={vi.fn()}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        onToggleHotspots={vi.fn()}
        onClose={options?.onClose ?? vi.fn()}
        overlayNote={options?.overlayNote ?? null}
        startNote={options?.startNote ?? null}
      />,
    );
  });
  return {
    container,
    label: () => container.querySelector('[data-testid="figma-flow-trigger"]')?.textContent ?? "",
    pageLabel: () =>
      container.querySelector('[data-testid="figma-flow-page-trigger"]')?.textContent ?? "",
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const context: PlayerContext = {
  now_ms: () => 0,
  overlaySettingsFor: () => DEFAULT_OVERLAY_SETTINGS,
  afterTimeoutFor: () => null,
};

function playThenNavigate(startFrameId: string, destinationId: string): PlayerState {
  let state = step(emptyPlayerState(), { type: "start", frameId: startFrameId }, context).state;
  state = step(
    state,
    { type: "interaction", action: { kind: "navigate", destinationId, transition: null } },
    context,
  ).state;
  return state;
}

describe("PlayerToolbar flow label", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
  });

  it("keeps naming the started flow after navigating to a frame that starts none", () => {
    const player = playThenNavigate("2:1", "3:2");
    expect(currentFrameId(player)).toBe("3:2");
    const view = renderToolbar({ startFrameId: player.startFrameId });
    expect(view.label()).toContain("Shopping");
    expect(view.label()).not.toContain("Select a flow");
    view.unmount();
  });

  it("names the flow selected from the menu, not the stage frame", () => {
    const view = renderToolbar({ startFrameId: "3:1" });
    expect(view.label()).toContain("Checkout");
    view.unmount();
  });

  it("falls back to Select a flow before anything has started", () => {
    const view = renderToolbar({ startFrameId: null });
    expect(view.label()).toContain("Select a flow");
    view.unmount();
  });

  it("restart replays the same flow and keeps its name visible", () => {
    let state = step(emptyPlayerState(), { type: "start", frameId: "2:1" }, context).state;
    state = step(
      state,
      { type: "interaction", action: { kind: "navigate", destinationId: "9:9", transition: null } },
      context,
    ).state;
    state = step(state, { type: "toolbar_restart" }, context).state;
    expect(state.startFrameId).toBe("2:1");
    const view = renderToolbar({ startFrameId: state.startFrameId });
    expect(view.label()).toContain("Shopping");
    view.unmount();
  });

  // Real-Electron run 12: with a long flow name plus notes ahead of it in an unwrapped row, the
  // Close button overflowed the player's container and the Inspect panel intercepted its click.
  // The controls now live under stable testIDs the actual UI test can target — the container for
  // geometry and Close as a real, pressable control (layout itself is hit-tested in Electron at
  // narrow desktop and phone widths, not mirrored here).
  it("exposes the toolbar container and a pressable Close under their testIDs, even with notes shown", () => {
    const onClose = vi.fn();
    const view = renderToolbar(
      { startFrameId: "2:1" },
      {
        overlayNote: "Overlay positioning unavailable in this snapshot",
        startNote: "This frame starts no flow; opening it directly skips the flow entry point.",
        onClose,
      },
    );
    expect(view.container.querySelector('[data-testid="figma-prototype-toolbar"]')).toBeTruthy();
    const close = view.container.querySelector(
      '[data-testid="figma-prototype-close"]',
    ) as HTMLElement | null;
    expect(close).toBeTruthy();
    act(() => {
      close!.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

// ADR-0043: paged hosts list one page's flows at a time. The pages menu names every page, marks
// the ones the canvas has not read, and hands the choice to the player.
describe("PlayerToolbar flow pages menu", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
  });

  const pages = [
    { id: "0:1", name: "Light", loaded: true },
    { id: "0:2", name: "Dark", loaded: false },
  ];

  it("shows no pages menu for legacy fully-read outlines", () => {
    const view = renderToolbar({ startFrameId: "2:1" });
    expect(view.container.querySelector('[data-testid="figma-flow-page-trigger"]')).toBeNull();
    view.unmount();
  });

  it("names the browsed page and marks unread pages as not loaded", () => {
    const view = renderToolbar(
      { startFrameId: "2:1" },
      { pages, flowPageId: "0:1", onSelectFlowPage: vi.fn() },
    );
    expect(view.pageLabel()).toContain("Light");
    const dark = view.container.querySelector(
      '[data-testid="figma-flow-page-item-0:2"]',
    ) as HTMLElement | null;
    expect(dark?.textContent).toContain("Dark (not loaded)");
    const light = view.container.querySelector(
      '[data-testid="figma-flow-page-item-0:1"]',
    ) as HTMLElement | null;
    expect(light?.textContent).not.toContain("(not loaded)");
    view.unmount();
  });

  it("reports the selection to the player when a page is chosen", () => {
    const onSelectFlowPage = vi.fn();
    const view = renderToolbar(
      { startFrameId: "2:1" },
      { pages, flowPageId: "0:1", onSelectFlowPage },
    );
    const dark = view.container.querySelector(
      '[data-testid="figma-flow-page-item-0:2"]',
    ) as HTMLElement;
    act(() => {
      dark.click();
    });
    expect(onSelectFlowPage).toHaveBeenCalledWith("0:2");
    view.unmount();
  });

  it("shows a failed page read with a Retry that is disabled while retrying", () => {
    const onRetryFlowPage = vi.fn();
    const view = renderToolbar(
      { startFrameId: "2:1" },
      {
        pages,
        flowPageId: "0:2",
        onSelectFlowPage: vi.fn(),
        flowPageNote: 'Flows on "Dark" failed to load: host offline',
        onRetryFlowPage,
      },
    );
    expect(view.container.textContent).toContain('Flows on "Dark" failed to load');
    const retry = view.container.querySelector(
      '[data-testid="figma-flow-page-retry"]',
    ) as HTMLElement;
    act(() => {
      retry.click();
    });
    expect(onRetryFlowPage).toHaveBeenCalledTimes(1);
    view.unmount();

    const retrying = renderToolbar(
      { startFrameId: "2:1" },
      {
        pages,
        flowPageId: "0:2",
        onSelectFlowPage: vi.fn(),
        flowPageNote: 'Flows on "Dark" failed to load: host offline',
        flowPageRetrying: true,
        onRetryFlowPage,
      },
    );
    const retryButton = retrying.container.querySelector(
      '[data-testid="figma-flow-page-retry"]',
    ) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(true);
    retrying.unmount();
  });
});
