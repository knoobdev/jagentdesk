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
  BuiltinAttachmentPillProps,
  BuiltinClientHost,
  BuiltinClientProps,
  BuiltinDestination,
} from "./host";

// Packages installed only in packages/app resolve for features through the host API.
export * as Clipboard from "expo-clipboard";
export { router, useGlobalSearchParams, useLocalSearchParams, type Href } from "expo-router";
export { useIsFocused } from "expo-router/react-navigation";
export { useSafeAreaInsets } from "react-native-safe-area-context";

export { isWeb } from "@/constants/platform";
// Shared UI kit, composer, data, and navigation surfaces
export { type ComposerAttachment, type UserComposerAttachment } from "@/attachments/types";
export { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
export { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
export {
  Chip,
  EmptyState,
  ErrorBanner,
  Field,
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
export { Button } from "@/components/ui/button";
export { LoadingSpinner } from "@/components/ui/loading-spinner";
export { Composer } from "@/composer";
export { useDraftAgentCreateFlow } from "@/composer/draft/create-flow";
export { useAgentInputDraft } from "@/composer/draft/input-draft";
export { getIsElectron } from "@/constants/platform";
export { useFetchQuery } from "@/data/query";
export { invokeDesktopCommand } from "@/desktop/electron/invoke";
export { useFilePicker } from "@/hooks/use-file-picker";
export { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
export { AgentConversationPanel } from "@/panels/agent-panel";
export {
  type PaneContextValue,
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
} from "@/panels/pane-context";
export { useHostFeature } from "@/runtime/host-features";
export { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
export { type Agent, useSessionStore } from "@/stores/session-store";
export { createMarkdownStyles } from "@/styles/markdown-styles";
export { confirmDialog } from "@/utils/confirm-dialog";
export { encodeImages } from "@/utils/encode-images";
export { buildHostAgentDetailRoute } from "@/utils/host-routes";
export { openExternalUrl } from "@/utils/open-external-url";
export {
  firstWorkspaceDirectory,
  usableWorkspaces,
  workspaceDirectory,
} from "@/utils/usable-workspaces";
