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
    status.kind === "needs-login" ||
    status.kind === "connecting" ||
    status.kind === "unavailable"
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
