/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    fontFamily: { mono: "monospace" },
    colors: {
      surface0: "#111",
      surface1: "#161616",
      surface3: "#222",
      surfaceWorkspace: "#0a0a0a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#333",
      accent: "#2563eb",
      palette: { red: "#ef4444" },
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
vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("expo-linking", () => ({
  canOpenURL: async () => false,
  openURL: async () => undefined,
}));
vi.mock("lucide-react-native", () => {
  const icon = () => React.createElement("i");
  return { ChevronDown: icon, MoreHorizontal: icon, ZoomIn: icon, ZoomOut: icon };
});
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": String(testID ?? "") },
      children,
    ),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children, testID }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { "data-testid": String(testID ?? "") },
      children as React.ReactNode,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", { "data-testid": "figma-source-badge" }, label),
}));

import { FigmaTopBar } from "./top-bar";
import { outline, page } from "@/figma/prototype/test-support/frames";

// G5 bug 3: on a phone (<600px) the "•••" overflow wrapped to its own row UNDER the zoom
// controls. The bar must keep zoom + "•••" in one fixed cluster on the single top row (the
// title shrinks first), and only the data-source badge may drop to a second line. The F3 bar
// rule — every control on one row — must hold for the desktop bar too.

const fileOutline = outline([page({ id: "p1", name: "Page 1" })]);
const noop = (): void => {};

function renderBar(overrides: { compact: boolean }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  const actRender = (fn: () => void) => {
    const reactAct = (React as { act?: (fn: () => void) => void }).act;
    if (reactAct) reactAct(fn);
    else fn();
  };
  actRender(() => {
    root = createRoot(container);
    const barProps = {
      fileKey: "file-1",
      outline: fileOutline,
      version: null,
      page: fileOutline.pages[0],
      selectedNodeId: null,
      camera: { zoom: 1, offsetX: 0, offsetY: 0 },
      size: { width: overrides.compact ? 375 : 1280, height: 600 },
      compact: overrides.compact,
      onCamera: noop,
      onSelectPage: noop,
      onOpenPrototype: noop,
      onAskAi: noop,
    };
    root.render(<FigmaTopBar {...barProps} />);
  });
  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  return {
    container,
    byTestId,
    unmount: () => {
      actRender(() => {
        root!.unmount();
      });
      container.remove();
    },
  };
}

describe("FigmaTopBar compact overflow button (G5 bug 3)", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
  });

  it("keeps the zoom controls and the ••• overflow in one non-wrapping cluster on a phone", () => {
    const bar = renderBar({ compact: true });
    const cluster = bar.byTestId("figma-top-bar-controls");
    expect(cluster).not.toBeNull();
    const zoom = bar.byTestId("figma-zoom-reset");
    const more = bar.byTestId("figma-top-bar-more");
    expect(zoom).not.toBeNull();
    expect(more).not.toBeNull();
    // Same row = one shared cluster that is not the wrapping bar itself. Before the fix "•••"
    // was a loose bar child and flex-wrap dropped it to its own row under the zoom controls.
    expect(cluster!.contains(zoom)).toBe(true);
    expect(cluster!.contains(more)).toBe(true);
    expect(cluster).not.toBe(bar.byTestId("figma-top-bar"));
    bar.unmount();
  });

  it("moves only the data-source badge to the second phone line", () => {
    const bar = renderBar({ compact: true });
    const cluster = bar.byTestId("figma-top-bar-controls") as HTMLElement;
    const badge = bar.byTestId("figma-source-badge");
    expect(badge).not.toBeNull();
    expect(cluster.contains(badge)).toBe(false);
    // The badge renders inside the wrapping bar (its own full-width second line), not beside
    // the controls.
    const barEl = bar.byTestId("figma-top-bar");
    expect(barEl!.contains(badge)).toBe(true);
    bar.unmount();
  });

  it("keeps the desktop bar (>=600px) on one row with badge and overflow inline (F3)", () => {
    const bar = renderBar({ compact: false });
    const cluster = bar.byTestId("figma-top-bar-controls");
    expect(cluster).not.toBeNull();
    expect(cluster!.contains(bar.byTestId("figma-zoom-reset"))).toBe(true);
    expect(cluster!.contains(bar.byTestId("figma-top-bar-more"))).toBe(true);
    expect(cluster!.contains(bar.byTestId("figma-source-badge"))).toBe(true);
    // No second badge row outside the cluster on desktop.
    const badgeRows = [...bar.container.querySelectorAll('[data-testid="figma-source-badge"]')];
    expect(badgeRows).toHaveLength(1);
    bar.unmount();
  });
});
