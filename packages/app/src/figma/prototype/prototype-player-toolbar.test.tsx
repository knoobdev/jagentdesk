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
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));
vi.mock("@/data/query", () => ({ useFetchQuery: () => ({ data: undefined }) }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress, disabled }: Record<string, unknown>) =>
    React.createElement(
      "button",
      {
        type: "button",
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
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "figma-flow-trigger" }, children),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
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

function renderToolbar(player: { startFrameId: string | null }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: ReturnType<typeof createRoot>;
  act(() => {
    root = createRoot(container);
    root.render(
      <PlayerToolbar
        flows={flows}
        startFrameId={player.startFrameId}
        canGoBack={false}
        canRestart={player.startFrameId !== null}
        showHotspots
        onStartFlow={vi.fn()}
        onBack={vi.fn()}
        onRestart={vi.fn()}
        onToggleHotspots={vi.fn()}
        onClose={vi.fn()}
        overlayNote={null}
        startNote={null}
      />,
    );
  });
  return {
    label: () => container.querySelector('[data-testid="figma-flow-trigger"]')?.textContent ?? "",
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
});
