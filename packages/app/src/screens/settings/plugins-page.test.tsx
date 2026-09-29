/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { PluginListItem, PluginLogEntry } from "@jagentdesk/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPluginsPage } from "./plugins-page";

void testI18n;

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  logsSupported: true,
  sourceInstallSupported: true,
  client: null as DaemonClient | null,
  push: (_route: unknown) => {},
  settingsScreens: [] as Array<{ id: string; title: string; icon: string }>,
}));

vi.mock("@/plugins/registry", async () => {
  const actual = await vi.importActual<typeof import("@/plugins/registry")>("@/plugins/registry");
  return {
    ...actual,
    useInstalledPlugin: (_serverId: string, pluginId: string) =>
      runtime.settingsScreens.length > 0
        ? { id: pluginId, settingsScreens: runtime.settingsScreens }
        : null,
  };
});

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: (route: unknown) => runtime.push(route) }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) => {
    if (feature === "pluginLogs") return runtime.logsSupported;
    if (feature === "pluginSourceInstallation") return runtime.sourceInstallSupported;
    return runtime.supported;
  },
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("@/components/adaptive-modal-sheet")>(
    "@/components/adaptive-modal-sheet",
  );
  return {
    ...actual,
    AdaptiveModalSheet: ({
      header,
      children,
      onClose,
    }: {
      header: { title: string; actions?: React.ReactNode };
      children: React.ReactNode;
      onClose(): void;
    }) =>
      ReactModule.createElement(
        "div",
        { role: "dialog" },
        ReactModule.createElement("h2", null, header.title),
        header.actions,
        ReactModule.createElement("button", { type: "button", onClick: onClose }, "Close"),
        children,
      ),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const { ScrollView, TextInput } =
    await vi.importActual<typeof import("react-native")>("react-native");
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetModal: ReactModule.forwardRef(() => null),
    BottomSheetScrollView: ScrollView,
    BottomSheetTextInput: TextInput,
    useBottomSheetInternal: () => null,
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function plugin(enabled = true): PluginListItem {
  return {
    id: "example",
    description: "Reviews changes before merge",
    path: "/plugins/example",
    enabled,
    status: enabled ? "running" : "disabled",
    installation: {
      identity: { kind: "npm", packageName: "example-plugin", pluginPath: "." },
      currentRevision: "1.0.0",
    },
  };
}

async function selectPluginAction(action: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Actions for example" }));
  fireEvent.click(await screen.findByRole("button", { name: action }));
}

function createClient() {
  return {
    on: vi.fn(() => () => {}),
    getDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    patchDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    listPlugins: vi.fn(async (): Promise<PluginListItem[]> => []),
    installSourcePlugin: vi.fn(async () => plugin()),
    reloadPlugin: vi.fn(async () => plugin()),
    enablePlugin: vi.fn(async () => plugin()),
    disablePlugin: vi.fn(async () => plugin(false)),
    removePlugin: vi.fn(async () => undefined),
    getPluginLogs: vi.fn(async (): Promise<PluginLogEntry[]> => []),
  };
}

type PluginClient = ReturnType<typeof createClient>;

function renderPage(client: PluginClient | null): void {
  runtime.client = client as unknown as DaemonClient | null;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const element: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <HostPluginsPage serverId="host-a" />
    </QueryClientProvider>
  );
  render(element);
}

describe("HostPluginsPage", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    runtime.connected = true;
    runtime.supported = true;
    runtime.logsSupported = true;
    runtime.sourceInstallSupported = true;
    runtime.client = null;
    runtime.push = () => {};
    runtime.settingsScreens = [];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the offline state", () => {
    runtime.connected = false;
    renderPage(null);

    expect(screen.getByRole("alert").textContent).toContain("Plugin host is offline");
  });

  it("renders a catalog error and retries through the real query", async () => {
    const client = createClient();
    client.listPlugins.mockRejectedValueOnce(new Error("catalog exploded"));
    renderPage(client);

    expect(await screen.findByText("Unable to load plugins")).toBeDefined();
    expect(screen.getByText("catalog exploded")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(client.listPlugins).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No plugins configured")).toBeDefined();
  });

  it("installs a trimmed plugin source and resets the form", async () => {
    const client = createClient();
    renderPage(client);

    const input = await screen.findByLabelText("Plugin source");
    fireEvent.change(input, { target: { value: "  npm:example-plugin@^1.0.0  " } });
    fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));

    await waitFor(() =>
      expect(client.installSourcePlugin).toHaveBeenCalledWith("npm:example-plugin@^1.0.0"),
    );
    expect(await screen.findByText("Installed example")).toBeDefined();
    await waitFor(() =>
      expect((screen.getByLabelText("Plugin source") as HTMLInputElement).value).toBe(""),
    );
  });

  it("asks for a host update instead of offering source installs on older hosts", async () => {
    runtime.sourceInstallSupported = false;
    const client = createClient();
    renderPage(client);

    expect(await screen.findByText("Update this host to install plugins")).toBeDefined();
    expect(screen.queryByLabelText("Plugin source")).toBeNull();
  });

  it("keeps the Marketplace entry point", async () => {
    const pushed: unknown[] = [];
    runtime.push = (route) => pushed.push(route);
    renderPage(createClient());

    fireEvent.click(await screen.findByRole("button", { name: "Browse marketplace" }));

    expect(pushed).toHaveLength(1);
    expect(JSON.stringify(pushed[0])).toContain("marketplace");
  });

  it("shows the plugin description and installed source revision", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    expect(await screen.findByText("Reviews changes before merge")).toBeDefined();
    expect(screen.getByText("npm:example-plugin · 1.0.0")).toBeDefined();
  });

  it("keeps plugin settings screen buttons for enabled plugins", async () => {
    const pushed: unknown[] = [];
    runtime.push = (route) => pushed.push(route);
    runtime.settingsScreens = [{ id: "display", title: "Display settings", icon: "Settings" }];
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Display settings" }));

    expect(pushed).toEqual([
      {
        pathname: "/settings/hosts/[serverId]/plugins/[pluginId]/[screenId]",
        params: { serverId: "host-a", pluginId: "example", screenId: "display" },
      },
    ]);
  });

  it("hides plugin settings screen buttons while the plugin is disabled", async () => {
    runtime.settingsScreens = [{ id: "display", title: "Display settings", icon: "Settings" }];
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin(false)]);
    renderPage(client);

    await screen.findByText("example");
    expect(screen.queryByRole("button", { name: "Display settings" })).toBeNull();
  });

  it("toggles a plugin with its switch", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("switch", { name: "example: Disable" }));

    await waitFor(() => expect(client.disablePlugin).toHaveBeenCalledWith("example"));
  });

  it.each([
    ["reloadPlugin", "Reload"],
    ["removePlugin", "Remove"],
  ] as const)("runs %s from the plugin actions menu", async (method, action) => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    await selectPluginAction(action);

    await waitFor(() => expect(client[method]).toHaveBeenCalledTimes(1));
  });

  it("hides the logs action when the host does not advertise support", async () => {
    runtime.logsSupported = false;
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    await screen.findByText("example");
    fireEvent.click(screen.getByRole("button", { name: "Actions for example" }));
    expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
  });

  it("opens readable stdout and stderr logs and refreshes them", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.getPluginLogs.mockResolvedValue([
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout",
        message: "ready",
      },
      {
        sequence: 2,
        timestamp: "2026-08-16T12:00:01.000Z",
        stream: "stderr",
        message: "warning",
      },
    ]);
    renderPage(client);

    await selectPluginAction("Logs");

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Logs: example")).toBeDefined();
    expect(await screen.findByText("ready")).toBeDefined();
    expect(screen.getByText("warning")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(client.getPluginLogs).toHaveBeenCalledTimes(2));
  });
});
