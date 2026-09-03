import type { ConnectionMode } from "@/tailscale/connection-mode";
import type { TailscaleLoginStatus } from "@/tailscale/types";

export function shouldRedirectToDesktopTailscaleLogin(input: {
  desktopRuntime: boolean;
  connectionModeLoaded: boolean;
  pathname: string;
  mode: ConnectionMode | null;
  loginStatusKind: TailscaleLoginStatus["kind"];
  /** True when the Tailscale host has entered a persistent timed-out ("error")
   *  state — distinct from a transient cold-start reconnect. */
  tailscaleTimedOut?: boolean;
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

  if (input.mode !== "tailscale") {
    return false;
  }

  // When the user already chose Tailscale, unknown/connecting/unavailable is
  // a recoverable cold-start condition. The daemon and health monitor need a
  // chance to restore the saved session before the login gate is shown. But a
  // needs-login status, or a host that has actually timed out (connection in
  // "error", not merely connecting), means the saved session will not recover
  // on its own — send the user back to the host picker to re-login or switch.
  return input.loginStatusKind === "needs-login" || input.tailscaleTimedOut === true;
}
