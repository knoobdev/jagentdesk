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
  BuiltinAttachmentPillProps,
  BuiltinClientHost,
  BuiltinClientProps,
  BuiltinDestination,
  BuiltinLeftPanelOptions,
  BuiltinToolCallCardProps,
  BuiltinToolCallRenderer,
} from "./host";

// Packages installed only in packages/app resolve for features through the host API.
export * as Clipboard from "expo-clipboard";
export {
  router,
  useGlobalSearchParams,
  useLocalSearchParams,
  type Href,
} from "expo-router";
export { useIsFocused } from "expo-router/react-navigation";
export { Gesture, GestureDetector } from "react-native-gesture-handler";
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
export type { SheetHeader } from "@/components/adaptive-modal-sheet";
export { Alert } from "@/components/ui/alert";
export { Switch } from "@/components/ui/switch";
export { CompactBackButton } from "@/components/headers/compact-back-button";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuHint,
} from "@/components/ui/dropdown-menu";
export { SegmentedControl } from "@/components/ui/segmented-control";
export type { SegmentedControlOption } from "@/components/ui/segmented-control";
export { confirmDialog } from "@/utils/confirm-dialog";
export {
  buildArgoCdInstanceRoute,
  buildArgoCdAppRoute,
  buildArgoCdRoute,
} from "@/utils/host-routes";
export { DropdownTrigger } from "@/components/ui/dropdown-trigger";
export { useFetchQuery } from "@/data/query";
export { settingsStyles } from "@/styles/settings";
export { DiffViewer } from "@/components/diff-viewer";
export { parseUnifiedDiff } from "@/utils/tool-call-parsers";
export type { DesktopArgoCdBridge } from "@/desktop/host";
export { FormTextInput, Field } from "@/components/ui/form-field";
export { useToast } from "@/contexts/toast-context";
export { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
// App-local dependencies: features outside packages/app resolve them through the host.
export { useRouter, usePathname } from "expo-router";

// ssh-servers migration
export { SelectField } from "@/components/ui/select-field";
export type { SelectFieldOption } from "@/components/ui/select-field";
export { FileEditorModel, getFileConflictCallout } from "@/file-pane/editor/model";
export type {
  FileEditorFile,
  FileEditorObservation,
  FileEditorSession,
  FileObservationSource,
} from "@/file-pane/editor/model";
export { FileConflictAlert } from "@/file-pane/conflict-alert";
export type { FileConflictAlertState } from "@/file-pane/conflict-alert";
export { FileEditorView } from "@/file-pane/editor/view";
export { AdaptiveRenameModal } from "@/components/rename-modal";
export {
  gumloopDarkTheme,
  gumloopLightTheme,
  darkClaudeTheme,
  darkGhosttyTheme,
  darkMidnightTheme,
  darkPureBlackTheme,
  darkTheme,
  darkZincTheme,
  lightTheme,
} from "@/styles/theme";
export type { ThemeName } from "@/styles/theme";
export { StatusBadge } from "@/components/ui/status-badge";
export { useAppSettings } from "@/hooks/use-settings";
export { BuiltinPluginGate } from "@/plugins/builtin/gate";
export { useFileDownload } from "@/hooks/use-file-download";
export { useFilePicker } from "@/hooks/use-file-picker";
export { BuiltinScreen } from "@/plugins/builtin/surfaces";
export { getIsElectronMac } from "@/constants/platform";
export type { TerminalPaneAppearance, TerminalPaneExtraKey } from "@/components/terminal-pane";

// remote-tasks migration
export { CODE_SURFACE_DATASET } from "@/styles/code-surface";
export { nextPinnedState, scrollActionForAppend } from "@/remote-exec/output-scroll";
export {
  RemoteJobCommand,
  RemoteJobDot,
  RemoteJobOutputBox,
  remoteJobDotVariant,
  styles as remoteJobCardStyles,
} from "@/remote-exec/job-card-ui";
export type {
  OutputScrollEvent,
  RemoteJobDotVariant,
  ScrollToEndableView,
} from "@/remote-exec/job-card-ui";
export { unwrapToolResultPayload } from "@/remote-exec/tool-result-payload";

// custom-providers migration
export { useBuiltinPluginEnabled } from "@/plugins/builtin/hooks";
export { SettingsSection } from "@/screens/settings/settings-section";

// Shared UI kit, composer, data, and navigation surfaces
export { type ComposerAttachment, type UserComposerAttachment } from "@/attachments/types";
export { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
export {
  Chip,
  EmptyState,
  ErrorBanner,
  FlagIcon,
  IconButton,
  Input,
  IssueTypeIcon,
  PressableRow,
  PriorityIcon,
  StatusLozenge,
  Tabs,
  UserAvatar,
  tint,
} from "@/components/integration-ui/primitives";
export { jiraStyles } from "@/components/integration-ui/styles";
export { getIsElectron } from "@/constants/platform";
export { invokeDesktopCommand } from "@/desktop/electron/invoke";
export { useHostFeature } from "@/runtime/host-features";
export { createMarkdownStyles } from "@/styles/markdown-styles";
export { buildHostAgentDetailRoute } from "@/utils/host-routes";
export { openExternalUrl } from "@/utils/open-external-url";
export {
  firstWorkspaceDirectory,
  usableWorkspaces,
  workspaceDirectory,
} from "@/utils/usable-workspaces";
// forge-hub
export { MarkdownRenderer } from "@/components/markdown/renderer";
export { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
export {
  type AnsiLine,
  parseAnsiLog,
  stripAnsi,
} from "@/utils/ansi-log";
export { highlightDiffLines } from "@/utils/diff-highlight";
export { tokenizeToLines } from "@/utils/highlight-cache";
export {
  buildInsightsRoute,
  buildOpenProjectRoute,
  buildSettingsRoute,
  buildSkillsRoute,
} from "@/utils/host-routes";
// devices
export { SkeletonLines } from "@/components/ui/skeleton";
export { useSimChatStore } from "@/stores/sim-chat-store";
export { bytesToBase64 } from "@/utils/base64-bytes";
// devices
export { SIM_CHAT_MAX_WIDTH, SIM_CHAT_MIN_WIDTH } from "@/stores/sim-chat-store";
// devices
export { SIM_AGENT_LABEL } from "@/utils/dock-agents";
// workbench
export {
  PROXY_CHAT_MAX_WIDTH,
  PROXY_CHAT_MIN_WIDTH,
  useProxyChatStore,
} from "@/stores/proxy-chat-store";
export {
  bytesToUtf8,
  decodeBase64,
  utf8ToBase64,
} from "@/utils/base64-bytes";
export { PROXY_AGENT_LABEL } from "@/utils/dock-agents";


