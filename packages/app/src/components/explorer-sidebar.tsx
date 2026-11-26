import { LedgerPane } from "@/continuity/ledger-pane";
import { useHostFeature } from "@/runtime/host-features";
import { Portal } from "@gorhom/portal";
import { GUMLOOP_INSPECTOR_HOST } from "@/components/gumloop-shell/sidebar-state";
import {
  useGumloopDesktopShell,
  useIsGumloopTheme,
} from "@/components/gumloop-shell/use-gumloop-chrome";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  useWindowDimensions,
  StyleSheet as RNStyleSheet,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, runOnJS } from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  formatPrTabLabel,
  PullRequestPane,
  PullRequestPaneError,
  PullRequestPaneSkeleton,
  PullRequestTabIcon,
  usePrPaneData,
} from "@/git/pull-request-panel";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import type { UsePrPaneDataResult } from "@/git/pull-request-panel/use-data";
import { usePanelStore, selectIsFileExplorerOpen, type ExplorerTab } from "@/stores/panel-store";
import { useToast } from "@/contexts/toast-context";
import { useCloseFileExplorerGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { GitDiffPane } from "@/git/diff-pane";
import { FileExplorerPane } from "./file-explorer-pane";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { useHasOwnedWindowChromeObstruction, WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { resolveDesktopExplorerWidth } from "@/components/desktop-sidebar-layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import { useDraftStore } from "@/stores/draft-store";

function logExplorerSidebar(_event: string, _details: Record<string, unknown>): void {}

interface ExplorerSidebarProps {
  children?: ReactNode;
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  onOpenFile?: (filePath: string) => void;
}

interface ExplorerSidebarSharedState {
  explorerTab: ExplorerTab;
  handleTabPress: (tab: ExplorerTab) => void;
}

function useExplorerSidebarSharedState({
  serverId,
  workspaceRoot,
  isGit,
}: Pick<ExplorerSidebarProps, "serverId" | "workspaceRoot" | "isGit">): ExplorerSidebarSharedState {
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const handleTabPress = useCallback(
    (tab: ExplorerTab) => {
      setExplorerTabForCheckout({ serverId, cwd: workspaceRoot, isGit, tab });
    },
    [isGit, serverId, setExplorerTabForCheckout, workspaceRoot],
  );

  return { explorerTab, handleTabPress };
}

export function CompactExplorerSidebar({
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
}: ExplorerSidebarProps) {
  const gumloop = useIsGumloopTheme();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: true }));
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const { style: mobileKeyboardInsetStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: true,
  });
  const { gesture: closeGesture } = useCloseFileExplorerGesture();

  const handleClose = useCallback(
    (reason: string) => {
      logExplorerSidebar("handleClose", {
        reason,
        isOpen,
      });
      showMobileAgent();
    },
    [isOpen, showMobileAgent],
  );

  const handleHeaderClose = useCallback(() => handleClose("header-close-button"), [handleClose]);

  const mobileSidebarStyle = useMemo(
    () => [
      {
        paddingTop: insets.top,
        backgroundColor: theme.colors.surfaceSidebar,
      },
      mobileKeyboardInsetStyle,
    ],
    [insets.top, theme.colors.surfaceSidebar, mobileKeyboardInsetStyle],
  );

  const overlay = (
    <RetainedPanelActivity active={isOpen}>
      <MobilePanelOverlay
        panel="file-explorer"
        closeGesture={closeGesture}
        panelStyle={mobileSidebarStyle}
      >
        <ExplorerSidebarContent
          activeTab={explorerTab}
          onTabPress={handleTabPress}
          onClose={handleHeaderClose}
          serverId={serverId}
          workspaceId={workspaceId}
          workspaceRoot={workspaceRoot}
          isGit={isGit}
          isOpen={isOpen}
          onOpenFile={onOpenFile}
        />
      </MobilePanelOverlay>
    </RetainedPanelActivity>
  );
  return gumloop ? <Portal hostName={GUMLOOP_INSPECTOR_HOST}>{overlay}</Portal> : overlay;
}

export function ExplorerSidebar({
  children,
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  onOpenFile,
}: ExplorerSidebarProps) {
  const insets = useSafeAreaInsets();
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const isOpen = usePanelStore((state) => selectIsFileExplorerOpen(state, { isCompact: false }));
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const { explorerTab, handleTabPress } = useExplorerSidebarSharedState({
    serverId,
    workspaceRoot,
    isGit,
  });
  const { width: viewportWidth } = useWindowDimensions();
  const gumloop = useGumloopDesktopShell(true);
  const sheetInspector = gumloop && viewportWidth < 992;
  const visibleExplorerWidth = useMemo(() => {
    if (sheetInspector) return viewportWidth;
    if (gumloop) return 525;
    return resolveDesktopExplorerWidth({ requestedWidth: explorerWidth, viewportWidth });
  }, [sheetInspector, gumloop, explorerWidth, viewportWidth]);
  const startWidthRef = useRef(visibleExplorerWidth);
  const resizeWidth = useSharedValue(visibleExplorerWidth);

  useEffect(() => {
    resizeWidth.value = visibleExplorerWidth;
  }, [resizeWidth, visibleExplorerWidth]);

  const handleDesktopClose = useCallback(() => {
    logExplorerSidebar("handleClose", {
      reason: "desktop-close-button",
      isOpen,
    });
    closeDesktopFileExplorer();
  }, [closeDesktopFileExplorer, isOpen]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(true)
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = visibleExplorerWidth;
          resizeWidth.value = visibleExplorerWidth;
        })
        .onUpdate((event) => {
          const newWidth = startWidthRef.current - event.translationX;
          resizeWidth.value = resolveDesktopExplorerWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setExplorerWidth)(resizeWidth.value);
        }),
    [resizeWidth, setExplorerWidth, viewportWidth, visibleExplorerWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));
  const desktopSidebarStyle = useMemo(
    () => [
      explorerStaticStyles.desktopSidebar,
      resizeAnimatedStyle,
      sheetInspector && explorerStaticStyles.fullscreen,
      { paddingTop: insets.top },
    ],
    [resizeAnimatedStyle, insets.top, sheetInspector],
  );

  const content = (
    <RetainedPanelActivity active={isOpen}>
      <Animated.View style={isOpen ? desktopSidebarStyle : styles.hiddenSidebar}>
        <View style={[styles.desktopSidebarBorder, { flex: 1 }]}>
          {gumloop ? null : (
            <SidebarResizeHandle
              edge="left"
              gesture={resizeGesture}
              testID="explorer-sidebar-resize-handle"
            />
          )}

          {children ?? (
            <ExplorerSidebarContent
              activeTab={explorerTab}
              onTabPress={handleTabPress}
              onClose={handleDesktopClose}
              serverId={serverId}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              isGit={isGit}
              isOpen={isOpen}
              onOpenFile={onOpenFile}
            />
          )}
        </View>
      </Animated.View>
    </RetainedPanelActivity>
  );
  return sheetInspector ? <Portal hostName={GUMLOOP_INSPECTOR_HOST}>{content}</Portal> : content;
}

interface ExplorerTabButtonProps {
  tab: ExplorerTab;
  active: boolean;
  label?: string;
  onTabPress: (tab: ExplorerTab) => void;
  testID: string;
  children?: React.ReactNode;
}

function ExplorerTabButton({
  tab,
  active,
  label,
  onTabPress,
  testID,
  children,
}: ExplorerTabButtonProps) {
  const handlePress = useCallback(() => onTabPress(tab), [onTabPress, tab]);
  const gumloop = useIsGumloopTheme();
  const tabStyle = useMemo(
    () => [
      styles.tab,
      active && styles.tabActive,
      gumloop && styles.gumloopTab,
      gumloop && active && styles.gumloopTabActive,
    ],
    [active, gumloop],
  );
  const tabTextStyle = useMemo(
    () => [styles.tabText, gumloop && styles.gumloopTabText, active && styles.tabTextActive],
    [active, gumloop],
  );
  return (
    <Pressable testID={testID} style={tabStyle} onPress={handlePress}>
      {children}
      {label !== undefined ? <Text style={tabTextStyle}>{label}</Text> : null}
    </Pressable>
  );
}

function resolveVisibleExplorerTab(input: {
  requestedTab: ExplorerTab;
  showPrTab: boolean;
  ledgerSupported: boolean;
  isGit: boolean;
}): ExplorerTab {
  if (input.requestedTab === "pr" && !input.showPrTab) return "changes";
  if (input.requestedTab === "ledger" && !input.ledgerSupported) {
    return input.isGit ? "changes" : "files";
  }
  return input.requestedTab;
}

interface SidebarContentProps {
  activeTab: ExplorerTab;
  onTabPress: (tab: ExplorerTab) => void;
  onClose: () => void;
  serverId: string;
  workspaceId?: string | null;
  workspaceRoot: string;
  isGit: boolean;
  isOpen: boolean;
  onOpenFile?: (filePath: string) => void;
}

function ExplorerSidebarContent({
  activeTab,
  onTabPress,
  onClose,
  serverId,
  workspaceId,
  workspaceRoot,
  isGit,
  isOpen,
  onOpenFile,
}: SidebarContentProps) {
  const gumloop = useIsGumloopTheme();
  const headerStyle = useMemo(() => [styles.header, gumloop && styles.gumloopHeader], [gumloop]);
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const toast = useToast();
  const hasRightWindowControls = useHasOwnedWindowChromeObstruction("top-right");
  const canQueryPullRequest = isGit && Boolean(workspaceRoot);
  const prPane = usePrPaneData({
    serverId,
    cwd: workspaceRoot,
    enabled: canQueryPullRequest && isOpen,
    timelineEnabled: activeTab === "pr" && canQueryPullRequest && isOpen,
  });
  const hasPullRequest = prPane.prNumber !== null;
  const showPrTab = hasPullRequest || (activeTab === "pr" && prPane.isLoading);
  const requestedTab: ExplorerTab =
    !isGit && (activeTab === "changes" || activeTab === "pr") ? "files" : activeTab;
  const ledgerSupported = useHostFeature(serverId, "crossProviderContinuity");
  const resolvedTab = resolveVisibleExplorerTab({
    requestedTab,
    showPrTab,
    ledgerSupported,
    isGit,
  });
  const prTabLabel = formatPrTabLabel(prPane.prNumber);
  const refreshGitActions = useCheckoutGitActionsStore((s) => s.refresh);
  const handlePrRetry = useCallback(() => {
    refreshGitActions({ serverId, cwd: workspaceRoot }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("workspace.git.diff.failedRefresh"));
    });
  }, [refreshGitActions, serverId, t, toast, workspaceRoot]);
  const workspaceAttachmentScopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd: workspaceRoot }),
    [serverId, workspaceId, workspaceRoot],
  );

  return (
    <View style={styles.sidebarContent} pointerEvents="auto">
      {/* Header with tabs and close button */}
      <WindowChromeSafeArea
        placement="inline"
        horizontalPadding={theme.spacing[2]}
        style={headerStyle}
        testID="explorer-header"
      >
        <TitlebarDragRegion />
        <View style={styles.tabsContainer}>
          {isGit && (
            <ExplorerTabButton
              tab="changes"
              active={resolvedTab === "changes"}
              label={t("workspace.tabs.explorer.changes")}
              onTabPress={onTabPress}
              testID="explorer-tab-changes"
            />
          )}
          <ExplorerTabButton
            tab="files"
            active={resolvedTab === "files"}
            label={t("workspace.tabs.explorer.files")}
            onTabPress={onTabPress}
            testID="explorer-tab-files"
          />
          {ledgerSupported && (
            <ExplorerTabButton
              tab="ledger"
              active={resolvedTab === "ledger"}
              label={t("continuity.ledger.tab")}
              onTabPress={onTabPress}
              testID="explorer-tab-ledger"
            />
          )}
          {isGit && showPrTab && (
            <ExplorerTabButton
              tab="pr"
              active={resolvedTab === "pr"}
              label={prTabLabel}
              onTabPress={onTabPress}
              testID="explorer-tab-pr"
            >
              <PullRequestTabIcon
                forge={prPane.forge}
                size={13}
                color={
                  resolvedTab === "pr" ? theme.colors.foreground : theme.colors.foregroundMuted
                }
              />
            </ExplorerTabButton>
          )}
        </View>
        <View style={styles.headerRightSection}>
          {!hasRightWindowControls && (
            <Pressable
              onPress={onClose}
              style={styles.closeButton}
              testID="explorer-close"
              nativeID="explorer-close"
              accessible
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.explorer.close")}
              hitSlop={8}
            >
              {({ hovered, pressed }) => (
                <X
                  size={18}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          )}
        </View>
      </WindowChromeSafeArea>

      {/* Content based on active tab */}
      <View style={styles.contentArea} testID="explorer-content-area">
        {resolvedTab === "changes" && (
          <ChangedFilesPane
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={workspaceRoot}
            isOpen={isOpen}
            onOpenFile={onOpenFile}
          />
        )}
        {resolvedTab === "files" && (
          <FilesPane
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={workspaceRoot}
            onOpenFile={onOpenFile}
          />
        )}
        {resolvedTab === "ledger" && <LedgerPane serverId={serverId} />}
        {resolvedTab === "pr" && (
          <PrTabContent
            serverId={serverId}
            cwd={workspaceRoot}
            prPane={prPane}
            workspaceAttachmentScopeKey={workspaceAttachmentScopeKey}
            onRetry={handlePrRetry}
          />
        )}
      </View>
    </View>
  );
}

/**
 * Shared add-to-chat state for the changes/files panes: both expose an "add file
 * to chat" action that attaches the file to the focused chat's composer.
 * Available only when a workspace with a focused chat is available.
 */
function useAddFileToChat({
  serverId,
  workspaceId,
}: Pick<SidebarContentProps, "serverId" | "workspaceId">) {
  const workspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? state.layoutByWorkspace[workspaceKey] : undefined,
  );
  const focusTab = useWorkspaceLayoutStore((state) => state.focusTab);
  const focusedChat = useMemo(
    () => resolveFocusedChatTarget({ serverId, layout }),
    [serverId, layout],
  );
  const addFile = useCallback(
    (filePath: string) => {
      if (!focusedChat || !workspaceKey) {
        return;
      }
      void useDraftStore.getState().attachWorkspaceFile({
        draftKey: focusedChat.draftKey,
        attachment: createWorkspaceFileAttachment({ path: filePath }),
      });
      focusTab(workspaceKey, focusedChat.tabId);
    },
    [focusTab, focusedChat, workspaceKey],
  );
  return { addFile, canAddToChat: focusedChat !== null };
}

export function ChangedFilesPane({
  serverId,
  workspaceId,
  workspaceRoot,
  isOpen,
  onOpenFile,
}: Pick<
  SidebarContentProps,
  "serverId" | "workspaceId" | "workspaceRoot" | "isOpen" | "onOpenFile"
>) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  return (
    <GitDiffPane
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={workspaceRoot}
      enabled={isOpen}
      onOpenFile={onOpenFile}
      onAddToChat={canAddToChat ? addFile : undefined}
    />
  );
}

export function FilesPane({
  serverId,
  workspaceId,
  workspaceRoot,
  onOpenFile,
}: Pick<SidebarContentProps, "serverId" | "workspaceId" | "workspaceRoot" | "onOpenFile">) {
  const { addFile, canAddToChat } = useAddFileToChat({ serverId, workspaceId });
  return (
    <FileExplorerPane
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      onOpenFile={onOpenFile}
      onAddToChat={canAddToChat ? addFile : undefined}
    />
  );
}

interface PrTabContentProps {
  serverId: string;
  cwd: string;
  prPane: UsePrPaneDataResult;
  workspaceAttachmentScopeKey: string;
  onRetry: () => void;
}

export function PrTabContent({
  serverId,
  cwd,
  prPane,
  workspaceAttachmentScopeKey,
  onRetry,
}: PrTabContentProps) {
  const { t } = useTranslation();
  if (prPane.data) {
    return (
      <PullRequestPane
        serverId={serverId}
        cwd={cwd}
        data={prPane.data}
        activityLoading={prPane.activityLoading}
        workspaceAttachmentScopeKey={workspaceAttachmentScopeKey}
      />
    );
  }
  if (prPane.error) {
    return <PullRequestPaneError onRetry={onRetry} />;
  }
  if (!prPane.isLoading)
    return (
      <View style={styles.prEmpty}>
        <Text style={styles.prEmptyTitle}>{t("panels.pullRequest.emptyTitle")}</Text>
        <Text style={styles.prEmptyDescription}>{t("panels.pullRequest.emptyDescription")}</Text>
      </View>
    );
  return <PullRequestPaneSkeleton />;
}

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const explorerStaticStyles = RNStyleSheet.create({
  fullscreen: { position: "absolute", top: 0, bottom: 0, left: 0 },
  desktopSidebar: {
    position: "relative" as const,
  },
});

const styles = StyleSheet.create((theme) => ({
  hiddenSidebar: { display: "none" },
  prEmpty: { flex: 1, justifyContent: "center", padding: theme.spacing[4], gap: theme.spacing[2] },
  prEmptyTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  prEmptyDescription: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  desktopSidebarBorder: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  gumloopHeader: { height: 64, backgroundColor: theme.colors.surface0 },
  gumloopTab: {
    borderRadius: 0,
    height: 64,
    justifyContent: "center",
    backgroundColor: "transparent",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  gumloopTabActive: { borderBottomColor: theme.colors.foreground },
  gumloopTabText: { fontSize: 16 },
  header: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tabsContainer: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tabText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
  },
  tabTextMuted: {
    opacity: 0.8,
  },
  headerRightSection: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  contentArea: {
    flex: 1,
    minHeight: 0,
  },
}));
