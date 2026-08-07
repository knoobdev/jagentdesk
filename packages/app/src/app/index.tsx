import React from "react";
import { Redirect, usePathname, type Href } from "expo-router";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useEarliestOnlineHostServerId, useHostRuntimeBootstrapState } from "@/app/_layout";
import {
  resolveStartupRoute,
  resolveWorkspaceSelectionStatus,
} from "@/navigation/host-runtime-bootstrap";
import { useHostRegistryStatus, useHosts } from "@/runtime/host-runtime";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { isNative } from "@/constants/platform";
import { useConnectionMode } from "@/tailscale";

const isDesktop = shouldUseDesktopDaemon();
let nativePairingOnboardingLatched = false;

function shouldResumeNativePairing(input: {
  isNative: boolean;
  connectionMode: string | null;
  hostRegistryStatus: "loading" | "ready";
  hostCount: number;
}): boolean {
  if (!input.isNative || input.connectionMode !== "tailscale" || input.hostCount > 0) {
    nativePairingOnboardingLatched = false;
    return false;
  }
  if (input.hostRegistryStatus === "ready") {
    nativePairingOnboardingLatched = true;
  }
  return nativePairingOnboardingLatched;
}

export default function Index() {
  const pathname = usePathname();
  const bootstrapState = useHostRuntimeBootstrapState();
  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const hosts = useHosts();
  const hostRegistryStatus = useHostRegistryStatus();
  const workspaceSelection = useLastWorkspaceSelection();
  const isWorkspaceSelectionLoaded = useIsLastWorkspaceSelectionHydrated();
  const workspaceSelectionServerId = workspaceSelection?.serverId ?? null;
  const workspaceSelectionWorkspaceId = workspaceSelection?.workspaceId ?? null;
  const hasHydratedWorkspaceSelectionHost = useHasHydratedWorkspaces(workspaceSelectionServerId);
  const workspaceSelectionExists = useWorkspaceExists(
    workspaceSelectionServerId,
    workspaceSelectionWorkspaceId,
  );
  const { mode: connectionMode, loaded: connectionModeLoaded } = useConnectionMode();

  // Hydrate the user's selected transport before routing. Tailscale health is
  // deliberately not part of this gate: the native node is restored in the
  // background and the host runtime owns its connecting/offline state.
  if (!connectionModeLoaded) {
    return <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
  }

  if ((isNative || isDesktop) && connectionMode === null) {
    return <Redirect href={isNative ? ("/pair-start" as Href) : "/tailscale-login"} />;
  }

  // A mobile install that remembers Tailscale mode but has no saved desktop
  // must resume onboarding. This also recovers an interrupted first pairing
  // without sending the user to a login screen before an offer exists.
  if (
    shouldResumeNativePairing({
      isNative,
      connectionMode,
      hostRegistryStatus,
      hostCount: hosts.length,
    })
  ) {
    return <Redirect href={"/pair-start" as Href} />;
  }

  const startupRoute = resolveStartupRoute({
    route: { kind: "index", pathname },
    startupBlocker: bootstrapState.startupBlocker,
    hostRegistryStatus,
    hosts,
    anyOnlineHostServerId,
    workspaceSelection,
    workspaceSelectionStatus: resolveWorkspaceSelectionStatus({
      hasHydratedWorkspaces: hasHydratedWorkspaceSelectionHost,
      workspaceExists: workspaceSelectionExists,
    }),
    isWorkspaceSelectionLoaded,
    hasGivenUpWaitingForHost: bootstrapState.hasGivenUpWaitingForHost,
  });

  if (startupRoute.kind === "redirect") {
    return <Redirect href={startupRoute.href} />;
  }

  return <StartupSplashScreen bootstrapState={isDesktop ? bootstrapState : undefined} />;
}
