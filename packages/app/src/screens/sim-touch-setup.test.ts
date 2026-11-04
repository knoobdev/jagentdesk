import { describe, expect, it } from "vitest";
import type { SideloadAccountSummary } from "@jagentdesk/client/internal/daemon-client";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { READINESS_COPY, deviceErrorCopy } from "@/screens/sim-device-errors";
import { isDeviceLive, needsTouchSetup } from "@/screens/sim-phone";
import { appleIdFormDefaults, opensTouchSetup, stepAfterPrepare } from "@/screens/sim-touch-setup";

const IPHONE: SimDevice = {
  udid: "ios:00008110-001A2B3C4D5E6F70",
  name: "<device name>",
  state: "Connected",
  isBooted: true,
  runtime: "iOS 17.4",
  deviceType: "iPhone14,2",
  slimState: "unknown",
  platform: "ios",
  kind: "physical",
  connection: "usb",
  controlEnabled: true,
  readiness: "needs_wda",
  screenAvailable: true,
  osVersion: "17.4",
  model: "iPhone14,2",
};

function account(overrides: Partial<SideloadAccountSummary>): SideloadAccountSummary {
  return {
    id: "apl_a1b2c3",
    appleId: "<apple-id>",
    kind: "free",
    auth: "apple_id",
    teamId: "TEAM000001",
    teamName: "Personal Team",
    keepSignedIn: false,
    anisetteSource: "native",
    anisetteUrl: null,
    createdAt_ms: 0,
    signedIn: true,
    appIdsUsed: 0,
    appIdsLimit: 10,
    nextAppIdAt_ms: null,
    ...overrides,
  } as SideloadAccountSummary;
}

describe("iPhone view first (spec 27.5)", () => {
  it("shows the screen of an iPhone without WebDriverAgent once control is on", () => {
    expect(isDeviceLive(IPHONE)).toBe(true);
    expect(isDeviceLive({ ...IPHONE, controlEnabled: false })).toBe(false);
    expect(
      isDeviceLive({ ...IPHONE, readiness: "needs_developer_mode", screenAvailable: false }),
    ).toBe(false);
  });

  it("keeps older daemons, which send no screenAvailable, on readiness ready", () => {
    const { screenAvailable: _omit, ...old } = IPHONE;
    expect(isDeviceLive(old)).toBe(false);
    expect(isDeviceLive({ ...old, readiness: "ready" })).toBe(true);
  });

  it("asks for touch setup only on a physical iPhone without a usable WDA", () => {
    expect(needsTouchSetup(IPHONE)).toBe(true);
    expect(needsTouchSetup({ ...IPHONE, readiness: "wda_expired" })).toBe(true);
    expect(needsTouchSetup({ ...IPHONE, readiness: "ready" })).toBe(false);
    expect(needsTouchSetup({ ...IPHONE, platform: "android", udid: "android:serial:R58M" })).toBe(
      false,
    );
  });
});

describe("Enable touch in place (spec 27.4)", () => {
  const A = { id: "apl_a1b2c3", label: "<apple-id-a> (Free · Personal Team)" };
  const B = { id: "apl_d4e5f6", label: "<apple-id-b> (Paid)" };

  it("goes on with the touch once WDA is ready", () => {
    expect(stepAfterPrepare({ error: null, accounts: [] })).toEqual({ kind: "done" });
  });

  it("offers the saved accounts when several are signed in", () => {
    expect(stepAfterPrepare({ error: "account_required", accounts: [A, B] })).toEqual({
      kind: "choose_account",
      accounts: [A, B],
    });
  });

  it("opens Add Apple ID in the same dialog when no account is saved", () => {
    expect(stepAfterPrepare({ error: "no_apple_account", accounts: [] })).toEqual({
      kind: "add_apple_id",
    });
    expect(stepAfterPrepare({ error: "apple_account_required", accounts: [] })).toEqual({
      kind: "add_apple_id",
    });
  });

  it("shows any other refusal with its copy", () => {
    expect(stepAfterPrepare({ error: "sideload_unavailable", accounts: [] })).toEqual({
      kind: "failed",
      message: deviceErrorCopy("sideload_unavailable"),
    });
  });

  it("opens the dialog on wda_required only", () => {
    expect(opensTouchSetup("wda_required")).toBe(true);
    expect(opensTouchSetup("control_disabled")).toBe(false);
    expect(opensTouchSetup(null)).toBe(false);
  });

  it("prefills a signed-out Apple ID and shows the terms only before the first one", () => {
    expect(appleIdFormDefaults([])).toEqual({
      appleId: "",
      needsTerms: true,
      source: "native",
      url: "",
    });
    expect(
      appleIdFormDefaults([
        account({ signedIn: false, anisetteSource: "remote", anisetteUrl: "http://<host>:6969" }),
      ]),
    ).toEqual({
      appleId: "<apple-id>",
      needsTerms: false,
      source: "remote",
      url: "http://<host>:6969",
    });
  });

  it("no longer sends the user to a separate Prepare step or the Sideload tab", () => {
    const copy = [...Object.values(READINESS_COPY), deviceErrorCopy("no_apple_account")].join(" ");
    expect(copy).not.toMatch(/Prepare the device|in Sideload first/);
  });
});
