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
export type { BuiltinClientHost, BuiltinClientProps, BuiltinDestination } from "./host";

export * as Clipboard from "expo-clipboard";
export { useSafeAreaInsets } from "react-native-safe-area-context";

export { isWeb } from "@/constants/platform";

// ssh-servers migration
export { Button } from "@/components/ui/button";
export { Switch } from "@/components/ui/switch";
export { confirmDialog } from "@/utils/confirm-dialog";
export { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
export type { SheetHeader } from "@/components/adaptive-modal-sheet";
export { SelectField } from "@/components/ui/select-field";
export type { SelectFieldOption } from "@/components/ui/select-field";
export { FileEditorModel, getFileConflictCallout } from "@/file-pane/editor/model";
export type {
  FileEditorFile,
  FileEditorObservation,
  FileEditorSession,
  FileObservationSource,
} from "@/file-pane/editor/model";
export { SegmentedControl } from "@/components/ui/segmented-control";
export { useFetchQuery } from "@/data/query";
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
export { Alert } from "@/components/ui/alert";
export { LoadingSpinner } from "@/components/ui/loading-spinner";
export { Field, FormTextInput } from "@/components/ui/form-field";
export { StatusBadge } from "@/components/ui/status-badge";
export { useAppSettings } from "@/hooks/use-settings";
export { BuiltinPluginGate } from "@/plugins/builtin/gate";
export { useFileDownload } from "@/hooks/use-file-download";
export { useFilePicker } from "@/hooks/use-file-picker";
export { BuiltinScreen } from "@/plugins/builtin/surfaces";
export { router, useGlobalSearchParams, useLocalSearchParams } from "expo-router";
export { getIsElectronMac } from "@/constants/platform";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
export type { TerminalPaneAppearance, TerminalPaneExtraKey } from "@/components/terminal-pane";
