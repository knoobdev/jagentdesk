import type { SimSignerAccount } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { IosFailure } from "./ios.js";
import type { WdaInstall } from "./store.js";

// Spec 27.4 / ADR-0033 decision 8: an iPhone shows its screen without WebDriverAgent; the first
// touch prepares WDA in place with the Apple account saved in Sideload. Pure decisions, so the
// hub only wires them.

// Who asks for the touch: the app opens its in-place "Enable touch" dialog on `wda_required`;
// an agent tool (after the 27.6 permission card) prepares straight away.
export type TouchCaller = "app" | "agent";

export type TouchPlan = "use_wda" | "prepare" | "ask_app";

export function iosTouchPlan(input: {
  caller: TouchCaller;
  wdaRunning: boolean;
  install: WdaInstall | null;
  // false when the last probe did not find the WDA app on the device (removed by hand).
  wdaInstalled: boolean | null;
  lastWdaFailure: IosFailure | null;
  now_ms: number;
}): TouchPlan {
  if (input.wdaRunning) return "use_wda";
  const usable =
    input.install !== null &&
    input.wdaInstalled !== false &&
    input.install.expiresAt_ms > input.now_ms &&
    input.lastWdaFailure !== "expired";
  if (usable) return "use_wda";
  return input.caller === "agent" ? "prepare" : "ask_app";
}

export type AccountChoice =
  | { kind: "use"; account: SimSignerAccount }
  | { kind: "none" }
  | { kind: "choose"; accounts: SimSignerAccount[] };

// Signed-in accounts only (sideload-signer.ts filters the rest).
// - requested: the account the user picked in the dialog.
// - previous: the account that signed this device's WDA before; only an agent, which cannot ask,
//   falls back to it when several accounts are saved. The app asks (spec 27.4).
export function chooseSignerAccount(
  accounts: readonly SimSignerAccount[],
  input: { requestedId?: string; previousId?: string; caller: TouchCaller },
): AccountChoice {
  if (accounts.length === 0) return { kind: "none" };
  if (input.requestedId) {
    const requested = accounts.find((account) => account.id === input.requestedId);
    return requested
      ? { kind: "use", account: requested }
      : { kind: "choose", accounts: [...accounts] };
  }
  if (accounts.length === 1) return { kind: "use", account: accounts[0] };
  if (input.caller === "agent" && input.previousId) {
    const previous = accounts.find((account) => account.id === input.previousId);
    if (previous) return { kind: "use", account: previous };
  }
  return { kind: "choose", accounts: [...accounts] };
}
