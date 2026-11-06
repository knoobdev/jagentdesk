/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaNode, FigmaPage } from "@jagentdesk/protocol/figma/rpc-schemas";
import { makeNode } from "./__fixtures__/figma";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 17 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    fontFamily: { mono: "monospace" },
    colors: {
      surface0: "#0a0a0a",
      surface1: "#111",
      surface3: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      border: "#555",
      accent: "#0a84ff",
      statusSuccess: "#00ff00",
      statusWarning: "#ff9500",
      statusDanger: "#ff0000",
      palette: { red: { 300: "#ff6b6b" }, green: { 400: "#4ade80" }, white: "#fff" },
    },
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  TextInput: () => React.createElement("input", { readOnly: true }),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { role: "button", "data-testid": testID, onClick: onPress },
      children,
    ),
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

vi.mock("@/jira/ui/styles", () => {
  const style = new Proxy({}, { get: () => ({}) });
  return { jiraStyles: style };
});

vi.mock("@/jira/ui/primitives", () => ({
  ErrorBanner: ({ message, action }: { message: string; action?: React.ReactNode }) =>
    React.createElement("span", { "data-testid": "error-banner" }, message, action ?? null),
}));

// The real Button disables itself; the test asserts busy-time disabling, so the mock must
// honour the attribute (jsdom swallows clicks on disabled buttons).
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    React.createElement(
      "button",
      { type: "button", disabled: Boolean(disabled), onClick: onPress },
      children,
    ),
}));

vi.mock("lucide-react-native", () => {
  const icon = () => () => React.createElement("i");
  return {
    Check: icon(),
    ChevronDown: icon(),
    ChevronRight: icon(),
    CircleAlert: icon(),
    Component: icon(),
    Copy: icon(),
    Download: icon(),
    Eye: icon(),
    EyeOff: icon(),
    Frame: icon(),
    Layers: icon(),
    Loader2: icon(),
    Lock: icon(),
    PenTool: icon(),
    Shapes: icon(),
    Square: icon(),
    Trash2: icon(),
    Type: icon(),
    Unlock: icon(),
    Zap: icon(),
  };
});

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));

// Real errorMessage semantics keep the banner assertion honest: the toolbar must show what the
// daemon/host threw, so the test feeds a real Error through the real helper.
vi.mock("./api", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { EditToolbar, type EditToolbarProps } from "./edit-toolbar";

const PAGE: FigmaPage = {
  id: "p1",
  name: "Page 1",
  frames: [
    {
      id: "1:9",
      name: "Other frame",
      type: "FRAME",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    },
  ],
  children: [],
  flowStartingPoints: [],
} as unknown as FigmaPage;

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("EditToolbar honest status", () => {
  let roots: Root[] = [];
  let containers: HTMLDivElement[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    roots = [];
    containers = [];
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const container of containers) container.remove();
    roots = [];
    containers = [];
  });

  function render(overrides: Partial<EditToolbarProps> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    const node: FigmaNode = overrides.node === undefined ? makeNode({ id: "1:1" }) : overrides.node;
    const props: EditToolbarProps = {
      page: PAGE,
      selection: { pageId: "p1", nodeId: node.id },
      camera: { zoom: 1, offsetX: 0, offsetY: 0 },
      size: { width: 800, height: 600 },
      applyEdits: vi.fn(async () => undefined),
      linked: false,
      pendingCount: 0,
      onApplyPending: vi.fn(),
      onDiscardPending: vi.fn(),
      ...overrides,
      node,
    };
    act(() => root.render(<EditToolbar {...props} />));
    return {
      container,
      rerender: (next: Partial<EditToolbarProps>) => {
        const merged = { ...props, ...next };
        act(() => root.render(<EditToolbar {...merged} />));
      },
    };
  }

  const button = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label) as
      | HTMLButtonElement
      | undefined;

  it("shows the real message when an edit fails and clears it on dismiss", async () => {
    const applyEdits = vi.fn(async () => {
      throw new Error("Unsupported edit op: set_visible");
    });
    const { container } = render({ applyEdits });
    await act(async () => button(container, "Hide")?.click());
    expect(container.querySelector('[data-testid="figma-edit-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="error-banner"]')?.textContent ?? "").toContain(
      "Unsupported edit op: set_visible",
    );
    await act(async () => {
      (container.querySelector('[data-testid="figma-edit-error-dismiss"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="figma-edit-error"]')).toBeNull();
  });

  it("shows Submitting… and disables controls while a submission is in flight", async () => {
    const flight = deferred();
    const applyEdits = vi.fn(() => flight.promise);
    const { container } = render({ applyEdits });
    await act(async () => button(container, "Duplicate")?.click());
    expect(container.querySelector('[data-testid="figma-edit-busy"]')?.textContent).toContain(
      "Submitting…",
    );
    expect(button(container, "Frame")?.disabled).toBe(true);
    expect(button(container, "Duplicate")?.disabled).toBe(true);
    // A second click while busy must not queue a second submission.
    act(() => button(container, "Component")?.click());
    expect(applyEdits).toHaveBeenCalledTimes(1);
    await act(async () => {
      flight.resolve(undefined);
    });
    expect(container.querySelector('[data-testid="figma-edit-busy"]')).toBeNull();
    expect(button(container, "Frame")?.disabled).toBe(false);
  });

  it("a successful retry clears the previous failure", async () => {
    let reject = true;
    const applyEdits = vi.fn(async () => {
      if (reject) throw new Error("Figma Link disconnected");
    });
    const { container } = render({ applyEdits });
    await act(async () => button(container, "Duplicate")?.click());
    expect(container.querySelector('[data-testid="error-banner"]')?.textContent ?? "").toContain(
      "Figma Link disconnected",
    );
    reject = false;
    await act(async () => button(container, "Duplicate")?.click());
    expect(container.querySelector('[data-testid="error-banner"]')).toBeNull();
    expect(container.querySelector('[data-testid="figma-edit-busy"]')).toBeNull();
  });

  it("Apply and Discard run through the same guard and surface async failures", async () => {
    const onApplyPending = vi.fn(() => Promise.reject(new Error("Queue apply failed")));
    const { container } = render({ linked: true, pendingCount: 2, onApplyPending });
    expect(container.textContent ?? "").toContain("2 pending");
    await act(async () => button(container, "Apply")?.click());
    expect(onApplyPending).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="error-banner"]')?.textContent ?? "").toContain(
      "Queue apply failed",
    );
    await act(async () => {
      (container.querySelector('[data-testid="figma-edit-error-dismiss"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="error-banner"]')).toBeNull();

    const onDiscardPending = vi.fn(() => Promise.reject(new Error("Queue discard failed")));
    const { container: discardBox } = render({ pendingCount: 2, onDiscardPending });
    await act(async () => button(discardBox, "Discard")?.click());
    expect(onDiscardPending).toHaveBeenCalledTimes(1);
    expect(discardBox.querySelector('[data-testid="error-banner"]')?.textContent ?? "").toContain(
      "Queue discard failed",
    );
  });

  it("never blocks edits or the pending caption while the file is unlinked", async () => {
    const applyEdits = vi.fn(async () => undefined);
    const { container } = render({ linked: false, pendingCount: 1, applyEdits });
    // Missing Link must not gate creating content: the create buttons stay enabled.
    expect(button(container, "Frame")?.disabled).toBe(false);
    await act(async () => button(container, "Frame")?.click());
    expect(applyEdits).toHaveBeenCalledTimes(1);
    expect(applyEdits.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ op: "create_node" })]);
    // Apply needs the link; Discard (clearing the local queue) does not.
    expect(button(container, "Apply")).toBeUndefined();
    expect(button(container, "Discard")).toBeDefined();
    expect(container.textContent ?? "").toContain("1 pending");
  });

  it("retires a failure banner that belongs to a different layer", async () => {
    const applyEdits = vi.fn(async () => {
      throw new Error("Layer is locked");
    });
    const { container, rerender } = render({ applyEdits });
    await act(async () => button(container, "Duplicate")?.click());
    expect(container.querySelector('[data-testid="error-banner"]')).not.toBeNull();
    // Switching selection is a new inspect context; A's stale failure must not strand on B.
    rerender({ node: makeNode({ id: "2:2" }), selection: { pageId: "p1", nodeId: "2:2" } });
    expect(container.querySelector('[data-testid="error-banner"]')).toBeNull();
  });

  it("ignores a late completion after the component unmounted", async () => {
    const flight = deferred();
    const applyEdits = vi.fn(() => flight.promise);
    const { container } = render({ applyEdits });
    await act(async () => button(container, "Duplicate")?.click());
    expect(container.querySelector('[data-testid="figma-edit-busy"]')).not.toBeNull();
    for (const root of roots) act(() => root.unmount());
    roots = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      flight.resolve(undefined);
    });
    // The settle path must no-op after unmount — no state update, no warning.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
