import { GUMLOOP_INSPECTOR_HOST } from "@/components/gumloop-shell/sidebar-state";
import { useSettingsSidebarPresentation } from "@/navigation/settings-presentation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  WindowLayoutProvider,
  WindowLayoutActionsHost,
  WindowLayoutSurface,
  WindowLayoutDivisionGap,
  useWindowLayout,
  resolveDesktopDivisionLayout,
} from "@/window-layout";
import { WorkspaceLayoutModePublisher } from "@/workspace-tabs/layout-mode-publisher";
import { FloatingHeaderLayout } from "@/components/floating-header";
import { StreamTopOverlayProvider, supportsStreamTopOverlay } from "@/agent-stream/top-overlay";
import { GumloopCompactHeader } from "@/components/gumloop-shell/compact-header";
import { GumloopDrawer } from "@/components/gumloop-shell/drawer";
import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { useGumloopSidebarShortcut } from "@/components/gumloop-shell/use-sidebar-shortcut";
import { NotificationOpenRouter } from "@/notification-open/react";

import { useHardwareKeyboardPresent } from "@/keyboard";
import { AppearanceSystemBars } from "@/appearance/system-bars";
import { resolveContentMaxWidth } from "@/hooks/use-settings";
import { ChangelogHost } from "@/changelog";
import { UsageSidebarRoot } from "@/usage/sidebar-item";
import { HostConfirmationSheet } from "@/hosts/host-confirmation-sheet";
import "@/styles/unistyles";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider, PortalHost } from "@gorhom/portal";
import * as Linking from "expo-linking";
import { Stack, useNavigationContainerRef, usePathname, useRouter, type Href } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, AppState, useColorScheme, useWindowDimensions, View } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { PluginCatalogSync, PluginCommandCenterActions } from "@/plugins";
import { CommandCenter } from "@/command-center/command-center";
import { CommandCenterRootActions } from "@/command-center/root-registration";
import { CommandCenterProvider } from "@/command-center/provider";
import { CommandCenterWorkspaceActions } from "@/command-center/workspace-registration";
import { AddProjectFlowHost } from "@/components/add-project-flow-host";
import { WorktreeSetupCalloutSource } from "@/components/worktree-setup-callout-source";
import { DownloadToast } from "@/components/download-toast";
import { QuittingOverlay } from "@/components/quitting-overlay";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { AppDiagnosticHost } from "@/components/app-diagnostic-host";
import { ConnectionLogHost } from "@/components/connection-log-sheet";
import { LeftSidebar } from "@/components/left-sidebar";
import { WindowSidebarMenuToggle } from "@/components/headers/menu-header";
import { SidebarModelProvider } from "@/components/sidebar/sidebar-model";
import { WorkspacePinShortcutHandler } from "@/components/workspace-pin-shortcut-handler";
import { CompactExplorerSidebarHost } from "@/components/compact-explorer-sidebar-host";
import { WorkspaceArchiveShortcutHandler } from "@/components/workspace-archive-shortcut-handler";
import { WorkspaceArchiveUndoShortcutHost } from "@/workspace/archive-undo";
import { ArchiveCaptureLessonsHost } from "@/continuity/agent-durable-actions";
import { ProviderSettingsHost } from "@/components/provider-settings-host";
import { WorkspaceSetupDialog } from "@/components/workspace-setup-dialog";
import { WorkspaceShortcutTargetsSubscriber } from "@/components/workspace-shortcut-targets-subscriber";
import { FloatingPanelPortalHost } from "@/components/ui/floating-panel-portal";
import { HostChooserModal, useHostChooser } from "@/hosts/host-chooser";
import {
  getIsElectronRuntimeMac,
  HEADER_INNER_HEIGHT,
  useIsCompactFormFactor,
} from "@/constants/layout";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
  resolveDesktopSidebarVisibility,
} from "@/components/desktop-sidebar-layout";
import { isNative, isWeb } from "@/constants/platform";
import { HorizontalScrollProvider } from "@/contexts/horizontal-scroll-context";
import { SessionProvider } from "@/contexts/session-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { ToastProvider } from "@/contexts/toast-context";
import { VoiceProvider } from "@/contexts/voice-context";
import {
  resolveStartupBlocker,
  resolveStartupNavigationReady,
  shouldRunStartupGiveUpTimer,
  startHostRuntimeBootstrap,
  type StartupBlocker,
} from "@/navigation/host-runtime-bootstrap";
import { registerWorkspaceRouteNavigationRef } from "@/navigation/workspace-route-navigation";
import { useSettingsRouteEntry } from "@/navigation/settings-presentation";
import { ThemedStack } from "@/navigation/themed-stack";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { AgentNavigationListener } from "@/desktop/agent-navigation";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { updateDesktopWindowControls } from "@/desktop/electron/window";
import { getDesktopHost } from "@/desktop/host";
import { loadDesktopSettings } from "@/desktop/settings/desktop-settings";
import { RosettaCalloutSource } from "@/desktop/rosetta-callout-source";
import { useActiveWorktreeNewAction } from "@/hooks/use-active-worktree-new-action";
import { useGlobalNewWorkspaceAction } from "@/hooks/use-global-new-workspace-action";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useLatchedBoolean } from "@/hooks/use-latched-boolean";
import { useFaviconStatus } from "@/hooks/use-favicon-status";
import { useKeyboardShortcuts } from "@/keyboard/use-shortcuts";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { useCompactWebViewportZoomLock } from "@/hooks/use-compact-web-viewport-zoom-lock";
import { useOpenProject } from "@/hooks/use-open-project";
import { useAppSettings } from "@/hooks/use-settings";
import { useOpenAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { PairDeviceModal } from "@/desktop/components/pair-device-modal";
import {
  getTailnetMode,
  refreshTailscaleStatus,
  reviveTailnetHosts,
  useTailnetMode,
} from "@/tailscale";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { polyfillCrypto } from "@/polyfills/crypto";
import { createSourceHostReconnectHandler } from "@/runtime/migration/reverse-migration-handler";
import {
  getHostRuntimeStore,
  hasConfiguredLocalDaemonOverride,
  useHostRegistryLoaded,
  useHostRuntimeClient,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { ConnectionNotifications } from "@/runtime/connection-notifications";
import { applyAppearance } from "@/screens/settings/appearance/apply-appearance";
import { resolveThemeTarget } from "@/screens/settings/appearance/theme-target";
import { usePluginThemeCatalog } from "@/plugins/themes";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { flushDraftPersistStorage } from "@/stores/draft-store";
import { usePairDeviceModalStore } from "@/stores/pair-device-modal-store";
import type { ThemeName } from "@/styles/theme";
import { installWebScrollbarStyles } from "@/styles/install-web-scrollbar-styles";
import { installWebPlaceholderStyles } from "@/styles/install-web-placeholder-styles";
import type { HostProfile } from "@/types/host-connection";
import { toggleDesktopSidebarsWithCheckoutIntent } from "@/utils/desktop-sidebar-toggle";
import { GumloopSidebar } from "@/components/gumloop-shell/sidebar";

import { useGumloopDesktopShell } from "@/components/gumloop-shell/use-gumloop-chrome";
import {
  resolveTrafficLightOffsetY,
  useHasWindowChromeObstruction,
  WindowChromeProvider,
  WindowChromeRegion,
  WindowChromeSafeArea,
} from "@/utils/desktop-window";
import {
  parseHostWorkspaceRouteFromPathname,
  parseServerIdFromPathname,
} from "@/utils/host-routes";

polyfillCrypto();

export interface HostRuntimeBootstrapState {
  splashError: string | null;
  retry: () => void;
  hasGivenUpWaitingForHost: boolean;
  storeReady: boolean;
  startupBlocker: StartupBlocker;
}

const HostRuntimeBootstrapContext = createContext<HostRuntimeBootstrapState>({
  splashError: null,
  retry: () => {},
  hasGivenUpWaitingForHost: false,
  storeReady: false,
  startupBlocker: { kind: "none" },
});

function PushNotificationRouter() {
  const { startupBlocker } = useHostRuntimeBootstrapState();
  return <NotificationOpenRouter startupBlocked={startupBlocker.kind !== "none"} />;
}

function ManagedDaemonSession({ daemon }: { daemon: HostProfile }) {
  const client = useHostRuntimeClient(daemon.serverId);

  if (!client) {
    return null;
  }

  return (
    <SessionProvider key={daemon.serverId} serverId={daemon.serverId} client={client}>
      <PluginCatalogSync serverId={daemon.serverId} client={client} />
    </SessionProvider>
  );
}

function HostSessionManager() {
  const hosts = useHosts();

  if (hosts.length === 0) {
    return null;
  }

  return (
    <>
      {hosts.map((daemon) => (
        <ManagedDaemonSession key={daemon.serverId} daemon={daemon} />
      ))}
    </>
  );
}

export function useEarliestOnlineHostServerId(): string | null {
  const store = getHostRuntimeStore();
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeAll = store.subscribeAll(listener);
      const unsubscribeHostList = store.subscribeHostList(listener);
      return () => {
        unsubscribeAll();
        unsubscribeHostList();
      };
    },
    [store],
  );
  return useSyncExternalStore(
    subscribe,
    () => store.getEarliestOnlineHostServerId(),
    () => store.getEarliestOnlineHostServerId(),
  );
}

function useDaemonStartLastError(): string | null {
  const service = getDaemonStartService({
    store: getHostRuntimeStore(),
    getTailnetMode,
  });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getLastError(),
    () => service.getLastError(),
  );
}

function useDaemonStartIsRunning(): boolean {
  const service = getDaemonStartService({
    store: getHostRuntimeStore(),
    getTailnetMode,
  });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.isRunning(),
    () => service.isRunning(),
  );
}

const STARTUP_GIVE_UP_TIMEOUT_MS = 5_000;

async function shouldStartBuiltInDaemon(): Promise<boolean> {
  if (!shouldUseDesktopDaemon()) {
    return false;
  }
  if (hasConfiguredLocalDaemonOverride()) {
    return false;
  }
  // ADR-0056: a fresh desktop starts its bundled daemon right away and lands
  // on it as the "Local" host; Tailscale sign-in is optional (Settings).
  const settings = await loadDesktopSettings();
  return settings.daemon.manageBuiltInDaemon;
}

function HostRuntimeBootstrapProvider({ children }: { children: ReactNode }) {
  const { mode: tailnetMode, loaded: tailnetModeLoaded } = useTailnetMode();

  useEffect(() => {
    if (!tailnetModeLoaded) {
      return;
    }
    const store = getHostRuntimeStore();
    const daemonStartService = getDaemonStartService({ store, getTailnetMode });
    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: shouldStartBuiltInDaemon,
    });
  }, [tailnetMode, tailnetModeLoaded]);

  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const daemonStartError = useDaemonStartLastError();
  const daemonStartIsRunning = useDaemonStartIsRunning();
  const [hasGivenUpWaitingForHost, setHasGivenUpWaitingForHost] = useState(false);
  const isDesktopRuntime = shouldUseDesktopDaemon();
  const startupBlocker = useMemo(
    () =>
      resolveStartupBlocker({
        isDesktopRuntime,
        anyOnlineHostServerId,
        daemonStartIsRunning,
        daemonStartError,
      }),
    [anyOnlineHostServerId, daemonStartError, daemonStartIsRunning, isDesktopRuntime],
  );
  const shouldRunGiveUpTimer = shouldRunStartupGiveUpTimer({
    startupBlocker,
    anyOnlineHostServerId,
    hasGivenUpWaitingForHost,
  });

  useEffect(() => {
    if (!shouldRunGiveUpTimer) {
      return;
    }
    const handle = setTimeout(() => {
      setHasGivenUpWaitingForHost(true);
    }, STARTUP_GIVE_UP_TIMEOUT_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [shouldRunGiveUpTimer]);

  const retry = useCallback(() => {
    const daemonStartService = getDaemonStartService({
      store: getHostRuntimeStore(),
      getTailnetMode,
    });
    void daemonStartService.startIfEnabled({ shouldStart: shouldStartBuiltInDaemon });
  }, []);

  const splashError =
    startupBlocker.kind === "managed-daemon-error" ? startupBlocker.message : null;
  const storeReady = resolveStartupNavigationReady({ startupBlocker });

  const state = useMemo<HostRuntimeBootstrapState>(
    () => ({ splashError, retry, hasGivenUpWaitingForHost, storeReady, startupBlocker }),
    [splashError, retry, hasGivenUpWaitingForHost, storeReady, startupBlocker],
  );

  return (
    <HostRuntimeBootstrapContext.Provider value={state}>
      {children}
    </HostRuntimeBootstrapContext.Provider>
  );
}

export function useStoreReady(): boolean {
  return useContext(HostRuntimeBootstrapContext).storeReady;
}

export function useHostRuntimeBootstrapState(): HostRuntimeBootstrapState {
  return useContext(HostRuntimeBootstrapContext);
}

const rowStyle = { flex: 1, flexDirection: "row" } as const;
const flexStyle = { flex: 1 } as const;
const MOBILE_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

interface AppContainerProps {
  children: ReactNode;
  chromeEnabled?: boolean;
}

const THEME_CYCLE_ORDER: ThemeName[] = [
  "gumloop",
  "gumloopDark",
  "dark",
  "zinc",
  "midnight",
  "claude",
  "ghostty",
  "light",
];
const WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING = 12;

function PairDeviceRequestAutoOpener() {
  const localServerId = useLocalDaemonServerId();
  const runtimeSnapshot = useHostRuntimeSnapshot(localServerId ?? "");
  const openPairDeviceModal = usePairDeviceModalStore((state) => state.open);
  const activeRequestKey = (runtimeSnapshot?.pendingPairingRequests ?? [])
    .filter((request) => request.status === "completed" || request.expiresAtMs > Date.now())
    .map((request) => `${request.requestId}:${request.status}`)
    .join("|");

  useEffect(() => {
    if (localServerId && activeRequestKey) {
      openPairDeviceModal(localServerId);
    }
  }, [activeRequestKey, localServerId, openPairDeviceModal]);

  return null;
}

function GlobalPairDeviceModal() {
  const serverId = usePairDeviceModalStore((state) => state.serverId);
  const closePairDeviceModal = usePairDeviceModalStore((state) => state.close);

  return (
    <PairDeviceModal
      serverId={serverId ?? ""}
      visible={Boolean(serverId)}
      onClose={closePairDeviceModal}
      testID="pair-device-modal"
    />
  );
}

function AppContainer({ children, chromeEnabled: chromeEnabledOverride }: AppContainerProps) {
  const daemons = useHosts();
  const { settings, updateSettings } = useAppSettings();
  const toggleMobileAgentList = usePanelStore((state) => state.toggleMobileAgentList);
  const toggleDesktopAgentList = usePanelStore((state) => state.toggleDesktopAgentList);
  const openDesktopAgentList = usePanelStore((state) => state.openDesktopAgentList);
  const closeDesktopAgentList = usePanelStore((state) => state.closeDesktopAgentList);
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const exitFocusMode = usePanelStore((state) => state.exitFocusMode);
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const isDesktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const isDesktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const { width: viewportWidth } = useWindowDimensions();

  const cycleTheme = useCallback(() => {
    const currentIndex = THEME_CYCLE_ORDER.indexOf(settings.theme as ThemeName);
    const nextIndex = (currentIndex + 1) % THEME_CYCLE_ORDER.length;
    void updateSettings({ theme: THEME_CYCLE_ORDER[nextIndex] });
  }, [settings.theme, updateSettings]);

  const isCompactLayout = useIsCompactFormFactor();
  useCompactWebViewportZoomLock(isCompactLayout);
  const pathname = usePathname();
  // Forge Hub renders its own thin icon-rail (forge-hub-screen.tsx), so on that
  // route the wide app rail is hidden and Forge fills the full window width.

  const isWorkspaceRoute = parseHostWorkspaceRouteFromPathname(pathname) !== null;
  const isWorkspaceFocusModeEnabled = isWorkspaceRoute && isFocusModeEnabled;
  const chromeEnabled = chromeEnabledOverride ?? daemons.length > 0;
  const gumloopShell = useGumloopDesktopShell(chromeEnabled);
  const gumloopTheme = useIsGumloopTheme();
  useGumloopSidebarShortcut(gumloopShell);
  const onForge = !gumloopShell && pathname.endsWith("/forge");
  const sidebarEnabled = useMemo(
    () => chromeEnabled || gumloopShell || (gumloopTheme && pathname.startsWith("/settings")),
    [chromeEnabled, gumloopShell, gumloopTheme, pathname],
  );
  const settingsSidebar = useSettingsSidebarPresentation({
    presentation: isCompactLayout ? "overlay" : "dock",
    visible: sidebarEnabled,
  });
  const applyPanelLayout = usePanelStore((state) => state.applyPanelLayout);
  useLayoutEffect(() => {
    applyPanelLayout({ isCompact: isCompactLayout, leftSidebar: settingsSidebar.presentation });
  }, [applyPanelLayout, isCompactLayout, settingsSidebar.presentation]);
  const hasMountedDesktopSidebar = useLatchedBoolean(sidebarEnabled);
  const toggleAgentList = isCompactLayout ? toggleMobileAgentList : toggleDesktopAgentList;
  const toggleDesktopSidebars = useCallback(() => {
    const { desktop } = usePanelStore.getState();
    toggleDesktopSidebarsWithCheckoutIntent({
      isAgentListOpen: desktop.agentListOpen,
      isFileExplorerOpen: desktop.fileExplorerOpen,
      openAgentList: openDesktopAgentList,
      closeAgentList: closeDesktopAgentList,
      closeFileExplorer: closeDesktopFileExplorer,
      toggleFocusedFileExplorer: () =>
        keyboardActionDispatcher.dispatch({
          id: "sidebar.toggle.right",
          scope: "sidebar",
        }),
    });
  }, [closeDesktopAgentList, closeDesktopFileExplorer, openDesktopAgentList]);
  // TODO: stop matching pathname here as a branch. `chromeEnabled` should not
  // conflate workspace/project-specific chrome (sidebar, mobile gesture) with
  // global concerns like keyboard shortcuts. Split those out so settings (and
  // other non-workspace routes) don't need a special-case to keep shortcuts alive.
  const keyboardShortcutsEnabled = chromeEnabled || pathname.startsWith("/settings");

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    isMobile: isCompactLayout,
    isWorkspaceFocusModeEnabled,
    toggleAgentList,
    toggleBothSidebars: toggleDesktopSidebars,
    exitFocusMode,
    cycleTheme,
  });

  useActiveWorktreeNewAction();
  useGlobalNewWorkspaceAction();

  const appContentMinimumWidth = resolveDesktopAppContentMinimum({
    isSettingsRoute: pathname.includes("/settings"),
    isWorkspaceExplorerOpen: isWorkspaceRoute && isDesktopFileExplorerOpen,
    requestedExplorerWidth: explorerWidth,
    viewportWidth,
  });
  const desktopSidebarMounted = hasMountedDesktopSidebar && !isWorkspaceFocusModeEnabled;
  const desktopSidebarVisible = resolveDesktopSidebarVisibility({
    chromeEnabled: sidebarEnabled,
    isCompactLayout,
    isMounted: desktopSidebarMounted,
    isOpen: isDesktopAgentListOpen,
    canShare:
      gumloopShell ||
      canDesktopAppSidebarShare({
        contentMinimumWidth: appContentMinimumWidth,
        requestedSidebarWidth: sidebarWidth,
        viewportWidth,
      }),
  });
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  const appChromeLayout = useMemo(
    () =>
      resolveDesktopAppChromeLayout({
        desktopSidebarRendered: desktopSidebarVisible,
        hasTopLeftWindowControls,
        sidebarControlsEnabled: chromeEnabled && !isWorkspaceFocusModeEnabled,
      }),
    [desktopSidebarVisible, hasTopLeftWindowControls, chromeEnabled, isWorkspaceFocusModeEnabled],
  );
  const sidebarChrome = useMemo(
    () => (
      <SidebarChrome
        mounted={isCompactLayout ? sidebarEnabled : desktopSidebarMounted}
        visible={isCompactLayout ? sidebarEnabled : desktopSidebarVisible}
        keyboardShortcutsEnabled={keyboardShortcutsEnabled}
      />
    ),
    [
      isCompactLayout,
      sidebarEnabled,
      desktopSidebarMounted,
      desktopSidebarVisible,
      keyboardShortcutsEnabled,
    ],
  );
  const workspaceChrome = useMemo(
    () => (
      <AppWorkspaceChrome
        isCompactLayout={isCompactLayout}
        onForge={onForge}
        sidebarChrome={sidebarChrome}
        chromeEnabled={chromeEnabled}
        layout={appChromeLayout}
      >
        {children}
      </AppWorkspaceChrome>
    ),
    [isCompactLayout, onForge, sidebarChrome, chromeEnabled, appChromeLayout, children],
  );

  const overlays = (
    <>
      <FloatingPanelPortalHost />
      <WindowLayoutActionsHost />
      <PortalHost name={GUMLOOP_INSPECTOR_HOST} />
      {isCompactLayout ? sidebarChrome : null}
      <DownloadToast />
      <RosettaCalloutSource />
      <WorktreeSetupCalloutSource />
      <CommandCenterRootActions />
      <CommandCenterWorkspaceActions />
      <PluginCommandCenterActions />
      <WorkspacePinShortcutHandler />
      <WorkspaceArchiveUndoShortcutHost />
      <ArchiveCaptureLessonsHost />
      <CommandCenter />
      <AddProjectFlowHost />
      <PairDeviceRequestAutoOpener />
      <GlobalPairDeviceModal />
      <HostChooserModal />
      <ProviderSettingsHost />
      <WorkspaceSetupDialog />
      <KeyboardShortcutsDialog />
      <AppDiagnosticHost />
      <ConnectionLogHost />
      <ChangelogHost />
      <QuittingOverlay />
    </>
  );

  const compactHeader = useMemo(
    () => <GumloopCompactHeader enabled={sidebarEnabled} />,
    [sidebarEnabled],
  );
  const renderChrome = useCallback(
    (inset: number) => (
      <StreamTopOverlayProvider value={inset}>{workspaceChrome}</StreamTopOverlayProvider>
    ),
    [workspaceChrome],
  );
  const surface = (
    <View style={layoutStyles.surfaceFill}>
      <FloatingHeaderLayout
        header={compactHeader}
        floating={gumloopTheme && isCompactLayout && isWorkspaceRoute && supportsStreamTopOverlay}
      >
        {renderChrome}
      </FloatingHeaderLayout>
      <WindowSidebarToggleSlot
        visible={
          !isCompactLayout &&
          (gumloopShell ? !isDesktopAgentListOpen : appChromeLayout.sidebarToggleOwner === "window")
        }
      />
      {overlays}
    </View>
  );

  const content = isCompactLayout ? (
    <MobileGestureWrapper chromeEnabled={sidebarEnabled}>{surface}</MobileGestureWrapper>
  ) : (
    surface
  );

  return (
    <CommandCenterProvider>
      <WorkspaceLayoutModePublisher />
      <WorkspaceArchiveShortcutHandler />
      {content}
    </CommandCenterProvider>
  );
}

interface AppWorkspaceChromeProps {
  isCompactLayout: boolean;
  onForge: boolean;
  sidebarChrome: ReactNode;
  chromeEnabled: boolean;
  layout: ReturnType<typeof resolveDesktopAppChromeLayout>;
  children: ReactNode;
}
function AppWorkspaceChrome({
  isCompactLayout,
  onForge,
  sidebarChrome,
  chromeEnabled,
  layout,
  children,
}: AppWorkspaceChromeProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const divisionLayout = resolveDesktopDivisionLayout({
    geometry: useWindowLayout(),
    windowWidth: width,
    windowHeight: height,
    leftInset: insets.left,
    rightInset: insets.right,
  });
  return (
    <WindowLayoutSurface compact={isCompactLayout} style={rowStyle}>
      {!isCompactLayout && !onForge ? (
        <WindowChromeRegion corners={layout.sidebarCorners}>{sidebarChrome}</WindowChromeRegion>
      ) : null}
      <WindowLayoutDivisionGap
        layout={divisionLayout}
        sidebarVisible={layout.sidebarToggleOwner !== "window"}
        compact={isCompactLayout}
      />
      {isCompactLayout ? (
        <CompactExplorerSidebarHost enabled={chromeEnabled}>
          <WindowChromeRegion corners={chromeEnabled ? "both" : layout.contentCorners}>
            <View style={flexStyle}>{children}</View>
          </WindowChromeRegion>
        </CompactExplorerSidebarHost>
      ) : (
        // With the wide rail hidden on Forge, the content sits against the left
        // window edge, so it must own both corners to keep the window rounded.
        <WindowChromeRegion corners={onForge ? "both" : layout.contentCorners}>
          <View style={flexStyle}>{children}</View>
        </WindowChromeRegion>
      )}
    </WindowLayoutSurface>
  );
}

/** The floating sidebar toggle beside the macOS traffic lights (classic shell only). */
function WindowSidebarToggleSlot({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <WindowChromeRegion corners="top-left">
      <WindowChromeSafeArea
        placement="inline"
        horizontalPadding={WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING}
        pointerEvents="box-none"
        style={layoutStyles.windowSidebarToggle}
      >
        <WindowSidebarMenuToggle />
      </WindowChromeSafeArea>
    </WindowChromeRegion>
  );
}

function SidebarChrome({
  mounted,
  visible,
  keyboardShortcutsEnabled,
}: {
  mounted: boolean;
  visible: boolean;
  keyboardShortcutsEnabled: boolean;
}) {
  const isCompactLayout = useIsCompactFormFactor();
  const gumloopShell = useGumloopDesktopShell(true);
  const gumloopTheme = useIsGumloopTheme();
  const isOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: isCompactLayout }),
  );
  const presentation = useSettingsSidebarPresentation({
    presentation: isCompactLayout ? "overlay" : "dock",
    visible,
  });
  const active = presentation.visible && isOpen;
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  return (
    <SidebarModelProvider
      active={active}
      keyboardNavigationActive={keyboardShortcutsEnabled && hardwareKeyboardPresent}
    >
      {mounted && gumloopTheme && isCompactLayout ? (
        <GumloopDrawer active={active} presentationEnabled={presentation.visible} />
      ) : null}
      {mounted && gumloopShell ? <GumloopSidebar active={active} /> : null}
      {mounted && !gumloopTheme ? <LeftSidebar active={active} /> : null}
      <WorkspaceShortcutTargetsSubscriber enabled={keyboardShortcutsEnabled} />
    </SidebarModelProvider>
  );
}

function MobileGestureWrapper({
  children,
  chromeEnabled,
}: {
  children: ReactNode;
  chromeEnabled: boolean;
}) {
  const openGesture = useOpenAgentListGesture(chromeEnabled);

  return (
    <GestureDetector gesture={openGesture} touchAction={MOBILE_WEB_GESTURE_TOUCH_ACTION}>
      <View collapsable={false} style={layoutStyles.surfaceFill}>
        {children}
      </View>
    </GestureDetector>
  );
}

// PortalProvider must stay inside normal app-wide context providers.
// `@gorhom/portal` renders portaled children at the host's location in the
// tree, so any context a portaled sheet might consume (QueryClient, theme,
// auth, settings, ...) must wrap PortalProvider, not be wrapped by it.
// BottomSheetModalProvider is the exception: Gorhom modals consume portal
// context and need one shared provider for sibling sheets to stack.
function ProvidersWrapper({ children }: { children: ReactNode }) {
  const { settings, isLoading: settingsLoading } = useAppSettings();

  const colorScheme = useColorScheme();
  const systemScheme = colorScheme === "unspecified" ? null : colorScheme;
  const pluginThemeOptions = usePluginThemeCatalog();

  // Apply the theme, then the font / size / syntax settings over every registered theme key.
  // One effect, in this order: a plugin theme replaces its whole slot, so the appearance patch
  // has to land after it.
  useEffect(() => {
    if (settingsLoading) return;
    const target = resolveThemeTarget({
      preference: settings.theme,
      pluginThemeId: settings.pluginThemeId,
      pluginOptions: pluginThemeOptions,
      systemScheme,
    });
    if (target.kind === "adaptive") {
      UnistylesRuntime.setAdaptiveThemes(true);
    } else {
      if (target.kind === "plugin") UnistylesRuntime.updateTheme(target.key, () => target.theme);
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(target.key);
    }
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiFontSize: settings.uiFontSize,
      codeFontSize: settings.codeFontSize,
      syntaxTheme: settings.syntaxTheme,
      contentMaxWidth: resolveContentMaxWidth({ contentWidth: settings.contentWidth }),
    });
  }, [
    settingsLoading,
    settings.theme,
    settings.pluginThemeId,
    pluginThemeOptions,
    systemScheme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiFontSize,
    settings.codeFontSize,
    settings.syntaxTheme,
    settings.contentWidth,
  ]);

  return (
    <VoiceProvider>
      <PortalProvider>
        <BottomSheetModalProvider>
          <AppearanceSystemBars />
          <DesktopWindowControlsSync enabled={!settingsLoading} />
          <OfferLinkListener />
          <HostConfirmationSheet />
          <HostSessionManager />
          <ConnectionNotifications />
          <FaviconStatusSync />
          {children}
        </BottomSheetModalProvider>
      </PortalProvider>
    </VoiceProvider>
  );
}

function DesktopWindowControlsSync({ enabled }: { enabled: boolean }) {
  const { theme } = useUnistyles();
  const surface0 = theme.colors.surface0;
  const foreground = theme.colors.foreground;
  const pathname = usePathname();
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const liftTrafficLights =
    getIsElectronRuntimeMac() &&
    isFocusModeEnabled &&
    parseHostWorkspaceRouteFromPathname(pathname) !== null;
  const gumloopShell = useGumloopDesktopShell(true);

  useEffect(() => {
    if (!enabled || isNative) return;
    void updateDesktopWindowControls({
      backgroundColor: surface0,
      foregroundColor: foreground,
      trafficLightOffsetY: resolveTrafficLightOffsetY({ gumloopShell, liftTrafficLights }),
    }).catch((error) => {
      console.warn("[DesktopWindow] Failed to update window controls overlay", error);
    });
  }, [enabled, surface0, foreground, liftTrafficLights, gumloopShell]);

  return null;
}

/**
 * Offer links this app already opened. `getInitialURL` returns the launch URL
 * for the life of the process, and iOS can deliver a link both as the launch
 * URL and as a `url` event; each extra push opened a second pairing exchange
 * for the same link, which the host refuses.
 */
const openedOfferLinks = new Set<string>();

function OfferLinkListener() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const handleUrl = (url: string | null) => {
      if (!url) return;
      if (!url.includes("#offer=") && !url.startsWith("jagentdesk://pair#")) return;
      if (cancelled || openedOfferLinks.has(url)) return;
      openedOfferLinks.add(url);
      router.push(`/pair-verify?offer=${encodeURIComponent(url)}` as Href);
    };

    void Linking.getInitialURL()
      .then(handleUrl)
      .catch(() => undefined);

    const subscription = Linking.addEventListener("url", (event) => {
      handleUrl(event.url);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [router]);

  return null;
}

interface OpenProjectEventPayload {
  path?: unknown;
}

interface PendingOpenProjectRequest {
  id: number;
  serverId: string;
  path: string;
}

let nextOpenProjectRequestId = 1;

function OpenProjectListener() {
  const chooseHost = useHostChooser();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const [request, setRequest] = useState<PendingOpenProjectRequest | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const openProject = useOpenProject(request?.serverId ?? null);

  const openPathOnChosenHost = useCallback(
    (path: string) => {
      const nextPath = path.trim();
      if (!nextPath) {
        return;
      }

      if (!hostRegistryLoaded) {
        setPendingPath(nextPath);
        return;
      }

      chooseHost({
        title: "Choose host",
        onChooseHost: (serverId) => {
          setRequest({
            id: nextOpenProjectRequestId++,
            serverId,
            path: nextPath,
          });
        },
      });
    },
    [chooseHost, hostRegistryLoaded],
  );

  useEffect(() => {
    if (!hostRegistryLoaded || !pendingPath) {
      return;
    }
    const nextPath = pendingPath;
    setPendingPath(null);
    openPathOnChosenHost(nextPath);
  }, [hostRegistryLoaded, openPathOnChosenHost, pendingPath]);

  useEffect(() => {
    if (!request) {
      return;
    }
    let cancelled = false;
    void openProject(request.path).then((result) => {
      if (cancelled) {
        return null;
      }

      if (!result.ok) {
        setRequest((current) => (current?.id === request.id ? null : current));
        return null;
      }

      setRequest((current) => (current?.id === request.id ? null : current));
      return null;
    });
    return () => {
      cancelled = true;
    };
  }, [openProject, request]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getDesktopHost()
      ?.getPendingOpenProject?.()
      ?.then((pending) => {
        if (!disposed && pending) {
          openPathOnChosenHost(pending);
        }
        return;
      })
      .catch(() => undefined);

    // Listen for hot-start paths forwarded via the second-instance event.
    void listenToDesktopEvent<OpenProjectEventPayload>("open-project", (payload) => {
      if (disposed) {
        return;
      }
      const nextPath = typeof payload?.path === "string" ? payload.path.trim() : "";
      openPathOnChosenHost(nextPath);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        return;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPathOnChosenHost]);

  return null;
}

// Detects when a host that was a prior migration source comes back online and
// offers to migrate its data back (reverse migration). See host-migration-service.
function ReverseMigrationListener() {
  useEffect(() => {
    const store = getHostRuntimeStore();
    const handler = createSourceHostReconnectHandler({
      hostRuntime: store,
      confirm: ({ agentCount, sourceHostLabel }) =>
        new Promise<boolean>((resolve) => {
          const label = sourceHostLabel ?? "the original host";
          Alert.alert(
            "Move data back?",
            `${label} is back online. Move ${agentCount} migrated ${
              agentCount === 1 ? "agent" : "agents"
            } back to it?`,
            [
              { text: "Not now", style: "cancel", onPress: () => resolve(false) },
              { text: "Move back", onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          );
        }),
      onError: (error, context) => {
        console.error("[ReverseMigration] failed", {
          sourceServerId: context.sourceServerId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    return store.subscribeSourceHostReconnect(handler);
  }, []);

  return null;
}

function AppWithSidebar({ children }: { children: ReactNode }) {
  useSettingsRouteEntry();
  const pathname = usePathname();
  const hosts = useHosts();
  const storeReady = useStoreReady();
  const routeServerId = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  const routeHasKnownHost =
    routeServerId !== null && hosts.some((host) => host.serverId === routeServerId);
  const shouldShowAppChrome =
    storeReady &&
    (pathname === "/open-project" ||
      pathname === "/new" ||
      pathname === "/sessions" ||
      pathname === "/schedules" ||
      pathname === "/shared-sessions" ||
      routeHasKnownHost);

  return (
    <UsageSidebarRoot>
      <AppContainer chromeEnabled={shouldShowAppChrome}>{children}</AppContainer>
    </UsageSidebarRoot>
  );
}

function FaviconStatusSync() {
  useFaviconStatus();
  return null;
}

const ROOT_STACK_SCREEN_OPTIONS = {
  headerShown: false,
  animation: "none" as const,
};

function isPairingRoute(pathname: string): boolean {
  return (
    pathname === "/pair-start" ||
    pathname === "/pair-scan" ||
    pathname === "/pair-link" ||
    pathname === "/pair-verify"
  );
}

function RootStack() {
  const storeReady = useStoreReady();
  const { mode: tailnetMode } = useTailnetMode();
  return (
    <ThemedStack screenOptions={ROOT_STACK_SCREEN_OPTIONS}>
      <Stack.Screen name="index" />
      {/* Session-share guest mode (ADR-0019): reachable without pairing/host — it registers its
          own scoped guest runtime from the served hint. */}
      <Stack.Screen name="share" />
      <Stack.Screen name="pair-start" />
      {/* The gate route stays outside Stack.Protected so it remains reachable
          while the background Tailscale health check is in progress. */}
      <Stack.Screen name="tailscale-login" />
      {/* Pairing is intentionally reachable before Tailscale login. The offer
          is stored locally, then the tailnet is joined, and only then does the
          app open the daemon connection for the six-digit proof. */}
      <Stack.Screen name="pair-scan" />
      <Stack.Screen name="pair-link" />
      <Stack.Screen name="pair-verify" />
      {/* A phone reaches the main screens once it has paired (which records a
          tailnet mode); the desktop and the browser never wait for onboarding. */}
      <Stack.Protected guard={storeReady && (!isNative || tailnetMode !== null)}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/[section]" />
        <Stack.Screen name="settings/hosts/index" />
        <Stack.Screen name="new" />
        <Stack.Screen name="open-project" />
        <Stack.Screen name="sessions" />
        <Stack.Screen name="schedules" />
        <Stack.Screen name="shared-sessions" />
      </Stack.Protected>
      <Stack.Screen name="h/[serverId]" />
      <Stack.Screen name="settings/device-hosts/[serverId]" />
      <Stack.Screen name="settings/hosts/[serverId]/index" />
      <Stack.Screen name="settings/hosts/[serverId]/[hostSection]" />
      <Stack.Screen name="settings/hosts/[serverId]/projects/index" />
      <Stack.Screen name="settings/hosts/[serverId]/projects/[projectId]" />
    </ThemedStack>
  );
}

function WorkspaceRouteNavigationBridge() {
  const navigationRef = useNavigationContainerRef();

  useEffect(() => {
    return registerWorkspaceRouteNavigationRef(navigationRef);
  }, [navigationRef]);

  return null;
}

function AppShell() {
  return (
    <MobilePanelsProvider>
      <HorizontalScrollProvider>
        <OpenProjectListener />
        <ReverseMigrationListener />
        <AgentNavigationListener />
        <AppWithSidebar>
          <WorkspaceRouteNavigationBridge />
          <RootStack />
        </AppWithSidebar>
      </HorizontalScrollProvider>
    </MobilePanelsProvider>
  );
}

function RuntimeProviders({ children }: { children: ReactNode }) {
  return (
    <HostRuntimeBootstrapProvider>
      <PushNotificationRouter />
      <SidebarCalloutProvider>
        <ToastProvider>
          <TailscaleHealthMonitor />
          <ProvidersWrapper>{children}</ProvidersWrapper>
        </ToastProvider>
      </SidebarCalloutProvider>
    </HostRuntimeBootstrapProvider>
  );
}

function TailscaleHealthMonitor() {
  const { mode } = useTailnetMode();
  const pathname = usePathname();
  // The desktop always has its Local host to keep connected; a phone starts
  // once pairing recorded a mode.
  const active = mode !== null || shouldUseDesktopDaemon();

  useEffect(() => {
    if (!active || pathname === "/tailscale-login" || isPairingRoute(pathname)) {
      return;
    }

    const reconnectPass = () => {
      const store = getHostRuntimeStore();
      void store.runProbeCycleNow();
      store.ensureConnectedAll();
      // ensureConnectedAll no-ops on a "connected" zombie socket left behind by
      // OS suspension; force a liveness check that reconnects if the link is dead.
      store.revalidateConnectedAll();
    };

    // Mount: the process just launched, so its sockets cannot have been
    // reclaimed while suspended — connect without the revive step.
    reconnectPass();
    const timer = setInterval(() => void refreshTailscaleStatus(), 5000);
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        return;
      }
      void refreshTailscaleStatus();
      // Spec 05.7.4: revive the native tsnet layer first — iOS may have
      // reclaimed the loopback listener and the tsnet sockets while the app
      // was suspended — then run the normal reconnect pass. A revived host
      // whose loopback port changed has its client rebuilt inside the revive
      // step; the backoff resets through the reconnect pass below.
      void reviveTailnetHosts(getHostRuntimeStore()).then(reconnectPass);
    });
    return () => {
      clearInterval(timer);
      appStateSubscription.remove();
    };
  }, [active, pathname]);

  return null;
}

function RootProviders({ children }: { children: ReactNode }) {
  return (
    <WindowLayoutProvider>
      <WindowChromeProvider>
        <KeyboardProvider>
          <KeyboardShiftProvider>{children}</KeyboardShiftProvider>
        </KeyboardProvider>
      </WindowChromeProvider>
    </WindowLayoutProvider>
  );
}

function RootAppTree() {
  return (
    <GestureHandlerRootView style={flexStyle}>
      <View style={layoutStyles.surfaceFill}>
        <RootProviders>
          <RuntimeProviders>
            <AppShell />
          </RuntimeProviders>
        </RootProviders>
      </View>
    </GestureHandlerRootView>
  );
}

export default function RootLayout() {
  useEffect(() => installWebScrollbarStyles(), []);
  useEffect(() => installWebPlaceholderStyles(), []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        void flushDraftPersistStorage();
      }
    });
    return () => subscription.remove();
  }, []);

  return <RootAppTree />;
}

const layoutStyles = StyleSheet.create((theme) => ({
  surfaceFill: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  gumloopCanvas: {
    flex: 1,
    backgroundColor: theme.chrome.canvas,
  },
  gumloopPanel: {
    flex: 1,
    borderColor: theme.chrome.panelBorder,
    marginLeft: theme.spacing[2],
    marginRight: theme.spacing[2],
    marginBottom: theme.spacing[2],
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  windowSidebarToggle: {
    position: "absolute",
    top: 1,
    left: 0,
    zIndex: 20,
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
}));
