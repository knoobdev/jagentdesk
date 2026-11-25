import type { TailnetMode } from "./tailnet-mode";
import type { TailscaleLoginStatus } from "./types";

/**
 * Tailscale login gate for the pairing flow.
 *
 * pair-verify must wait for the *real* connected state before it starts the
 * daemon connection. Native tsnet reports `connecting` while it is preparing
 * the node and the user still needs the login screen to finish that flow; only
 * `unknown` (hydration in flight) remains transient.
 */
export function isTailscaleReady(status: TailscaleLoginStatus): boolean {
  return status.kind === "connected";
}

export function shouldRoutePairVerifyToTailscaleLogin(status: TailscaleLoginStatus): boolean {
  return (
    status.kind === "needs-login" || status.kind === "connecting" || status.kind === "unavailable"
  );
}

export type PairingCodeEntryAction = "resolve" | "start-attempt" | "wait";

/**
 * Decide what a freshly-entered 6-digit code should do in pair-verify.
 *
 * - `resolve`: an in-flight connection attempt is waiting for the code.
 * - `start-attempt`: no attempt is live (a previous one failed); the code is
 *   the retry signal and a new connection attempt must be created.
 * - `wait`: a code that is not a full 6 digits (or already consumed by a live
 *   attempt) needs no action.
 */
export function classifyPairingCodeEntry(input: {
  codeComplete: boolean;
  resolverArmed: boolean;
  hasLiveAttempt: boolean;
}): PairingCodeEntryAction {
  if (!input.codeComplete) return "wait";
  if (input.resolverArmed) return "resolve";
  if (!input.hasLiveAttempt) return "start-attempt";
  return "wait";
}

/** Which route a pairing link offers this device (spec 35, `05.3.3`). */
export type PairingLinkRoute = "relay" | "tailnet" | "local";

export type PairVerifyDecision =
  | { kind: "pair"; route: PairingLinkRoute }
  | { kind: "tailscale-login" }
  | { kind: "wait" };

/**
 * ADR-0056: decide what pair-verify does with a scanned or pasted link.
 *
 * A link that carries relay pairs over relay at once — the device never has to
 * be on the tailnet. A tailnet-only link needs this device on the tailnet
 * first, so pair-verify opens the Tailscale sign-in screen, which returns here
 * once the node is connected. A loopback link is only usable on the host's
 * own machine.
 */
export function resolvePairVerifyDecision(input: {
  hasRelay: boolean;
  local: boolean;
  status: TailscaleLoginStatus;
}): PairVerifyDecision {
  if (input.hasRelay) return { kind: "pair", route: "relay" };
  if (input.local) return { kind: "pair", route: "local" };
  if (isTailscaleReady(input.status)) return { kind: "pair", route: "tailnet" };
  if (shouldRoutePairVerifyToTailscaleLogin(input.status)) return { kind: "tailscale-login" };
  return { kind: "wait" };
}

/**
 * The tailnet mode to record once pairing succeeded. Pairing over the tailnet
 * proves this device is on it. Pairing over relay or loopback says nothing
 * about the tailnet, so it only fills an empty value and never turns an
 * existing Tailscale sign-in off.
 */
export function tailnetModeAfterPairing(input: {
  route: PairingLinkRoute;
  current: TailnetMode | null;
}): TailnetMode {
  if (input.route === "tailnet") return "tailnet";
  return input.current ?? "off";
}
