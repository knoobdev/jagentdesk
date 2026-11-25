/** Public core UI and service surface for statically linked built-in clients. */
export { PageHeader } from "@/components/headers/page-header";
export {
  gumloopChipStyles,
  gumloopListStyles,
  gumloopTabStyles,
} from "@/components/gumloop-shell/list-styles";
export { useWorkspaceDirectory, useWorkspaceKeys } from "@/stores/session-store-hooks";
export { getDesktopHost } from "@/desktop/host";
export { useIsCompactFormFactor } from "@/constants/layout";
export { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
export { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
export { TerminalPane } from "@/components/terminal-pane";
export { withSshDocker, type SshDockerTarget } from "@/ssh/ui/ssh-docker-client";
export type { Theme } from "@/styles/theme";
export { GumloopRow } from "@/components/gumloop-shell/row";
export type {
  BuiltinAgentProps,
  BuiltinClientHost,
  BuiltinClientProps,
  BuiltinComposerDockProps,
  BuiltinSidePanelProps,
  BuiltinDestination,
  BuiltinUserMessageBodyProps,
  BuiltinTurnPreparation,
} from "./host";

export * as Clipboard from "expo-clipboard";
export { useSafeAreaInsets } from "react-native-safe-area-context";

export { isWeb } from "@/constants/platform";
// Packages installed only in packages/app resolve through here.
export { router } from "expo-router";

// Shared app UI and data hooks used by feature screens.
export {
  AdaptiveTextInput,
  AdaptiveModalSheet,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
export { MarkdownRenderer } from "@/components/markdown/renderer";
export { Alert } from "@/components/ui/alert";
export { Button } from "@/components/ui/button";
export { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
export { Field, FormTextInput } from "@/components/ui/form-field";
export { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
export { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
export { Switch } from "@/components/ui/switch";
export { AgentControlTrigger } from "@/composer/agent-controls/control";
export { useToast } from "@/contexts/toast-context";
export { useFetchQueries, useFetchQuery, useReplicaQuery } from "@/data/query";
export { useDaemonConfig } from "@/hooks/use-daemon-config";
export { useHostRouteServerId } from "@/navigation/host-route-context";
export { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
export { type StreamItem } from "@/types/stream";
export { confirmDialog } from "@/utils/confirm-dialog";
export { formatTimeAgo } from "@/utils/time";

export { StatusBadge } from "@/components/ui/status-badge";
export { ExternalLink } from "@/components/ui/external-link";
export { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
export { buildSettingsHostSectionRoute } from "@/utils/host-routes";

// Spec mode and autonomous mode read each other's per-agent state.
export { useAutorunState, useSpecModeState } from "@/hooks/use-agent-mode-state";
export { specModeBubbleText } from "@/components/spec-mode-bubble-text";
export { settingsStyles } from "@/styles/settings";
export { useHostFeature } from "@/runtime/host-features";
export { LoadingSpinner } from "@/components/ui/loading-spinner";
// The activity graph frame shares the stream's node-selection contract and HTML navigation rules.
export { acceptSelectMessage } from "@/agent-stream/activity-node-action";
export { htmlPreviewNavigationKind } from "@/file-pane/html-preview-navigation";
export { formatTokenCount } from "@/components/context-window-meter.utils";
export { usageHistoryQueryKey, type UsageHistory } from "@/data/usage-history-query";
export {
  useGumloopDesktopShell,
  useIsGumloopTheme,
} from "@/components/gumloop-shell/use-gumloop-chrome";

// Fingerprint profile patches are shared with the desktop browser pane's profile sync.
export {
  activeFingerprintProfileId,
  deleteProfilePatch,
  listFingerprintProfiles,
  newFingerprintProfileId,
  selectProfilePatch,
  upsertProfilePatch,
} from "@/screens/settings/browser-fingerprint-config";
