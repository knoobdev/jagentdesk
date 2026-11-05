/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/figma/prototype/figma-api", () => ({
  callFigma: vi.fn(async () => ({ comments: [] })),
  errorMessage: (error: unknown) => String(error),
  figmaKeys: { comments: () => ["comments"] },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: Record<string, unknown>) =>
    React.createElement("button", { type: "button" }, children as React.ReactNode),
}));
vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("div", { "data-spinner": true }),
}));
vi.mock("@/components/ui/scroll-view", () => ({
  ScrollView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
vi.mock("@/figma/versions/versions-model", () => ({
  formatRelativeTime: () => "5m ago",
}));

import { CommentRow } from "./comments-panel";
import { comment } from "./test-support/comments";

function findElements(container: HTMLElement, text: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("*")].filter(
    (el) =>
      (el.textContent ?? "").trim() === text &&
      ![...el.children].some((child) => (child.textContent ?? "").trim() === text),
  );
}

function renderRow(
  c: ReturnType<typeof comment>,
  handlers: {
    onFocusNode?: (nodeId: string) => void;
    onFocusPoint?: (point: { x: number; y: number }) => void;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <CommentRow
        comment={c}
        now_ms={1_700_000_000_000}
        onFocusNode={handlers.onFocusNode ?? vi.fn()}
        onFocusPoint={handlers.onFocusPoint}
        onReact={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
  });
  return {
    container,
    text: () => container.textContent ?? "",
    clickMessage: () => {
      const pressables = [...container.querySelectorAll<HTMLElement>("[role='button']")].filter(
        (el) => (el.textContent ?? "").includes(c.message),
      );
      const target = pressables[pressables.length - 1];
      act(() => {
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("CommentRow layout", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the message on its own full-width line, not in the header row", () => {
    const view = renderRow(
      comment("c1", {
        message: "Please tighten the corner radius on the button here",
        nodeId: "1:2",
      }),
    );
    const names = findElements(view.container, "someone");
    console.log("NAMES>>>", names.map((e) => e.outerHTML.slice(0, 80)).join("\n"));
    const messages = findElements(
      view.container,
      "Please tighten the corner radius on the button here",
    );
    expect(names).toHaveLength(1);
    expect(messages).toHaveLength(1);
    // The old row put avatar, name and message in one flex line; the message must not share a
    // parent with the author name.
    expect(messages[0].parentElement).not.toBe(names[0].parentElement);
    const messageAncestor = messages[0].closest("[data-testid='figma-comment-message-c1']");
    expect(messageAncestor).not.toBeNull();
    expect(messageAncestor?.textContent).toContain(
      "Please tighten the corner radius on the button here",
    );
    expect(messageAncestor?.textContent).not.toContain("someone");
    view.unmount();
  });

  it("renders known reaction shortcodes as Unicode", () => {
    const view = renderRow(
      comment("c1", {
        message: "ship it",
        reactions: [{ emoji: ":+1:", count: 3, mine: false }],
      }),
    );
    expect(view.text()).toContain("👍");
    expect(view.text()).not.toContain(":+1:");
    view.unmount();
  });

  it("shows the shortcode text for unknown emoji, not a blank chip", () => {
    const view = renderRow(
      comment("c1", {
        message: "ship it",
        reactions: [{ emoji: ":pickle:", count: 1, mine: false }],
      }),
    );
    expect(view.text()).toContain(":pickle:");
    view.unmount();
  });

  it("hides zero-count chips and never renders the placeholder chip row", () => {
    const view = renderRow(
      comment("c1", {
        message: "ship it",
        reactions: [{ emoji: ":tada:", count: 0, mine: false }],
      }),
    );
    expect(view.text()).not.toContain("🎉");
    expect(view.text()).not.toContain(":tada:");
    // No always-on add-a-reaction chips (:+1:, :fire:, :eyes:) either.
    expect(view.text()).not.toContain(":+1:");
    expect(view.text()).not.toContain("👍");
    view.unmount();
  });

  it("clicking a node-pinned comment hands the node id to the canvas", () => {
    const onFocusNode = vi.fn();
    const view = renderRow(comment("c1", { message: "look here", nodeId: "1:2" }), {
      onFocusNode,
    });
    view.clickMessage();
    expect(onFocusNode).toHaveBeenCalledWith("1:2");
    view.unmount();
  });

  it("clicking an offset-only comment pans to the point via the focus hook", () => {
    const onFocusNode = vi.fn();
    const onFocusPoint = vi.fn();
    const view = renderRow(
      comment("c1", { message: "off to the side", nodeId: null, offset: { x: 5, y: 7 } }),
      { onFocusNode, onFocusPoint },
    );
    view.clickMessage();
    expect(onFocusNode).not.toHaveBeenCalled();
    expect(onFocusPoint).toHaveBeenCalledWith({ x: 5, y: 7 });
    view.unmount();
  });
});
