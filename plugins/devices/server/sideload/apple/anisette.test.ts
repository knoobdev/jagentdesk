import { describe, expect, it } from "vitest";
import {
  AOSKIT_JXA,
  AnisetteError,
  NATIVE_RINFO,
  NativeMacAnisette,
  newAnisetteIdentity,
  type RunCommand,
} from "./anisette.js";
import { cpd, refusalMessage } from "./gsa.js";

// What AOSKIT_JXA prints on a Mac: neutral example values, not a real machine.
const DEVICE = {
  md: "b3RwLWV4YW1wbGUtdmFsdWUtMDAwMA==",
  mid: "bWFjaGluZS1pZC1leGFtcGxlLXZhbHVlLTAwMDAwMDAwMDAwMDAwMDA=",
  deviceId: "00000000-AAAA-4BBB-8CCC-000000000001",
  localUserUUID: "00000000-1111-4222-8333-000000000002",
  serial: "<serial>",
  description:
    "<MacBookPro18,3> <macOS;14.1;23B74> <com.apple.AuthKit/1 (com.apple.osascript/1.0)>",
  locale: "en_VN",
  timeZone: "GMT+7",
  cfnetwork: "1485",
};

function fakeRun(stdout: string, code = 0, stderr = "") {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: RunCommand = async (command, args) => {
    calls.push({ command, args });
    return { code, stdout, stderr };
  };
  return { run, calls };
}

const NOW = new Date("2026-11-04T06:40:50.123Z");

describe("NativeMacAnisette", () => {
  it("loads AOSKit and AuthKit in one osascript run", async () => {
    const { run, calls } = fakeRun(JSON.stringify(DEVICE));
    await new NativeMacAnisette(
      run,
      () => NOW,
      () => "23.1.0",
    ).fetch(newAnisetteIdentity());
    expect(calls).toEqual([{ command: "osascript", args: ["-l", "JavaScript", "-e", AOSKIT_JXA] }]);
    expect(AOSKIT_JXA).toContain("/System/Library/PrivateFrameworks/AOSKit.framework");
    expect(AOSKIT_JXA).toContain("/System/Library/PrivateFrameworks/AuthKit.framework");
    expect(AOSKIT_JXA).toContain("AKDevice");
  });

  it("sends this Mac's AKDevice identity, not the stored random identity", async () => {
    const { run } = fakeRun(JSON.stringify(DEVICE));
    const identity = newAnisetteIdentity();
    const result = await new NativeMacAnisette(
      run,
      () => NOW,
      () => "23.1.0",
    ).fetch(identity);
    expect(result.source).toBe("native");
    expect(result.identity).toBe(identity);
    expect(result.userAgent).toBe("akd/1.0 CFNetwork/1485 Darwin/23.1.0");
    expect(result.data).toEqual({
      "X-Apple-I-MD": DEVICE.md,
      "X-Apple-I-MD-M": DEVICE.mid,
      "X-Apple-I-MD-RINFO": NATIVE_RINFO,
      "X-Apple-I-MD-LU": Buffer.from(DEVICE.deviceId).toString("base64"),
      "X-Mme-Device-Id": DEVICE.deviceId,
      "X-Apple-I-SRL-NO": DEVICE.serial,
      "X-Mme-Client-Info": DEVICE.description,
      "X-Apple-I-Client-Time": "2026-11-04T06:40:50Z",
      "X-Apple-Locale": "en_VN",
      "X-Apple-I-TimeZone": "GMT+7",
    });
    expect(result.data["X-Mme-Device-Id"]).not.toBe(identity.deviceId);
  });

  it("never claims to be Xcode in the client info", async () => {
    const { run } = fakeRun(JSON.stringify(DEVICE));
    const result = await new NativeMacAnisette(
      run,
      () => NOW,
      () => "23.1.0",
    ).fetch(newAnisetteIdentity());
    expect(result.data["X-Mme-Client-Info"]).not.toContain("com.apple.dt.Xcode");
  });

  it("falls back for optional values AuthKit did not return", async () => {
    const { run } = fakeRun(
      JSON.stringify({
        ...DEVICE,
        serial: null,
        locale: null,
        timeZone: null,
        cfnetwork: null,
        localUserUUID: null,
      }),
    );
    const result = await new NativeMacAnisette(
      run,
      () => NOW,
      () => "23.1.0",
    ).fetch(newAnisetteIdentity());
    expect(result.data["X-Apple-I-SRL-NO"]).toBe("0");
    expect(result.data["X-Apple-Locale"]).toBe("en_US");
    expect(result.data["X-Apple-I-TimeZone"].length).toBeGreaterThan(0);
    expect(result.userAgent).toMatch(/^akd\/1\.0 CFNetwork\/\d+ Darwin\/23\.1\.0$/);
  });

  it.each([
    ["missing device id", { ...DEVICE, deviceId: null }],
    ["missing client description", { ...DEVICE, description: "" }],
    ["missing OTP", { ...DEVICE, md: null }],
  ])("rejects output with %s", async (_name, output) => {
    const { run } = fakeRun(JSON.stringify(output));
    await expect(new NativeMacAnisette(run).fetch(newAnisetteIdentity())).rejects.toMatchObject({
      code: "native_unavailable",
    });
  });

  it("rejects output that is not JSON", async () => {
    const { run } = fakeRun("not json");
    await expect(new NativeMacAnisette(run).fetch(newAnisetteIdentity())).rejects.toBeInstanceOf(
      AnisetteError,
    );
  });

  it("reports an osascript failure as native_unavailable", async () => {
    const { run } = fakeRun("", 1, "AKDevice is not available");
    await expect(new NativeMacAnisette(run).fetch(newAnisetteIdentity())).rejects.toMatchObject({
      code: "native_unavailable",
      message: expect.stringContaining("AKDevice is not available"),
    });
  });
});

describe("GrandSlam client data", () => {
  it("carries anisette values and the locale, but not the client info", async () => {
    const { run } = fakeRun(JSON.stringify(DEVICE));
    const result = await new NativeMacAnisette(
      run,
      () => NOW,
      () => "23.1.0",
    ).fetch(newAnisetteIdentity());
    const dict = cpd(result.data);
    expect(dict["X-Mme-Client-Info"]).toBeUndefined();
    expect(dict.loc).toBe("en_VN");
    expect(dict["X-Mme-Device-Id"]).toBe(DEVICE.deviceId);
    expect(dict["X-Apple-I-MD-RINFO"]).toBe(NATIVE_RINFO);
    expect(dict).toMatchObject({ bootstrap: true, icscrec: true, pbe: false, prkgen: true });
  });

  it("explains a 503 per anisette source and a 429 rate limit", () => {
    expect(refusalMessage(503, "native")).toContain("native anisette");
    expect(refusalMessage(503, "native")).toContain("remote server");
    expect(refusalMessage(503, "remote")).toContain("remote server");
    expect(refusalMessage(429, "native")).toContain("HTTP 429");
    expect(refusalMessage(500, "native")).toBeNull();
  });
});
