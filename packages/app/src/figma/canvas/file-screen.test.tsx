/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, captured, queueOverrides, editsState, features, hooks, routeParams } = vi.hoisted(
  () => {
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
      // ADR-0039: even live asset paths must pin to the outline snapshot version.
      version: "snap-1",
      pages: [
        {
          id: "p1",
          name: "Page 1",
          frames: [
            {
              id: "1:1",
              name: "Screen",
              type: "FRAME",
              bounds: { x: 0, y: 0, width: 375, height: 812 },
            },
          ],
          children: [],
          flowStartingPoints: [{ nodeId: "9:9", name: "Onboarding", pageId: "p1" }],
        },
      ],
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
    // The lazy store as the screen sees it: a cached parent chain 1:5 → 1:4 → 1:1 lets the W6
    // handoff test assert the player gets the ROOT FRAME, not the selected text/button node.
    const parentLinks: Record<string, { id: string; name: string; type: string }> = {
      "1:5": { id: "1:4", name: "Group", type: "GROUP" },
      "1:4": { id: "1:1", name: "Screen", type: "FRAME" },
    };
    const store = {
      subscribe: vi.fn(() => vi.fn()),
      parentOf: vi.fn((id: string) => parentLinks[id] ?? null),
      componentMeta: vi.fn(() => undefined),
    };
    return {
      theme: uiTheme,
      // Props the screen hands the toolbar / inspect panel / canvas / player — the wiring.
      captured: {
        toolbar: null as Record<string, unknown> | null,
        inspect: null as Record<string, unknown> | null,
        canvas: null as Record<string, unknown> | null,
        player: null as Record<string, unknown> | null,
        topbar: null as Record<string, unknown> | null,
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
        frameStore: vi.fn(() => store),
        watch: vi.fn(),
      },
      // Route params feed the initial selection (decoded by ./node-url, the real pure module).
      routeParams: { current: {} as Record<string, string | string[]> },
      storeMock: store,
    };
  },
);

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
  useLocalSearchParams: () => routeParams.current,
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
vi.mock("./top-bar", () => ({
  FigmaTopBar: (props: Record<string, unknown>) => {
    captured.topbar = props;
    // Expose the prototype trigger so tests can open the player like a user would.
    return React.createElement("button", {
      type: "button",
      "data-testid": "open-prototype",
      onClick: () => (props.onOpenPrototype as () => void)(),
    });
  },
}));
vi.mock("./assistant-panel", () => ({ FigmaAssistantPanel: () => null }));
vi.mock("@/figma/comments/comments-panel", () => ({ CommentsPanel: () => null }));
vi.mock("@/figma/prototype/prototype-player", () => ({
  PrototypePlayer: (props: Record<string, unknown>) => {
    captured.player = props;
    return React.createElement("div", { "data-testid": "prototype-player" });
  },
}));
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
  captured.player = null;
  captured.topbar = null;
  routeParams.current = {};
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

describe("FigmaFileScreen snapshot pinning and W6 prototype handoff", () => {
  function openPrototype(container: HTMLElement) {
    const trigger = container.querySelector('[data-testid="open-prototype"]') as HTMLButtonElement;
    act(() => trigger.click());
  }

  it("pins live asset paths to the outline snapshot version while keeping the viewer editable", () => {
    render();
    // ADR-0039: depth1 metadata, full subtrees and rasters must all carry the SAME explicit
    // snapshot — the outline's version — even for the live view.
    expect(hooks.frameStore).toHaveBeenCalledWith("s1", "file", "snap-1", expect.anything());
    expect((captured.canvas as Record<string, unknown>).version).toBe("snap-1");
    // Read-only-ness stays keyed to the explicit historical prop, not the derived snapshot.
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(false);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(false);
  });

  it("the explicit historical version wins over the outline snapshot for store and canvas", () => {
    render({ version: "v3" });
    expect(hooks.frameStore).toHaveBeenCalledWith("s1", "file", "v3", expect.anything());
    expect((captured.canvas as Record<string, unknown>).version).toBe("v3");
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(true);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(true);
  });

  it("hands the player the cached root FRAME, not the selected descendant", () => {
    routeParams.current = { node: "1-5" }; // dash form; ./node-url decodes to "1:5"
    const container = render();
    openPrototype(container);
    expect((captured.player as Record<string, unknown>).startNodeId).toBe("1:1");
  });

  it("honors the current page's flow when nothing is selected", () => {
    const container = render();
    openPrototype(container);
    expect((captured.player as Record<string, unknown>).startNodeId).toBe("9:9");
  });

  it("keeps a selected root frame; an uncached layer falls back to the flow, never its subtree", () => {
    // The mid-test `captured.player = null` keeps narrowing the property to null (a re-render
    // reassigns it inside a helper, which TS's control flow can't see), so read it through a
    // function: the call site resets narrowing to the declared type and the cast stays honest.
    const playerSeen = () => captured.player as Record<string, unknown>;
    routeParams.current = { node: "1-1" };
    const first = render();
    openPrototype(first);
    expect(playerSeen().startNodeId).toBe("1:1");

    captured.player = null;
    routeParams.current = { node: "7-7" }; // outside the cached chain
    const second = render();
    openPrototype(second);
    expect(playerSeen().startNodeId).toBe("9:9");
  });
});
