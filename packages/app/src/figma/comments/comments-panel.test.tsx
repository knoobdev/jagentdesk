/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, commentsState, remoteApi } = vi.hoisted(() => ({
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
      statusDanger: "#b91c1c",
      statusSuccess: "#15803d",
    },
  },
  // The comments query is faked here (transport-only): the daemon's real REST RPCs are exercised
  // by W3/backend tests, not by this panel suite.
  commentsState: {
    data: undefined as unknown[] | undefined,
    error: null as unknown,
    isPending: false,
  },
  remoteApi: {
    call: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
    refetch: vi.fn(),
    invalidate: vi.fn(),
    confirm: vi.fn(async (_input: unknown): Promise<boolean> => true),
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
vi.mock("@/data/query", () => ({
  useFetchQuery: () => ({
    data: commentsState.data,
    error: commentsState.error,
    isPending: commentsState.isPending,
    refetch: remoteApi.refetch,
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: remoteApi.invalidate }),
}));
vi.mock("@/figma/prototype/figma-api", () => ({
  callFigma: remoteApi.call,
  errorMessage: (error: unknown) => String(error),
  figmaKeys: {
    comments: (serverId: string, fileKey: string, version: string | null) => [
      "comments",
      serverId,
      fileKey,
      version,
    ],
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    testID,
    disabled,
    onPress,
  }: {
    children?: React.ReactNode;
    testID?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, disabled, onClick: onPress },
      children,
    ),
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
vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: (input: unknown) => remoteApi.confirm(input),
}));

import { CommentRow, CommentsPanel } from "./comments-panel";
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

// ── packet C1: mutation reliability, delete confirmation, refresh, filters ──────────────────

interface PanelFile {
  serverId: string;
  fileKey: string;
  version?: string;
}

function panelProps(overrides: Partial<PanelFile>, selectionNodeId: string | null) {
  return {
    file: { serverId: "s1", fileKey: "f1", ...overrides } as PanelFile,
    selection: { pageId: "p1", nodeId: selectionNodeId },
  };
}

const focusHandler = () => undefined;

function renderPanel(overrides: Partial<PanelFile> = {}, selectionNodeId: string | null = "1:2") {
  const props = panelProps(overrides, selectionNodeId);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const mounted = createRoot(container);
  const view = {
    container,
    root: mounted,
    text: () => container.textContent ?? "",
    byTestId: (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`),
    allByTestId: (id: string) => [
      ...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
    ],
    press: (id: string) => {
      const target = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      act(() => {
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      return target;
    },
    pressTwiceSameLoop: (id: string) => {
      const target = container.querySelector<HTMLElement>(
        `[data-testid="${id}"]`,
      ) as HTMLButtonElement | null;
      act(() => {
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    type: (id: string, value: string) => {
      const input = container.querySelector<HTMLElement>(`[data-testid="${id}"]`) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (!input) throw new Error(`no input for ${id}`);
      const proto =
        input instanceof HTMLTextAreaElement
          ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
          : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      act(() => {
        proto?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      return input;
    },
    inputValue: (id: string) =>
      (container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null)?.value ?? "",
    rerender: (nextFile: Partial<PanelFile> = {}) => {
      const next = panelProps({ ...overrides, ...nextFile }, selectionNodeId);
      act(() => {
        mounted.render(<CommentsPanel {...next} onFocusNode={focusHandler} />);
      });
    },
    unmount: () => {
      act(() => {
        mounted.unmount();
      });
      container.remove();
    },
  };
  act(() => {
    mounted.render(<CommentsPanel {...props} onFocusNode={focusHandler} />);
  });
  return view;
}

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CommentsPanel mutation reliability", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    commentsState.data = [];
    commentsState.error = null;
    commentsState.isPending = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    remoteApi.invalidate.mockReset();
    remoteApi.confirm.mockReset();
    remoteApi.confirm.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the list from the faked query data", () => {
    commentsState.data = [comment("r1", { message: "visible thread" })];
    const view = renderPanel();
    expect(view.text()).toContain("visible thread");
    view.unmount();
  });

  it("shows nothing-filtered copy when filters hide every thread", () => {
    commentsState.data = [comment("r1", { message: "resolved", resolvedAt_ms: 5 })];
    const view = renderPanel();
    expect(view.text()).toContain("No threads match the current filters.");
    view.unmount();
  });

  it("keeps the draft when the post RPC fails and clears it only on success", async () => {
    remoteApi.call.mockRejectedValueOnce(new Error("boom"));
    const view = renderPanel();
    view.type("figma-comment-input", "hello world");
    view.press("figma-comment-post");
    await act(async () => {
      await Promise.resolve();
    });
    // Failure at the action: message visible, draft preserved, no unhandled rejection.
    expect(view.byTestId("figma-comment-post-failure")?.textContent).toContain("boom");
    expect(view.inputValue("figma-comment-input")).toBe("hello world");
    // Retry re-attempts the same captured request and succeeds.
    const view2 = view;
    view2.press("figma-comment-post-failure-retry");
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.call).toHaveBeenCalledWith(
      null,
      "figma.file.comments.post.request",
      expect.objectContaining({ message: "hello world", nodeId: "1:2" }),
    );
    expect(view.inputValue("figma-comment-input")).toBe("");
    expect(view.byTestId("figma-comment-post-failure")).toBeNull();
    view.unmount();
  });

  it("dismiss hides the failure without another RPC", async () => {
    remoteApi.call.mockRejectedValueOnce(new Error("boom"));
    const view = renderPanel();
    view.type("figma-comment-input", "keep me");
    view.press("figma-comment-post");
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.byTestId("figma-comment-post-failure")).not.toBeNull();
    view.press("figma-comment-post-failure-dismiss");
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.byTestId("figma-comment-post-failure")).toBeNull();
    expect(remoteApi.call).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("does not wipe a draft the user re-typed while the post was in flight", async () => {
    const write = deferred();
    remoteApi.call.mockReturnValue(write.promise);
    const view = renderPanel();
    view.type("figma-comment-input", "sent text");
    view.press("figma-comment-post");
    view.type("figma-comment-input", "edited while pending");
    await act(async () => {
      write.resolve({});
    });
    // Success cleared only the untouched draft; the new typing survives.
    expect(view.inputValue("figma-comment-input")).toBe("edited while pending");
    expect(remoteApi.call).toHaveBeenCalledWith(
      null,
      "figma.file.comments.post.request",
      expect.objectContaining({ message: "sent text" }),
    );
    view.unmount();
  });

  it("collapses a same-event-loop double post press into exactly one RPC", async () => {
    const write = deferred();
    remoteApi.call.mockReturnValue(write.promise);
    const view = renderPanel();
    view.type("figma-comment-input", "double");
    view.pressTwiceSameLoop("figma-comment-post");
    expect(remoteApi.call).toHaveBeenCalledTimes(1);
    await act(async () => {
      write.resolve({});
    });
    view.unmount();
  });

  it("collapses a same-event-loop double reply press into one RPC and keeps the reply on failure", async () => {
    commentsState.data = [comment("r1", { message: "root" })];
    const write = deferred();
    remoteApi.call.mockReturnValue(write.promise);
    const view = renderPanel();
    view.press(`figma-comment-reply-open-r1`);
    view.type("figma-comment-reply-r1", "my reply");
    view.pressTwiceSameLoop("figma-comment-reply-send-r1");
    expect(remoteApi.call).toHaveBeenCalledTimes(1);
    await act(async () => {
      write.reject(new Error("reply boom"));
    });
    // The reply text and composer survive the failure; the error renders at the composer.
    expect(view.inputValue("figma-comment-reply-r1")).toBe("my reply");
    expect(view.byTestId("figma-comment-reply-failure-r1")?.textContent).toContain("reply boom");
    view.unmount();
  });

  it("shows reaction failures at the comment row with Retry that re-sends the same RPC", async () => {
    commentsState.data = [
      comment("r1", {
        message: "react to me",
        reactions: [{ emoji: ":+1:", count: 1, mine: false }],
      }),
    ];
    remoteApi.call.mockRejectedValueOnce(new Error("react boom"));
    const view = renderPanel();
    view.press("figma-reaction-:+1:");
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.byTestId("figma-comment-reaction-failure-r1")?.textContent).toContain("react boom");
    view.press("figma-comment-reaction-failure-r1-retry");
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.call).toHaveBeenCalledTimes(2);
    expect(remoteApi.call).toHaveBeenCalledWith(
      null,
      "figma.file.comments.react.request",
      expect.objectContaining({ commentId: "r1", emoji: ":+1:", remove: false }),
    );
    view.unmount();
  });

  it("invalidates the captured file key even when the write settles after unmount", async () => {
    const write = deferred();
    remoteApi.call.mockReturnValue(write.promise);
    const view = renderPanel();
    view.type("figma-comment-input", "posted after close");
    view.press("figma-comment-post");
    view.unmount();
    await act(async () => {
      write.resolve({});
      await Promise.resolve();
    });
    // Refresh went to the old file's key, and no crash from the dead instance.
    expect(remoteApi.invalidate).toHaveBeenCalledWith({
      queryKey: ["comments", "s1", "f1", null],
    });
  });

  it("a file switch remounts the panel: the new draft is untouched by the old post's result", async () => {
    const write = deferred();
    remoteApi.call.mockReturnValueOnce(write.promise);
    const view = renderPanel();
    view.type("figma-comment-input", "old file draft");
    view.press("figma-comment-post");
    view.rerender({ fileKey: "f2" }); // keyed identity change → fresh inner panel
    view.type("figma-comment-input", "new draft");
    await act(async () => {
      write.reject(new Error("old file boom"));
      await Promise.resolve();
    });
    // The old instance's failure never stamped the new instance: no banner, draft intact.
    expect(view.byTestId("figma-comment-post-failure")).toBeNull();
    expect(view.inputValue("figma-comment-input")).toBe("new draft");
    // And the old write invalidated the OLD file's key.
    expect(remoteApi.invalidate).toHaveBeenCalledWith({
      queryKey: ["comments", "s1", "f1", null],
    });
    view.unmount();
  });

  it("a host switch drops the previous server's results the same way", async () => {
    const write = deferred();
    remoteApi.call.mockReturnValueOnce(write.promise);
    const view = renderPanel();
    view.type("figma-comment-input", "draft for s1");
    view.press("figma-comment-post");
    view.rerender({ serverId: "s2" });
    await act(async () => {
      write.resolve({});
      await Promise.resolve();
    });
    expect(remoteApi.invalidate).toHaveBeenCalledWith({
      queryKey: ["comments", "s1", "f1", null],
    });
    expect(view.inputValue("figma-comment-input")).toBe("");
    view.unmount();
  });
});

describe("CommentsPanel delete confirmation", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    commentsState.data = [];
    commentsState.error = null;
    commentsState.isPending = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    remoteApi.invalidate.mockReset();
    remoteApi.confirm.mockReset();
    remoteApi.confirm.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancel on the confirm sends zero RPC", async () => {
    commentsState.data = [comment("r1", { message: "mine", mine: true })];
    remoteApi.confirm.mockResolvedValueOnce(false);
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.confirm).toHaveBeenCalledTimes(1);
    expect(remoteApi.call).not.toHaveBeenCalled();
    view.unmount();
  });

  it("confirm sends the delete RPC exactly once", async () => {
    commentsState.data = [comment("r1", { message: "mine", mine: true })];
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.confirm).toHaveBeenCalledTimes(2);
    expect(remoteApi.call).toHaveBeenCalledTimes(2);
    expect(remoteApi.call).toHaveBeenCalledWith(
      null,
      "figma.file.comments.delete.request",
      expect.objectContaining({ fileKey: "f1", commentId: "r1" }),
    );
    view.unmount();
  });

  it("the thread confirm spells out the reply loss", async () => {
    commentsState.data = [
      comment("r1", { message: "root", mine: true }),
      comment("a", { parentId: "r1", message: "first reply" }),
      comment("b", { parentId: "r1", message: "second reply" }),
    ];
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    const input = remoteApi.confirm.mock.calls[0][0] as { title: string; message: string };
    expect(input.title).toBe("Delete thread?");
    expect(input.message).toContain("2 replies");
    expect(input.message).toContain("Figma can't undo this.");
    view.unmount();
  });

  it("a single reply reads as one reply, and a reply delete is not a thread", async () => {
    commentsState.data = [
      comment("r1", { message: "root" }),
      comment("a", { parentId: "r1", message: "mine reply", mine: true }),
    ];
    const view = renderPanel();
    view.press("figma-comment-delete-a");
    await act(async () => {
      await Promise.resolve();
    });
    const input = remoteApi.confirm.mock.calls[0][0] as { title: string };
    expect(input.title).toBe("Delete comment?");
    expect(input.title).not.toBe("Delete thread?");
    view.unmount();
  });

  it("delete failures render at the row with Retry and Dismiss", async () => {
    commentsState.data = [comment("r1", { message: "mine", mine: true })];
    remoteApi.call.mockRejectedValueOnce(new Error("delete boom"));
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.byTestId("figma-comment-delete-failure-r1")?.textContent).toContain("delete boom");
    view.press("figma-comment-delete-failure-r1-dismiss");
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.byTestId("figma-comment-delete-failure-r1")).toBeNull();
    view.unmount();
  });

  it("only own comments carry the delete affordance", () => {
    commentsState.data = [
      comment("r1", { message: "root", mine: true }),
      comment("a", { parentId: "r1", message: "theirs" }),
    ];
    const view = renderPanel();
    expect(view.byTestId("figma-comment-delete-r1")).not.toBeNull();
    expect(view.byTestId("figma-comment-delete-a")).toBeNull();
    view.unmount();
  });
});

describe("CommentsPanel refresh and read errors", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    commentsState.data = [];
    commentsState.error = null;
    commentsState.isPending = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    remoteApi.invalidate.mockReset();
    remoteApi.confirm.mockReset();
    remoteApi.confirm.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Refresh re-reads the actual comments query", () => {
    commentsState.data = [comment("r1", { message: "keep visible" })];
    const view = renderPanel();
    view.press("figma-comment-refresh");
    expect(remoteApi.refetch).toHaveBeenCalled();
    expect(view.text()).toContain("keep visible");
    view.unmount();
  });

  it("a background read error keeps the displayed list and offers banner Retry", () => {
    commentsState.data = [comment("r1", { message: "still here" })];
    commentsState.error = new Error("refresh failed");
    const view = renderPanel();
    expect(view.text()).toContain("still here");
    expect(view.byTestId("figma-comment-refresh-error")?.textContent).toContain("refresh failed");
    view.press("figma-comment-refresh-retry");
    expect(remoteApi.refetch).toHaveBeenCalled();
    view.unmount();
  });

  it("a read error with no data at all is the full-screen Retry state", () => {
    commentsState.data = undefined;
    commentsState.error = new Error("down");
    const view = renderPanel();
    expect(view.byTestId("figma-comment-refresh-error")).toBeNull();
    view.press("figma-comment-retry");
    expect(remoteApi.refetch).toHaveBeenCalled();
    view.unmount();
  });

  it("never claims a live push in copy", () => {
    const view = renderPanel();
    expect(view.text()).not.toMatch(/live|push/i);
    view.unmount();
  });
});

describe("CommentsPanel list controls", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    commentsState.data = [];
    commentsState.error = null;
    commentsState.isPending = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    remoteApi.invalidate.mockReset();
    remoteApi.confirm.mockReset();
    remoteApi.confirm.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides resolved threads by default and shows them on toggle", () => {
    commentsState.data = [
      comment("open", { message: "open thread" }),
      comment("done", { message: "resolved thread", resolvedAt_ms: 9 }),
    ];
    const view = renderPanel();
    expect(view.text()).toContain("open thread");
    expect(view.text()).not.toContain("resolved thread");
    view.press("figma-comment-filter-resolved");
    expect(view.text()).toContain("resolved thread");
    view.unmount();
  });

  it("My threads filters on the real mine flags only", () => {
    commentsState.data = [
      comment("mine-root", { message: "i wrote this", mine: true }),
      comment("other", {
        message: "@someone mentioned",
        user: { handle: "alice", figmaUserId: "u2" },
      }),
      comment("mine-reply-root", { message: "root by other" }),
      comment("r1", { parentId: "mine-reply-root", message: "my reply", mine: true }),
    ];
    const view = renderPanel();
    view.press("figma-comment-filter-mine");
    expect(view.text()).toContain("i wrote this");
    expect(view.text()).toContain("root by other"); // kept: my real reply is in it
    expect(view.text()).not.toContain("@someone mentioned");
    view.unmount();
  });

  it("search matches message text and real author handles", () => {
    commentsState.data = [
      comment("r1", {
        message: "tighten the radius",
        user: { handle: "alice", figmaUserId: "u2" },
      }),
      comment("r2", { message: "different words", user: { handle: "someone", figmaUserId: "u1" } }),
    ];
    const view = renderPanel();
    view.type("figma-comment-search", "ALICE");
    expect(view.text()).toContain("tighten the radius");
    expect(view.text()).not.toContain("different words");
    view.type("figma-comment-search", "different");
    expect(view.text()).toContain("different words");
    expect(view.text()).not.toContain("tighten the radius");
    view.unmount();
  });

  it("sort flips between latest and oldest activity", () => {
    commentsState.data = [
      comment("old", { message: "older thread", createdAt_ms: 100 }),
      comment("new", { message: "newer thread", createdAt_ms: 300 }),
    ];
    const view = renderPanel();
    // Latest by default: newer thread first.
    expect(view.text().indexOf("newer thread")).toBeLessThan(view.text().indexOf("older thread"));
    view.press("figma-comment-sort-oldest");
    expect(view.text().indexOf("older thread")).toBeLessThan(view.text().indexOf("newer thread"));
    view.press("figma-comment-sort-latest");
    expect(view.text().indexOf("newer thread")).toBeLessThan(view.text().indexOf("older thread"));
    view.unmount();
  });

  it("All / On this node scopes by the root's anchor", () => {
    commentsState.data = [
      comment("on", { message: "anchored here", nodeId: "1:2" }),
      comment("off", { message: "anchored elsewhere", nodeId: "9:9" }),
    ];
    const view = renderPanel();
    expect(view.text()).toContain("anchored elsewhere");
    view.press("figma-comment-filter-node");
    expect(view.text()).toContain("anchored here");
    expect(view.text()).not.toContain("anchored elsewhere");
    view.press("figma-comment-filter-all");
    expect(view.text()).toContain("anchored elsewhere");
    view.unmount();
  });

  it("no fake product buttons appear (resolve/edit/mention are 32.12 scope)", () => {
    commentsState.data = [
      comment("r1", { message: "plain", reactions: [{ emoji: ":+1:", count: 2, mine: false }] }),
    ];
    const view = renderPanel();
    expect(view.text()).not.toContain("Reopen");
    expect(view.text()).not.toContain("Edit");
    expect(view.text()).not.toContain("Mention");
    view.unmount();
  });
});

// ── root review C1: confirm lifecycle, retry locality ───────────────────────────────────────

describe("CommentsPanel confirm lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    commentsState.data = [];
    commentsState.error = null;
    commentsState.isPending = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    remoteApi.invalidate.mockReset();
    remoteApi.confirm.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seededOwnComment() {
    commentsState.data = [comment("r1", { message: "mine", mine: true })];
  }

  it("a confirm that settles after a file switch sends zero old delete RPC", async () => {
    seededOwnComment();
    const dialog = deferred<boolean>();
    remoteApi.confirm.mockReturnValueOnce(dialog.promise);
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender({ fileKey: "f2" }); // host file identity changes while the dialog is up
    await act(async () => {
      dialog.resolve(true); // user finally presses Delete on the stale dialog
      await Promise.resolve();
    });
    expect(remoteApi.call).not.toHaveBeenCalled();
    view.unmount();
  });

  it("a confirm that settles after unmount sends zero old delete RPC", async () => {
    seededOwnComment();
    const dialog = deferred<boolean>();
    remoteApi.confirm.mockReturnValueOnce(dialog.promise);
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount(); // panel closed while the dialog is up
    await act(async () => {
      dialog.resolve(true);
      await Promise.resolve();
    });
    expect(remoteApi.call).not.toHaveBeenCalled();
  });

  it("a rejected confirm from a previous file stamps no stale failure on the new one", async () => {
    seededOwnComment();
    const dialog = deferred<boolean>();
    remoteApi.confirm.mockReturnValueOnce(dialog.promise);
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender({ fileKey: "f2" });
    await act(async () => {
      dialog.reject(new Error("dialog died"));
      await Promise.resolve();
    });
    expect(view.byTestId("figma-comment-delete-failure-r1")).toBeNull();
    expect(view.text()).not.toContain("dialog died");
    expect(remoteApi.call).not.toHaveBeenCalled();
    view.unmount();
  });

  it("an unmounted owner cannot dispatch a retry RPC", async () => {
    seededOwnComment();
    const write = deferred();
    remoteApi.call.mockReturnValueOnce(write.promise);
    const view = renderPanel();
    view.press("figma-comment-delete-r1");
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount(); // closed with the delete in flight
    await act(async () => {
      write.reject(new Error("late"));
      await Promise.resolve();
    });
    // The dead instance settles; re-dispatch through its stored retry closure finds it gone.
    remoteApi.call.mockResolvedValueOnce({});
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.invalidate).toHaveBeenCalledWith({
      queryKey: ["comments", "s1", "f1", null],
    });
  });
});

describe("CommentsPanel retry locality", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    commentsState.data = [];
    commentsState.error = null;
    commentsState.isPending = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    remoteApi.invalidate.mockReset();
    remoteApi.confirm.mockReset();
    remoteApi.confirm.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a reaction retry after filter changes re-sends the SAME captured request, old file only", async () => {
    commentsState.data = [
      comment("r1", {
        message: "react here",
        reactions: [{ emoji: ":+1:", count: 1, mine: false }],
      }),
    ];
    remoteApi.call.mockRejectedValueOnce(new Error("react boom"));
    const view = renderPanel();
    view.press("figma-reaction-:+1:");
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.byTestId("figma-comment-reaction-failure-r1")).not.toBeNull();
    // Change local filter state underneath the pending failure — retry must still act on this
    // file's r1 with the original parameters, not whatever the filters show now.
    view.type("figma-comment-search", "react here");
    view.press("figma-comment-reaction-failure-r1-retry");
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.call).toHaveBeenCalledTimes(2);
    expect(remoteApi.call).toHaveBeenLastCalledWith(
      null,
      "figma.file.comments.react.request",
      expect.objectContaining({ fileKey: "f1", commentId: "r1", emoji: ":+1:", remove: false }),
    );
    expect(remoteApi.invalidate).toHaveBeenCalledWith({
      queryKey: ["comments", "s1", "f1", null],
    });
    view.unmount();
  });

  it("a reaction settling after a file switch invalidates the OLD file's key only", async () => {
    commentsState.data = [
      comment("r1", {
        message: "react now",
        reactions: [{ emoji: ":+1:", count: 1, mine: false }],
      }),
    ];
    const write = deferred();
    remoteApi.call.mockReturnValue(write.promise);
    const view = renderPanel();
    view.press("figma-reaction-:+1:");
    view.rerender({ fileKey: "f2" }); // switch files with the write still in flight
    await act(async () => {
      write.resolve({});
      await Promise.resolve();
    });
    // The captured-key refresh went to the old file; the new instance is not disturbed by it.
    expect(remoteApi.invalidate).toHaveBeenCalledWith({
      queryKey: ["comments", "s1", "f1", null],
    });
    expect(view.byTestId("figma-comment-reaction-failure-r1")).toBeNull();
    expect(view.byTestId("figma-comment-post-failure")).toBeNull();
    view.unmount();
  });
});

describe("CommentsPanel historical versions are read-only", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    commentsState.data = [];
    commentsState.error = null;
    commentsState.isPending = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    remoteApi.invalidate.mockReset();
    remoteApi.confirm.mockReset();
    remoteApi.confirm.mockResolvedValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables writes but keeps reads, filters and refresh working", async () => {
    commentsState.data = [
      comment("r1", {
        message: "historic",
        mine: true,
        reactions: [{ emoji: ":+1:", count: 1, mine: false }],
      }),
    ];
    const view = renderPanel({ version: "123" });
    // Reads work: the list renders and Refresh still re-reads.
    expect(view.text()).toContain("historic");
    view.press("figma-comment-refresh");
    expect(remoteApi.refetch).toHaveBeenCalled();
    // Writes are disabled: pressing them sends no RPC.
    expect((view.byTestId("figma-comment-post") as HTMLButtonElement).disabled).toBe(true);
    expect(view.byTestId("figma-comment-delete-r1")).toBeNull();
    view.press("figma-comment-post");
    view.press("figma-reaction-:+1:");
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.call).not.toHaveBeenCalled();
    const input = view.byTestId("figma-comment-input") as HTMLInputElement | null;
    expect(input?.readOnly).toBe(true);
    view.unmount();
  });

  it("typing into a read-only composer sends no post RPC", async () => {
    const view = renderPanel({ version: "123" });
    view.type("figma-comment-input", "typed but blocked");
    view.press("figma-comment-post");
    await act(async () => {
      await Promise.resolve();
    });
    expect(remoteApi.call).not.toHaveBeenCalled();
    view.unmount();
  });
});
