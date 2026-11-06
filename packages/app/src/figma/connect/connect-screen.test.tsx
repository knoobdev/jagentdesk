// @vitest-environment jsdom
/**
 * Figma connect screen (QA F4 items 6/7).
 *
 * Renders the real component (with the real Figma UI kit) to the DOM with React Native
 * mocked, then reads the DOM directly:
 *  - the Client ID / Client secret inputs must not carry value-shaped placeholders — the
 *    labels "Client ID"/"123456" used to leak into `placeholder`, which the kit then tinted
 *    with the accent color, so an empty field looked like it had a prefilled value;
 *  - the kit's Input must resolve its placeholder tint from the muted theme token, never the
 *    accent token — with `withUnistyles` reduced to prop-resolution here, the resolved prop is
 *    the contract the native/web renderers receive;
 *  - the credential block must sit inside the standard stacked-column gap (theme.spacing[4]);
 *  - plus the behaviour lock the QA round must not regress: Sign in triggers the store action
 *    and every action blocks while a sign-in is in flight.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaConnection } from "@jagentdesk/protocol/figma/rpc-schemas";
import * as Clipboard from "expo-clipboard";

vi.stubGlobal("React", React);

const { theme, connectState, storeFns } = vi.hoisted(() => ({
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
  connectState: {
    state: {
      clientId: "",
      clientSecret: "",
      signedInLabel: null as string | null,
      phase: { kind: "idle" } as Record<string, unknown>,
    },
  },
  storeFns: {
    configureFigmaConnect: vi.fn(),
    requestFigmaDelegatedSignIn: vi.fn(async () => "sent" as const),
    resetFigmaConnect: vi.fn(),
    setFigmaConnectDraft: vi.fn(),
    startFigmaBrowserSignIn: vi.fn(async () => undefined),
    startFigmaPasteSignIn: vi.fn(async () => undefined),
    submitFigmaPastedUrl: vi.fn(async () => undefined),
  },
}));

// Match the real store: snapshots stay stable between updates and are replaced on change.
function setState(patch: Partial<typeof connectState.state>) {
  connectState.state = { ...connectState.state, ...patch };
}

vi.mock("./store", () => ({
  ...storeFns,
  getFigmaConnectState: () => connectState.state,
  subscribeFigmaConnect: () => () => {},
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({
    children,
    testID,
    style,
  }: {
    children?: React.ReactNode;
    testID?: string;
    style?: { gap?: number };
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": testID,
        "data-gap": style?.gap === undefined ? undefined : String(style.gap),
      },
      children,
    ),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  TextInput: (props: Record<string, unknown>) =>
    React.createElement("input", {
      "data-testid": props.testID as string,
      value: (props.value as string) ?? "",
      placeholder: (props.placeholder as string) ?? "",
      "aria-label": (props.accessibilityLabel as string) ?? "",
      "data-placeholder-text-color": (props.placeholderTextColor as string) ?? "",
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
  // Identity-ish wrapper that resolves uniProps the way the real HOC feeds the theme through.
  withUnistyles: (component: unknown) => (props: Record<string, unknown>) => {
    const { uniProps, ...rest } = props;
    const resolved =
      typeof uniProps === "function" ? (uniProps as (t: object) => object)(theme) : {};
    return React.createElement(component as never, { ...rest, ...resolved });
  },
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
        "data-disabled": String(Boolean(disabled)),
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
vi.mock("@/figma/api", () => ({
  callFigma: vi.fn(async () => ({ connection: null })),
  useFigmaCall: () => vi.fn(async () => ({})),
  errorMessage: (cause: unknown) => String(cause),
}));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn(async () => undefined) }));
vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  getIsElectron: () => false,
}));
vi.mock("./oauth-flow", () => ({
  canUseLoopback: () => true,
  finishWithLoopback: vi.fn(async () => undefined),
  FIGMA_APPS_URL: "https://www.figma.com/developers/apps",
  FIGMA_CALLBACK_URL: "http://127.0.0.1:8766/figma/callback",
  FIGMA_OAUTH_SCOPES: ["file_read"],
}));

import { FigmaConnectScreen } from "./connect-screen";

describe("FigmaConnectScreen", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    setState({
      clientId: "",
      clientSecret: "",
      signedInLabel: null,
      phase: { kind: "idle" },
    });
    for (const fn of Object.values(storeFns)) fn.mockClear?.();
    storeFns.resetFigmaConnect.mockImplementation(() => setState({ signedInLabel: null }));
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

  function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() =>
      mounted.render(<FigmaConnectScreen serverId="s1" connections={[]} onConnected={undefined} />),
    );
    return container;
  }

  function input(testID: string) {
    return render().querySelector(`[data-testid="${testID}"]`) as HTMLInputElement;
  }

  it("does not repeat the label as an entered value and the placeholder is not a fake value", () => {
    const view = render();
    const clientId = view.querySelector('[data-testid="figma-client-id"]') as HTMLInputElement;
    const clientSecret = view.querySelector(
      '[data-testid="figma-client-secret"]',
    ) as HTMLInputElement;
    // Empty inputs carry no value-shaped text — the labels were leaking as placeholders before.
    expect(clientId.value).toBe("");
    expect(clientSecret.value).toBe("");
    expect(clientId.getAttribute("placeholder")).toBe("");
    expect(clientSecret.getAttribute("placeholder")).toBe("");
    // Identity for a11y comes from accessibilityLabel, not the placeholder.
    expect(clientId.getAttribute("aria-label")).toBe("Client ID");
    expect(clientSecret.getAttribute("aria-label")).toBe("Client secret");
  });

  it("tints any placeholder with the muted token, never the accent", () => {
    const clientId = input("figma-client-id");
    const placeholderTextColor = clientId.getAttribute("data-placeholder-text-color");
    expect(placeholderTextColor).toBe(theme.colors.foregroundMuted);
    expect(placeholderTextColor).not.toBe(theme.colors.accent);
  });

  it("separates the form from the card above with the standard block spacing", () => {
    const view = render();
    const screen = view.querySelector('[data-testid="figma-connect-screen"]');
    expect(screen).not.toBeNull();
    // The credential block is one stacked column on the standard block gap (theme.spacing[4]).
    expect(screen?.getAttribute("data-gap")).toBe(String(theme.spacing[4]));
  });

  it("routes Sign in with browser to the store action", () => {
    const view = render();
    act(() => {
      view
        .querySelector('[data-testid="figma-signin-browser"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(storeFns.startFigmaBrowserSignIn).toHaveBeenCalledWith("s1");
  });

  it("blocks every action while a sign-in is in flight", () => {
    setState({ phase: { kind: "starting" } });
    const view = render();
    const browser = view.querySelector('[data-testid="figma-signin-browser"]') as HTMLButtonElement;
    const paste = view.querySelector('[data-testid="figma-signin-paste"]') as HTMLButtonElement;
    expect(browser.disabled).toBe(true);
    expect(paste.disabled).toBe(true);
  });

  // The guide's scope list and the daemon's authorize request share one source in oauth-flow.ts
  // (pinned to spec 32.2 in oauth-flow.test.ts); this proves the guide renders that list verbatim
  // and Copy all copies exactly it, so the user ticks what will actually be requested.
  it("shows the guide's requested-scope list and copies exactly that list", () => {
    const view = render();
    const guide = view.querySelector('[data-testid="figma-connect-guide"]');
    expect(guide?.textContent).toContain("file_read");
    const scopes = view.querySelector('[data-testid="figma-guide-scopes"]');
    expect(scopes?.textContent).toBe("file_read");
    act(() => {
      view
        .querySelector('[data-testid="figma-copy-scopes"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(vi.mocked(Clipboard.setStringAsync)).toHaveBeenCalledWith("file_read");
  });

  // figma.connections.test is GET /v1/me: it proves the sign-in, not file access (the live 403
  // came after a 200 /me). The note must not overclaim what was checked.
  it("presents the connection test as an account check, never as proof of file access", async () => {
    const connected = {
      id: "fgc_note",
      account: { figmaUserId: "u-9", handle: "tester", email: null },
      authState: "connected",
      createdAt_ms: 1,
    } as FigmaConnection;
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() =>
      mounted.render(
        <FigmaConnectScreen serverId="s1" connections={[connected]} onConnected={undefined} />,
      ),
    );
    const button = container.querySelector(
      '[data-testid="figma-connection-test"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const row = container.querySelector('[data-testid="figma-connection-row-fgc_note"]');
    expect(row?.textContent).toContain("Account sign-in is valid");
    expect(row?.textContent).toContain("File access is checked when a file is added");
    expect(row?.textContent).not.toContain("Token is valid");
  });

  it("navigates once after sign-in while the connection query is still catching up", () => {
    setState({ signedInLabel: "<client-id>" });
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    function WaitingForConnectionQuery() {
      const [navigationUpdates, setNavigationUpdates] = React.useState(0);
      const onConnected = React.useCallback(() => {
        // Bound a regression so a navigation loop fails instead of hanging the worker.
        if (navigationUpdates >= 3) throw new Error("Repeated sign-in navigation");
        setNavigationUpdates(navigationUpdates + 1);
      }, [navigationUpdates]);
      return (
        <>
          <span data-testid="navigation-updates">{navigationUpdates}</span>
          <FigmaConnectScreen serverId="s1" connections={[]} onConnected={onConnected} />
        </>
      );
    }
    act(() => mounted.render(<WaitingForConnectionQuery />));
    expect(container.querySelector('[data-testid="navigation-updates"]')?.textContent).toBe("1");
    // Visiting Connections again must leave the guide open rather than replay the old login.
    const reopened = vi.fn();
    act(() =>
      mounted.render(<FigmaConnectScreen serverId="s1" connections={[]} onConnected={reopened} />),
    );
    expect(reopened).not.toHaveBeenCalled();
  });

  it("does not replay the sign-in navigation when StrictMode re-runs the effect", () => {
    setState({ signedInLabel: "<client-id>" });
    const onConnected = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() =>
      mounted.render(
        <React.StrictMode>
          <FigmaConnectScreen serverId="s1" connections={[]} onConnected={onConnected} />
        </React.StrictMode>,
      ),
    );
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
