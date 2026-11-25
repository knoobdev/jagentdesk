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
