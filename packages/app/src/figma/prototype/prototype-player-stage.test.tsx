/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

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
    React.createElement("div", null, children),
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

import { PlayerStage } from "./prototype-player";
import type { FrameLookup } from "./use-frames";

// F5 bug 1: the player must never sit on an endless spinner. The spinner only means "frames are
// actually loading"; otherwise the stage shows a choose-a-flow prompt or the honest empty message.

const file = { serverId: "s1", fileKey: "fk1" };
const flows = [
  { nodeId: "2:1", name: "Onboarding", pageId: "p1" },
  { nodeId: "3:1", name: "Checkout", pageId: "p1" },
];

function lookup(overrides: Partial<FrameLookup> = {}): FrameLookup {
  return { loading: false, error: null, nodeFor: () => null, ...overrides };
}

interface StageProps {
  transition: null;
  timeline: null;
  frames: FrameLookup;
  stage: { width: number; height: number };
  root: FigmaNode | null;
  activeFrameId: string | null;
  scrollRequest: null;
  renderHotspots: () => null;
  showHotspots: boolean;
  loadingPrototype: boolean;
  flows: typeof flows;
  onStartFlow: (frameId: string) => void;
}

function renderStage(overrides: Partial<StageProps> = {}) {
  const onStartFlow = vi.fn();
  const props: StageProps = {
    transition: null,
    timeline: null,
    frames: lookup(),
    stage: { width: 375, height: 600 },
    root: null,
    activeFrameId: null,
    scrollRequest: null,
    renderHotspots: () => null,
    showHotspots: true,
    loadingPrototype: false,
    flows,
    onStartFlow,
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(<PlayerStage file={file} {...props} />);
  });
  return {
    text: () => container.textContent ?? "",
    container,
    clickFlow: (name: string) => {
      const rows = [...container.querySelectorAll("div[role='button'],button")];
      const row = rows.find((el) => (el.textContent ?? "").trim() === name);
      expect(row, `flow row "${name}"`).toBeTruthy();
      act(() => {
        row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    onStartFlow,
  };
}

describe("PlayerStage start states", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
  });

  it("spins only while the prototype request is pending", () => {
    const view = renderStage({ loadingPrototype: true });
    expect(view.container.querySelector("[data-spinner]")).toBeTruthy();
    expect(view.text()).not.toContain("Choose a flow");
    expect(view.text()).not.toContain("No prototype flows");
    view.unmount();
  });

  it("spins while frames load, never after", () => {
    const view = renderStage({ frames: lookup({ loading: true }) });
    expect(view.container.querySelector("[data-spinner]")).toBeTruthy();
    expect(view.text()).not.toContain("Choose a flow");
    view.unmount();
  });

  it("shows a choose-a-flow prompt listing the flows instead of spinning forever", () => {
    const view = renderStage();
    expect(view.text()).toContain("Choose a flow");
    expect(view.text()).toContain("Onboarding");
    expect(view.text()).toContain("Checkout");
    expect(view.container.querySelector("[data-spinner]")).toBeNull();
    view.clickFlow("Onboarding");
    expect(view.onStartFlow).toHaveBeenCalledWith("2:1");
    view.unmount();
  });

  it("reports an empty file honestly when there are neither flows nor frames", () => {
    const view = renderStage({ flows: [] });
    expect(view.text()).toContain("No prototype flows in this file.");
    expect(view.text()).not.toContain("Choose a flow");
    view.unmount();
  });

  it("surfaces a frame fetch error instead of the spinner", () => {
    const view = renderStage({ frames: lookup({ error: "boom" }) });
    expect(view.text()).toContain("boom");
    expect(view.container.querySelector("[data-spinner]")).toBeNull();
    view.unmount();
  });

  it("renders the stage when a root exists and nothing is loading", () => {
    const node = { id: "1:1", name: "Home", type: "FRAME", children: [] } as FigmaNode;
    const view = renderStage({
      root: node,
      activeFrameId: "1:1",
      frames: lookup({ nodeFor: () => node }),
    });
    expect(view.container.querySelector("[data-testid='figma-frame-stage']")).toBeTruthy();
    expect(view.container.querySelector("[data-spinner]")).toBeNull();
    view.unmount();
  });
});
