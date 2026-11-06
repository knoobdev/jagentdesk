/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, captured, queueOverrides, editsState, features, hooks } = vi.hoisted(() => {
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
  const outline = {
    name: "Design file",
    pages: [{ id: "p1", name: "Page 1", frames: [], children: [] }],
  };
  const queue = { "1:1": { name: "Queued" } } as Record<string, unknown>;
  const edits = {
    current: {
      linked: false,
      pendingCount: 1,
      overrides: {} as Record<string, unknown>,
      applyEdits: vi.fn(async () => undefined),
      applyPending: vi.fn(() => Promise.resolve()),
      discardPending: vi.fn(() => Promise.resolve()),
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
    outlineFixture: outline,
    queueOverrides: queue,
    editsState: edits,
    // The daemon capabilities the gate reads (ADR-0039 / spec 32.5.1). Tests flip these; the
    // base `figma` gate must stay compatible with the pre-ADR behaviour.
    features: {
      current: { figma: true, figmaNodeDepth: true } as Record<string, boolean>,
    },
    // The inner screen's data path. The capability gate must keep ALL of these unmounted —
    // a new client never sends depth1 to an old host, and there is no full-Section fallback.
    hooks: {
      outline: vi.fn(() => ({ data: outline, isPending: false, isError: false, error: null })),
      edits: vi.fn(() => edits.current),
      frameStore: vi.fn(() => null),
      watch: vi.fn(),
    },
  };
});

// The pending queue RPC promises are the whole point of this wiring test: the callbacks the
// screen passes to the toolbar must be the live promises (the toolbar surfaces their
// rejections), not voided calls.
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
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string | null | undefined, feature: string) =>
    Boolean(features.current[feature]),
}));
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
  useFigmaOutline: hooks.outline,
  useFigmaEdits: hooks.edits,
  useFigmaFrameStore: hooks.frameStore,
  useFigmaWatch: hooks.watch,
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

let views: { unmount: () => void }[] = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  vi.stubGlobal("React", React);
  captured.toolbar = null;
  captured.inspect = null;
  captured.canvas = null;
  features.current = { figma: true, figmaNodeDepth: true };
  hooks.outline.mockClear();
  hooks.edits.mockClear();
  hooks.frameStore.mockClear();
  hooks.watch.mockClear();
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

function render(overrides: { version?: string } = {}) {
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
  views.push({
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  });
  return container;
}

describe("FigmaFileScreen pending/version wiring", () => {
  it("hands the toolbar promise-returning pending callbacks, not voided calls", async () => {
    render();
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
    render();
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
    // A historical snapshot never watches the live file.
    expect(hooks.watch).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });
});

describe("FigmaFileScreen capability gate (ADR-0039)", () => {
  it("gates the viewer once on figmaNodeDepth: update-host view, no new data path mounted", () => {
    features.current.figmaNodeDepth = false;
    const container = render();
    expect(container.querySelector('[data-testid="figma-update-host"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain(
      "This host predates Section outlines — update the app running the daemon to open Figma files.",
    );
    // No fallback to the full Section: the inner screen (and every hook it holds) never mounts,
    // so this client never sends depth1 to a host that would silently strip the option.
    expect(hooks.outline).not.toHaveBeenCalled();
    expect(hooks.edits).not.toHaveBeenCalled();
    expect(hooks.frameStore).not.toHaveBeenCalled();
    expect(hooks.watch).not.toHaveBeenCalled();
    expect(captured.canvas).toBeNull();
    expect(captured.toolbar).toBeNull();
    expect(captured.inspect).toBeNull();
  });

  it("keeps the base figma gate first and unchanged for hosts that do not speak Figma at all", () => {
    features.current = { figma: false, figmaNodeDepth: false };
    const container = render();
    expect(container.textContent ?? "").toContain(
      "This host does not speak Figma yet — update the app running the daemon.",
    );
    // The depth view is only for hosts that speak Figma but predate the Section contract.
    expect(container.querySelector('[data-testid="figma-update-host"]')).toBeNull();
    expect(hooks.outline).not.toHaveBeenCalled();
    expect(captured.canvas).toBeNull();
  });

  it("mounts the full inner screen when both capabilities are present", () => {
    const container = render();
    expect(container.querySelector('[data-testid="figma-update-host"]')).toBeNull();
    expect(container.querySelector('[data-testid="figma-host-unsupported"]')).toBeNull();
    expect(captured.canvas).not.toBeNull();
    expect(captured.toolbar).not.toBeNull();
    expect(captured.inspect).not.toBeNull();
    expect(hooks.outline).toHaveBeenCalled();
    expect(hooks.watch).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
  });
});
