import type { SideloadAccountSummary } from "@jagentdesk/client/internal/daemon-client";
import type { SimSignerAccount } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { deviceErrorCopy } from "@/screens/sim-device-errors";

// Spec 27.4 / ADR-0033 decision 8: an iPhone's screen shows without WebDriverAgent; the first
// touch (or "Enable touch") sets WDA up in place, in one dialog: the saved Apple account is used,
// several are offered to choose from, none opens Add Apple ID right there. Pure steps, so the
// dialog is layout only.

export type TouchSetupStep =
  | { kind: "working"; message: string }
  | { kind: "choose_account"; accounts: SimSignerAccount[] }
  | { kind: "add_apple_id" }
  | { kind: "failed"; message: string }
  | { kind: "done" };

export const TOUCH_SETUP_STARTING: TouchSetupStep = {
  kind: "working",
  message: "Checking the Apple accounts saved on this host",
};

// What the dialog shows after one simulator/physical/prepare answer.
export function stepAfterPrepare(response: {
  error: string | null;
  accounts: SimSignerAccount[];
}): TouchSetupStep {
  if (!response.error) return { kind: "done" };
  if (response.error === "account_required" && response.accounts.length > 0) {
    return { kind: "choose_account", accounts: response.accounts };
  }
  if (response.error === "no_apple_account" || response.error === "apple_account_required") {
    return { kind: "add_apple_id" };
  }
  return { kind: "failed", message: deviceErrorCopy(response.error) };
}

// A touch RPC answered this: the device needs touch set up first (the daemon checked, not the
// possibly stale readiness the app holds).
export function opensTouchSetup(error: string | null): boolean {
  return error === "wda_required";
}

// Add Apple ID inside the dialog: an Apple ID that is saved but signed out is offered as
// "Sign in again" instead of a blank form; the terms show only before the first Apple ID.
export function appleIdFormDefaults(accounts: readonly SideloadAccountSummary[]): {
  appleId: string;
  needsTerms: boolean;
  source: "native" | "remote";
  url: string;
} {
  const appleIds = accounts.filter((account) => account.auth === "apple_id");
  const signedOut = appleIds.find((account) => !account.signedIn);
  const remote = signedOut?.anisetteSource === "remote";
  return {
    appleId: signedOut?.appleId ?? "",
    needsTerms: appleIds.length === 0,
    source: remote ? "remote" : "native",
    url: remote ? (signedOut?.anisetteUrl ?? "") : "",
  };
}
