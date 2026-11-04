import { describe, expect, it } from "vitest";
import { chooseSignerAccount, iosTouchPlan } from "./wda-auto-prepare.js";

const NOW = 1_793_000_000_000;
const INSTALL = {
  bundleId: "com.facebook.WebDriverAgentRunner.xctrunner",
  accountId: "apl_a1b2c3",
  expiresAt_ms: NOW + 86_400_000,
  installedAt_ms: NOW - 1000,
};
const A = { id: "apl_a1b2c3", label: "<apple-id-a> (Free · Personal Team)" };
const B = { id: "apl_d4e5f6", label: "<apple-id-b> (Paid)" };

describe("touch on an iPhone (spec 27.4)", () => {
  const base = {
    wdaRunning: false,
    install: INSTALL,
    wdaInstalled: true,
    lastWdaFailure: null,
    now_ms: NOW,
  } as const;

  it("drives a running or installed, in-date WDA", () => {
    expect(iosTouchPlan({ ...base, caller: "app", wdaRunning: true, install: null })).toBe(
      "use_wda",
    );
    expect(iosTouchPlan({ ...base, caller: "app" })).toBe("use_wda");
  });

  it("asks the app to set touch up in place when WDA is missing, removed or expired", () => {
    expect(iosTouchPlan({ ...base, caller: "app", install: null })).toBe("ask_app");
    expect(iosTouchPlan({ ...base, caller: "app", wdaInstalled: false })).toBe("ask_app");
    expect(
      iosTouchPlan({ ...base, caller: "app", install: { ...INSTALL, expiresAt_ms: NOW } }),
    ).toBe("ask_app");
    expect(iosTouchPlan({ ...base, caller: "app", lastWdaFailure: "expired" })).toBe("ask_app");
  });

  it("lets an agent prepare WDA itself", () => {
    expect(iosTouchPlan({ ...base, caller: "agent", install: null })).toBe("prepare");
    expect(iosTouchPlan({ ...base, caller: "agent" })).toBe("use_wda");
  });
});

describe("Apple account for WebDriverAgent", () => {
  it("none saved: the app shows Add Apple ID, an agent gets apple_account_required", () => {
    expect(chooseSignerAccount([], { caller: "app" })).toEqual({ kind: "none" });
    expect(chooseSignerAccount([], { caller: "agent", previousId: A.id })).toEqual({
      kind: "none",
    });
  });

  it("exactly one signed-in account is used without asking", () => {
    expect(chooseSignerAccount([A], { caller: "app" })).toEqual({ kind: "use", account: A });
    expect(chooseSignerAccount([A], { caller: "agent" })).toEqual({ kind: "use", account: A });
  });

  it("several: the app asks in the same dialog, then uses the choice", () => {
    expect(chooseSignerAccount([A, B], { caller: "app", previousId: A.id })).toEqual({
      kind: "choose",
      accounts: [A, B],
    });
    expect(chooseSignerAccount([A, B], { caller: "app", requestedId: B.id })).toEqual({
      kind: "use",
      account: B,
    });
    expect(chooseSignerAccount([A, B], { caller: "app", requestedId: "apl_gone00" })).toEqual({
      kind: "choose",
      accounts: [A, B],
    });
  });

  it("several: an agent reuses the account that signed this device before, else asks the user", () => {
    expect(chooseSignerAccount([A, B], { caller: "agent", previousId: B.id })).toEqual({
      kind: "use",
      account: B,
    });
    expect(chooseSignerAccount([A, B], { caller: "agent" })).toEqual({
      kind: "choose",
      accounts: [A, B],
    });
  });
});
