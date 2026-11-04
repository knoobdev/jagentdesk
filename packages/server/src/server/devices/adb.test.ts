import { describe, expect, it } from "vitest";
import {
  AdbForbiddenCommandError,
  assertAllowedAdbArgs,
  isWifiSerial,
  parseAdbDevices,
  parseGetprop,
  shellQuote,
} from "./adb.js";

describe("adb", () => {
  it("refuses adb tcpip, pair and connect wherever they appear after global options", () => {
    expect(() => assertAllowedAdbArgs(["tcpip", "5555"])).toThrow(AdbForbiddenCommandError);
    expect(() => assertAllowedAdbArgs(["-s", "R58M123ABC", "tcpip", "5555"])).toThrow(
      AdbForbiddenCommandError,
    );
    expect(() => assertAllowedAdbArgs(["-s", "tcpip", "shell", "ls"])).not.toThrow();
    // Cable only (ADR-0033 decision 4): no wireless debugging pairing or network connect.
    expect(() => assertAllowedAdbArgs(["pair", "192.168.1.20:37011", "123456"])).toThrow(
      AdbForbiddenCommandError,
    );
    expect(() => assertAllowedAdbArgs(["connect", "192.168.1.20:41235"])).toThrow(
      AdbForbiddenCommandError,
    );
    expect(() => assertAllowedAdbArgs(["-H", "127.0.0.1", "connect", "10.0.0.2:5555"])).toThrow(
      AdbForbiddenCommandError,
    );
    expect(() => assertAllowedAdbArgs(["-s", "R58M123ABC", "shell", "pair"])).not.toThrow();
  });

  it("parses adb devices -l, including unauthorized and Wi-Fi entries", () => {
    const out = [
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
      "R58M123ABC             unauthorized usb:1-1 transport_id:2",
      "192.168.1.20:41235     device product:panther model:Pixel_7 device:panther transport_id:3",
      "0123456789AB           no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:3-2 transport_id:4",
      "",
    ].join("\n");
    expect(parseAdbDevices(out)).toEqual([
      { serial: "emulator-5554", state: "device", model: "sdk gphone64 arm64", usb: false },
      { serial: "R58M123ABC", state: "unauthorized", model: null, usb: true },
      { serial: "192.168.1.20:41235", state: "device", model: "Pixel 7", usb: false },
      { serial: "0123456789AB", state: "no_permissions", model: null, usb: true },
    ]);
  });

  it("parses getprop output", () => {
    const props = parseGetprop(
      "[ro.product.model]: [Pixel 7]\n[ro.build.version.release]: [14]\n[ro.kernel.qemu]: []\n",
    );
    expect(props.get("ro.product.model")).toBe("Pixel 7");
    expect(props.get("ro.build.version.release")).toBe("14");
    expect(props.get("ro.kernel.qemu")).toBe("");
  });

  it("tells network serials from cabled ones", () => {
    expect(isWifiSerial("192.168.1.20:41235")).toBe(true);
    expect(isWifiSerial("adb-R58M123ABC-x1y2z3._adb-tls-connect._tcp")).toBe(true);
    expect(isWifiSerial("R58M123ABC")).toBe(false);
    expect(isWifiSerial("emulator-5554")).toBe(false);
  });

  it("quotes shell arguments for the device's sh", () => {
    expect(shellQuote("com.android.settings")).toBe("com.android.settings");
    expect(shellQuote("jagentdesk://open?b=1&c=2")).toBe("'jagentdesk://open?b=1&c=2'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
