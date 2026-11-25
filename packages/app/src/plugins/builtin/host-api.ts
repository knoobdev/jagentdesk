/** Public core UI and service surface for statically linked built-in clients. */
export { PageHeader } from "@/components/headers/page-header";
export { gumloopListStyles, gumloopTabStyles } from "@/components/gumloop-shell/list-styles";
export { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
export { useWorkspaceDirectory, useWorkspaceKeys } from "@/stores/session-store-hooks";
export { getDesktopHost } from "@/desktop/host";
export { useIsCompactFormFactor } from "@/constants/layout";
export { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
export { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
export { TerminalPane } from "@/components/terminal-pane";
export { withSshDocker, type SshDockerTarget } from "@/ssh/ui/ssh-docker-client";
export type { Theme } from "@/styles/theme";
export { GumloopRow } from "@/components/gumloop-shell/row";
export type {
  BuiltinClientHost,
  BuiltinClientProps,
  BuiltinDestination,
  BuiltinLeftPanelOptions,
} from "./host";

export * as Clipboard from "expo-clipboard";
export { useSafeAreaInsets } from "react-native-safe-area-context";

export { isWeb } from "@/constants/platform";
export { useClusterNavStore } from "@/stores/cluster-nav-store";
export { useClusterViewStore } from "@/stores/cluster-view-store";
export { createDockWorkspace } from "@/components/dock-workspace";
export { CLUSTER_AGENT_LABEL } from "@/utils/dock-agents";
export { Composer } from "@/composer";
export { useAgentInputDraft } from "@/composer/draft/input-draft";
export { useDraftAgentCreateFlow } from "@/composer/draft/create-flow";
export { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
export { encodeImages } from "@/utils/encode-images";
export { navigateToAgent } from "@/utils/navigate-to-agent";
export { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
export { useSessionStore } from "@/stores/session-store";
export type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
export {
  useClusterChatStore,
  CLUSTER_CHAT_MIN_WIDTH,
  CLUSTER_CHAT_MAX_WIDTH,
} from "@/stores/cluster-chat-store";
export type { ClusterChatPendingAsk } from "@/stores/cluster-chat-store";
export { gumloopChipStyles } from "@/components/gumloop-shell/list-styles";
export { formatTimeAgo } from "@/utils/time";
export { AgentConversationPanel } from "@/panels/agent-panel";
export {
  PaneProvider,
  PaneFocusProvider,
  createPaneFocusContextValue,
} from "@/panels/pane-context";
export type { PaneContextValue } from "@/panels/pane-context";
export { dispatchComposerAgentMessage } from "@/composer/actions";
export { createMessageSubmissionWriter } from "@/composer/submission/writer";
export { prepareTurnSkills } from "@/skills/turn-skills";
export { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
export { AdaptiveTextInput, AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
export { HighlightedLines } from "@/components/highlighted-content";
export { highlightToKeyedLines } from "@/utils/highlight-cache";
export { default as TerminalEmulator } from "@/components/terminal-emulator";
export type { TerminalEmulatorHandle } from "@/components/terminal-emulator";
export { KindIcon } from "@/components/cluster-kind-icon";
export { usePanelStore } from "@/stores/panel-store";
export { buildClustersRoute, buildClusterWorkloadsRoute } from "@/utils/host-routes";
export { LoadingSpinner } from "@/components/ui/loading-spinner";
export { DATABASE_AGENT_LABEL } from "@/utils/dock-agents";
export { isNative } from "@/constants/platform";
export {
  useDatabaseChatStore,
  DATABASE_CHAT_MIN_WIDTH,
  DATABASE_CHAT_MAX_WIDTH,
} from "@/stores/database-chat-store";
export { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
export { buildDatabasesRoute, buildDatabaseBrowseRoute } from "@/utils/host-routes";
export { BackHeader } from "@/components/headers/back-header";
export { Button } from "@/components/ui/button";
// App-local dependencies: features outside packages/app resolve them through the host.
export {
  router,
  useRouter,
  useLocalSearchParams,
  useGlobalSearchParams,
  usePathname,
} from "expo-router";
export { Gesture, GestureDetector } from "react-native-gesture-handler";
