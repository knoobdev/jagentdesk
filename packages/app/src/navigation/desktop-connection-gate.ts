import type { ConnectionMode } from "@/tailscale/connection-mode";
import type { TailscaleLoginStatus } from "@/tailscale/types";

export function shouldRedirectToDesktopTailscaleLogin(input: {
  desktopRuntime: boolean;
  connectionModeLoaded: boolean;
  pathname: string;
  mode: ConnectionMode | null;
  loginStatusKind: TailscaleLoginStatus["kind"];
}): boolean {
  if (
    !input.desktopRuntime ||
    !input.connectionModeLoaded ||
    input.pathname === "/tailscale-login" ||
    input.pathname === "/pair-start" ||
    input.pathname === "/pair-scan" ||
    input.pathname === "/pair-link" ||
    input.pathname === "/pair-verify" ||
    input.mode === "local"
  ) {
    return false;
  }

  if (input.mode === null) {
    return true;
  }

  // When the user already chose Tailscale, unknown/connecting/unavailable is
  // a recoverable cold-start condition. The daemon and health monitor need a
  // chance to restore the saved session before the login gate is shown.
  return input.mode === "tailscale" && input.loginStatusKind === "needs-login";
}
