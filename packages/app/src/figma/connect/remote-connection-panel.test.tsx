// @vitest-environment jsdom
/**
 * Remote MCP editing panel (ADR-0040 / spec 32.7+32.9).
 *
 * Renders the real panel against the real Figma UI kit with the daemon RPCs mocked, and pins
 * the contract the ADR calls out:
 *  - the panel gates ONCE on the `figmaRemoteWrites` host capability — an old host shows the
 *    update request and runs no data path at all;
 *  - sign-in begins ONLY on an explicit button press (never from mount/query) and the
 *    authorization URL is validated as an HTTPS Figma URL before any Open/Copy affordance;
 *  - status polls only while the connector is mid-transition (connecting / needs_auth);
 *  - `connected` shows the connector's `whoami` identity when it exists (never a placeholder)
 *    and never claims "Saved"; `unavailable`/`error` surface the daemon message with a Retry.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "@/utils/open-external-url";

vi.stubGlobal("React", React);

const { theme, flags, queryOptions, remoteState, remoteApi } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 },
    colors: {
      surface0: "#ffffff",
      surface1: "#f9f9f9",
      surface2: "#f0f0f0",
      foreground: "#0a0a0a",
      foregroundMuted: "#6b7280",
      foregroundExtraMuted: "#9ca3af",
      border: "#e5e5e5",
      accent: "#0d9488",
      statusSuccess: "#16a34a",
      statusWarning: "#d97706",
      statusDanger: "#dc2626",
    },
    fontSize: { xs: 11, sm: 12, base: 14, lg: 16 },
    fontWeight: { medium: "500", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8 },
    fontFamily: { mono: "monospace" },
  },
  flags: { enabled: true },
  queryOptions: [] as Array<{ refetchIntervalMs?: number } | undefined>,
  remoteState: {
    data: null as {
      state: string;
      message?: string | null;
      identityText?: string | null;
    } | null,
    error: null as Error | null,
    isError: false,
  },
  remoteApi: {
    call: vi.fn(async (_type: string, _params?: unknown) => ({}) as Record<string, unknown>),
    refetch: vi.fn(async () => undefined),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  TextInput: (props: Record<string, unknown>) =>
    React.createElement("input", {
      "data-testid": props.testID as string,
      value: (props.value as string) ?? "",
      readOnly: true,
    }),
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
  ScrollView: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  withUnistyles: (component: unknown) => (props: Record<string, unknown>) => {
    const { uniProps, ...rest } = props;
    const resolved =
      typeof uniProps === "function" ? (uniProps as (t: object) => object)(theme) : {};
    return React.createElement(component as never, { ...rest, ...resolved });
  },
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  getIsElectron: () => false,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    testID,
    onPress,
    disabled,
  }: {
    children?: React.ReactNode;
    testID?: string;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        disabled,
        "data-testid": testID,
        onClick: onPress,
      },
      children,
    ),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Check: icon("Check"),
    ChevronDown: icon("ChevronDown"),
    ChevronRight: icon("ChevronRight"),
    CircleAlert: icon("CircleAlert"),
    Copy: icon("Copy"),
    Loader2: icon("Loader2"),
  };
});

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));

vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => ({}) }));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, _feature: string) => flags.enabled,
}));

vi.mock("@/figma/api", () => ({
  callFigma: vi.fn(async () => ({})),
  useFigmaCall: () => remoteApi.call,
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));

vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn(async () => undefined) }));

vi.mock("@/figma/queries", () => ({
  useFigmaRemoteStatus: (_serverId: string, options?: { refetchIntervalMs?: number }) => {
    queryOptions.push(options);
    return {
      isLoading: false,
      data: remoteState.data,
      error: remoteState.error,
      isError: remoteState.isError,
      refetch: remoteApi.refetch,
    };
  },
}));

import { RemoteConnectionPanel, figmaHttpsAuthUrl } from "./remote-connection-panel";

const AUTH_URL = "https://www.figma.com/oauth?client_id=abc&state=xyz";

function status(
  state: string,
  extras: { message?: string | null; identityText?: string | null } = {},
) {
  return { state, ...extras };
}

describe("RemoteConnectionPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    flags.enabled = true;
    queryOptions.length = 0;
    remoteState.data = status("disconnected");
    remoteState.error = null;
    remoteState.isError = false;
    remoteApi.call.mockReset();
    remoteApi.call.mockResolvedValue({});
    remoteApi.refetch.mockReset();
    vi.mocked(openExternalUrl).mockClear();
  });

  afterEach(() => {
    if (root) {
      const mounted = root;
      act(() => mounted.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  function render(): HTMLDivElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => mounted.render(<RemoteConnectionPanel serverId="s1" />));
    return container;
  }

  /** Re-run the render so the mocked query's new `data` reaches the mounted tree. */
  function rerender(view: HTMLDivElement) {
    act(() => root?.render(<RemoteConnectionPanel serverId="s1" />));
    return view;
  }

  function press(view: HTMLDivElement, testID: string) {
    const target = view.querySelector(`[data-testid="${testID}"]`) as HTMLButtonElement | null;
    expect(target, testID).not.toBeNull();
    act(() => {
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return target;
  }

  async function pressAsync(view: HTMLDivElement, testID: string) {
    const target = view.querySelector(`[data-testid="${testID}"]`) as HTMLButtonElement | null;
    expect(target, testID).not.toBeNull();
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    return target;
  }

  // ── capability gate ────────────────────────────────────────────────────────

  it("shows only the update-host request when the host predates figmaRemoteWrites, with no data path", () => {
    flags.enabled = false;
    const view = render();
    expect(view.querySelector('[data-testid="figma-remote-update-host"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="figma-remote-panel"]')).toBeNull();
    // The gate is the first thing the panel does and nothing renders without it: no query hook
    // ran, so an old host is never asked for RPCs it cannot answer.
    expect(queryOptions.length).toBe(0);
    expect(remoteApi.call).not.toHaveBeenCalled();
  });

  it("renders the live panel once the capability is present", () => {
    const view = render();
    expect(view.querySelector('[data-testid="figma-remote-panel"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="figma-remote-update-host"]')).toBeNull();
  });

  // ── disconnected / explicit begin ──────────────────────────────────────────

  it("starts disconnected with Connect editing, never auto-opening sign-in or showing a link", () => {
    remoteState.data = status("disconnected", { identityText: "tester" });
    const view = render();
    const connect = view.querySelector('[data-testid="figma-remote-connect"]') as HTMLButtonElement;
    expect(connect).not.toBeNull();
    expect(connect.textContent).toBe("Connect editing");
    expect(connect.disabled).toBe(false);
    // Mount, query and a settled agent must not open OAuth on the user's behalf.
    expect(remoteApi.call).not.toHaveBeenCalled();
    expect(view.querySelector('[data-testid="figma-remote-auth-url"]')).toBeNull();
    expect(vi.mocked(openExternalUrl)).not.toHaveBeenCalled();
    // A disconnected view is static: idle (no poll) and no Retry surface.
    expect(queryOptions.at(-1)?.refetchIntervalMs).toBeUndefined();
    expect(view.querySelector('[data-testid="figma-remote-retry"]')).toBeNull();
    // Identity belongs to `connected` only — a stale whoami must not haunt the idle row.
    expect(view.querySelector('[data-testid="figma-remote-identity"]')).toBeNull();
  });

  it("begins sign-in on an explicit press only, then offers Open/Copy without opening the browser itself", async () => {
    remoteApi.call.mockResolvedValue({ status: status("connecting"), authorizationUrl: AUTH_URL });
    const view = render();
    await pressAsync(view, "figma-remote-connect");
    expect(remoteApi.call).toHaveBeenCalledTimes(1);
    expect(remoteApi.call).toHaveBeenCalledWith("figma.remote.auth.begin.request", {});
    // The gesture produced the link, but no browser was launched until the second gesture.
    expect(vi.mocked(openExternalUrl)).not.toHaveBeenCalled();
    expect(view.querySelector('[data-testid="figma-remote-open-auth"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="figma-remote-copy-auth"]')).not.toBeNull();
    await pressAsync(view, "figma-remote-open-auth");
    expect(vi.mocked(openExternalUrl)).toHaveBeenCalledWith(AUTH_URL);
    // A status re-read after the gesture keeps the row honest.
    expect(remoteApi.refetch).toHaveBeenCalled();
  });

  it("hides the sign-in affordances when the URL is not HTTPS-on-Figma or missing", async () => {
    for (const authorizationUrl of [
      "http://figma.com/oauth",
      "https://example.com/oauth",
      "https://figma.com.example.net/oauth",
      null,
      undefined,
    ]) {
      remoteApi.call.mockResolvedValue({ authorizationUrl });
      const view = render();
      await pressAsync(view, "figma-remote-connect");
      expect(view.querySelector('[data-testid="figma-remote-auth-url"]')).toBeNull();
      const mounted = root;
      if (mounted) act(() => mounted.unmount());
      root = null;
    }
  });

  // ── polling follows the observed state ─────────────────────────────────────

  it("polls while needs_auth and tells the user to complete sign-in on the host", () => {
    remoteState.data = status("needs_auth");
    const view = render();
    expect(queryOptions.at(-1)?.refetchIntervalMs).toBe(2_000);
    const hint = view.querySelector('[data-testid="figma-remote-host-hint"]');
    expect(hint?.textContent).toContain("host computer");
    expect(hint?.textContent).toContain("complete it");
    // The phone must not claim it can complete the callback itself — the host owns the loopback.
    expect(hint?.textContent).not.toContain("callback lands on this device");
    // The button invites continuing the sign-in explicitly, without launching anything.
    const connect = view.querySelector('[data-testid="figma-remote-connect"]') as HTMLButtonElement;
    expect(connect.textContent).toBe("Continue sign-in");
    expect(remoteApi.call).not.toHaveBeenCalled();
  });

  it("polls while connecting and blocks a second begin press mid-transition", () => {
    remoteState.data = status("connecting");
    const view = render();
    expect(queryOptions.at(-1)?.refetchIntervalMs).toBe(2_000);
    const connect = view.querySelector('[data-testid="figma-remote-connect"]') as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
  });

  it("stops polling once the connector settles and resumes it when it goes transitional", () => {
    remoteState.data = status("connecting");
    const view = render();
    expect(queryOptions.at(-1)?.refetchIntervalMs).toBe(2_000);
    remoteState.data = status("connected");
    rerender(view);
    expect(queryOptions.at(-1)?.refetchIntervalMs).toBeUndefined();
    remoteState.data = status("needs_auth");
    rerender(view);
    expect(queryOptions.at(-1)?.refetchIntervalMs).toBe(2_000);
  });

  // ── connected ──────────────────────────────────────────────────────────────

  it("shows the connector whoami as identity when present and never claims Saved", () => {
    remoteState.data = status("connected", { identityText: "whoami: @tester (Figma)" });
    const view = render();
    const identity = view.querySelector('[data-testid="figma-remote-identity"]');
    expect(identity?.textContent).toBe("whoami: @tester (Figma)");
    expect(view.textContent).not.toContain("Saved");
    expect(queryOptions.at(-1)?.refetchIntervalMs).toBeUndefined();
  });

  it("shows no identity line at all when whoami produced nothing — no placeholder", () => {
    remoteState.data = status("connected", { identityText: null });
    const view = render();
    expect(view.querySelector('[data-testid="figma-remote-identity"]')).toBeNull();
  });

  it("explains that connected is not a per-file rights claim", () => {
    remoteState.data = status("connected", { identityText: "whoami: @tester" });
    const view = render();
    const rights = view.querySelector('[data-testid="figma-remote-rights-hint"]');
    expect(rights?.textContent).toContain("per file");
  });

  it("disconnects through figma.remote.disconnect.request and clears the stored sign-in link", async () => {
    remoteState.data = status("disconnected");
    remoteApi.call.mockResolvedValue({ authorizationUrl: AUTH_URL });
    const view = render();
    await pressAsync(view, "figma-remote-connect");
    expect(view.querySelector('[data-testid="figma-remote-open-auth"]')).not.toBeNull();

    remoteState.data = status("connected");
    rerender(view);
    const disconnect = view.querySelector(
      '[data-testid="figma-remote-disconnect"]',
    ) as HTMLButtonElement;
    expect(disconnect).not.toBeNull();
    expect(disconnect.textContent).toBe("Disconnect editing");
    await pressAsync(view, "figma-remote-disconnect");
    expect(remoteApi.call).toHaveBeenCalledWith("figma.remote.disconnect.request", {});
    // Stopping JAgentDesk's connector is not an OAuth logout: the link the panel stored is gone.
    expect(view.querySelector('[data-testid="figma-remote-auth-url"]')).toBeNull();
    expect(remoteApi.refetch).toHaveBeenCalled();
  });

  // ── unavailable / error ────────────────────────────────────────────────────

  it("surfaces the daemon's dependency message verbatim when unavailable, with a stable Retry", () => {
    remoteState.data = status("unavailable", {
      message: "Codex CLI 0.165 is required on the host — update the host app.",
    });
    const view = render();
    const banner = view.querySelector('[data-testid="figma-error"]');
    expect(banner?.textContent).toContain("Codex CLI 0.165 is required on the host");
    // Dependency info, not pressure: the chat provider/model is not forced from here.
    expect(banner?.textContent).not.toContain("Saved");
    const retry = view.querySelector('[data-testid="figma-remote-retry"]');
    expect(retry).not.toBeNull();
    press(view, "figma-remote-retry");
    expect(remoteApi.refetch).toHaveBeenCalled();
    // Retry re-reads status; it must never relaunch OAuth behind the user's back.
    expect(remoteApi.call).not.toHaveBeenCalled();
  });

  it("shows the connector error message with Retry while error, without auto sign-in", () => {
    remoteState.data = status("error", { message: "Connector crashed on the host." });
    const view = render();
    expect(view.querySelector('[data-testid="figma-error"]')?.textContent).toContain(
      "Connector crashed on the host.",
    );
    expect(remoteApi.call).not.toHaveBeenCalled();
    press(view, "figma-remote-retry");
    expect(remoteApi.refetch).toHaveBeenCalled();
  });

  it("shows the query failure itself and keeps Retry wired to a fresh read", () => {
    remoteState.data = null;
    remoteState.isError = true;
    remoteState.error = new Error("The host is offline.");
    const view = render();
    expect(view.querySelector('[data-testid="figma-error"]')?.textContent).toContain(
      "The host is offline.",
    );
    press(view, "figma-remote-retry");
    expect(remoteApi.refetch).toHaveBeenCalled();
  });

  it("reports a failed begin as an action error instead of storing a phantom link", async () => {
    remoteApi.call.mockRejectedValue(new Error("codex app-server unavailable"));
    const view = render();
    await pressAsync(view, "figma-remote-connect");
    expect(view.querySelector('[data-testid="figma-error"]')?.textContent).toContain(
      "codex app-server unavailable",
    );
    expect(view.querySelector('[data-testid="figma-remote-auth-url"]')).toBeNull();
    // The button recovers — a stable Retry of the gesture, no auto-loop.
    const connect = view.querySelector('[data-testid="figma-remote-connect"]') as HTMLButtonElement;
    expect(connect.disabled).toBe(false);
  });

  // ── async safety ───────────────────────────────────────────────────────────

  it("ignores a begin response that settles after unmount", async () => {
    let resolveBegin: (value: Record<string, unknown>) => void = () => {};
    remoteApi.call.mockReturnValue(
      new Promise<Record<string, unknown>>((resolve) => {
        resolveBegin = resolve;
      }),
    );
    const view = render();
    const connect = view.querySelector('[data-testid="figma-remote-connect"]') as HTMLButtonElement;
    act(() => {
      connect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const mounted = root;
    root = null;
    act(() => mounted?.unmount());
    await act(async () => {
      resolveBegin({ authorizationUrl: AUTH_URL });
    });
    // A dead generation stamps nothing: no post-unmount refetch resurrection, no crash.
    expect(remoteApi.refetch).not.toHaveBeenCalled();
  });

  // ── URL validator (pure) ───────────────────────────────────────────────────

  it("accepts only HTTPS Figma hosts for the sign-in link", () => {
    expect(figmaHttpsAuthUrl("https://figma.com/oauth")).toBe("https://figma.com/oauth");
    expect(figmaHttpsAuthUrl("https://www.figma.com/oauth")).toBe("https://www.figma.com/oauth");
    expect(figmaHttpsAuthUrl("https://cdn.figma.com/x")).toBe("https://cdn.figma.com/x");
    expect(figmaHttpsAuthUrl("http://www.figma.com/oauth")).toBeNull();
    expect(figmaHttpsAuthUrl("https://example.com/oauth")).toBeNull();
    expect(figmaHttpsAuthUrl("figma.com/oauth")).toBeNull();
    expect(figmaHttpsAuthUrl("https://notfigma.com/x")).toBeNull();
    expect(figmaHttpsAuthUrl("")).toBeNull();
    expect(figmaHttpsAuthUrl(null)).toBeNull();
    expect(figmaHttpsAuthUrl(undefined)).toBeNull();
  });
});
