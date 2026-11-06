/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, captured, outlineFixture, queueOverrides } = vi.hoisted(() => {
  const uiTheme = {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    colors: {
      surface0: "#0a0a0a",
      surface1: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      border: "#555",
      accent: "#0a84ff",
      statusDanger: "#ff0000",
      palette: { red: { 300: "#ff6b6b" }, white: "#fff" },
    },
  };
  return {
    theme: uiTheme,
    // Props the screen hands the toolbar / inspect panel / canvas — the wiring contract.
    captured: {
      toolbar: null as Record<string, unknown> | null,
      inspect: null as Record<string, unknown> | null,
      canvas: null as Record<string, unknown> | null,
    },
    outlineFixture: {
      name: "Design file",
      pages: [{ id: "p1", name: "Page 1", frames: [], children: [] }],
    },
    queueOverrides: { "1:1": { name: "Queued" } },
  };
});

// The pending queue RPC promises are the whole point of this wiring test: the callbacks the
// screen passes to the toolbar must be the live promises (the toolbar surfaces their
// rejections), not voided calls.
const { editsState } = vi.hoisted(() => ({
  editsState: {
    current: {
      linked: false,
      pendingCount: 1,
      overrides: {} as Record<string, unknown>,
      applyEdits: vi.fn(async () => undefined),
      applyPending: vi.fn(() => Promise.resolve()),
      discardPending: vi.fn(() => Promise.resolve()),
    },
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("expo-router", () => ({
  router: { setParams: vi.fn(async () => undefined), replace: vi.fn(async () => undefined) },
  useLocalSearchParams: () => ({}),
}));
vi.mock("@/jira/ui/styles", () => {
  const style = new Proxy({}, { get: () => ({}) });
  return { jiraStyles: style };
});
vi.mock("@/jira/ui/primitives", () => ({
  EmptyState: () => React.createElement("div", { "data-testid": "empty-state" }),
  ErrorBanner: ({ message }: { message: string }) =>
    React.createElement("span", { "data-testid": "error-banner" }, message),
  Tabs: () => React.createElement("div", null),
}));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock("lucide-react-native", () => {
  const icon = () => () => React.createElement("i");
  return { PanelRightClose: icon(), PanelRightOpen: icon(), Sparkles: icon() };
});
vi.mock("./api", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  useFigmaCall: () => vi.fn(async () => ({ nodes: {} })),
}));
vi.mock("./use-figma-file", () => ({
  figmaKeys: { all: () => ["figma"] },
  invalidateFigmaFile: vi.fn(),
  useFigmaOutline: () => ({ data: outlineFixture, isPending: false, isError: false, error: null }),
  useFigmaEdits: () => editsState.current,
  useFigmaFrameStore: () => null,
  useFigmaWatch: vi.fn(),
}));
vi.mock("./canvas-view", () => ({
  CanvasView: (props: Record<string, unknown>) => {
    captured.canvas = props;
    return React.createElement("div", { "data-testid": "canvas-view" });
  },
  findNodeInStore: () => null,
}));
vi.mock("./edit-toolbar", () => ({
  EditToolbar: (props: Record<string, unknown>) => {
    captured.toolbar = props;
    return React.createElement("div", { "data-testid": "edit-toolbar" });
  },
}));
vi.mock("./inspect-panel", () => ({
  InspectPanel: (props: Record<string, unknown>) => {
    captured.inspect = props;
    return React.createElement("div", { "data-testid": "inspect-panel" });
  },
}));
vi.mock("./top-bar", () => ({ FigmaTopBar: () => null }));
vi.mock("./assistant-panel", () => ({ FigmaAssistantPanel: () => null }));
vi.mock("@/figma/comments/comments-panel", () => ({ CommentsPanel: () => null }));
vi.mock("@/figma/prototype/prototype-player", () => ({ PrototypePlayer: () => null }));
vi.mock("@/figma/versions/versions-panel", () => ({ VersionsPanel: () => null }));

import { FigmaFileScreen } from "./file-screen";

function renderScreen(overrides: { version?: string }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <FigmaFileScreen
        serverId="s1"
        fileKey="file"
        {...(overrides.version ? { version: overrides.version } : {})}
      />,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("FigmaFileScreen pending/version wiring", () => {
  let views: { unmount: () => void }[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    captured.toolbar = null;
    captured.inspect = null;
    captured.canvas = null;
    vi.stubGlobal("React", React);
    queueOverrides["1:1"] = { name: "Queued" };
    editsState.current = {
      linked: false,
      pendingCount: 1,
      overrides: queueOverrides,
      applyEdits: vi.fn(async () => undefined),
      applyPending: vi.fn(() => Promise.resolve()),
      discardPending: vi.fn(() => Promise.resolve()),
    };
  });

  afterEach(() => {
    for (const view of views) view.unmount();
    views = [];
  });

  function render(overrides: { version?: string }) {
    const view = renderScreen(overrides);
    views.push(view);
    return view;
  }

  it("hands the toolbar promise-returning pending callbacks, not voided calls", async () => {
    render({});
    const toolbar = captured.toolbar as Record<string, () => unknown>;
    const applied = toolbar.onApplyPending();
    expect(applied).toBeInstanceOf(Promise);
    await applied;
    expect(editsState.current.applyPending).toHaveBeenCalledTimes(1);
    const discarded = toolbar.onDiscardPending();
    expect(discarded).toBeInstanceOf(Promise);
    await discarded;
    expect(editsState.current.discardPending).toHaveBeenCalledTimes(1);
  });

  it("keeps the live view editable and previews the current queue on the canvas", () => {
    render({});
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(false);
    expect((captured.canvas as Record<string, unknown>).overrides).toBe(queueOverrides);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(false);
  });

  it("makes a historical version read-only and strips current pending overrides from it", () => {
    render({ version: "v3" });
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(true);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(true);
    const canvas = captured.canvas as Record<string, unknown>;
    expect(canvas.version).toBe("v3");
    expect(canvas.overrides).not.toBe(queueOverrides);
    expect(canvas.overrides).toEqual({});
  });
});
