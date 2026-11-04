import { describe, expect, it } from "vitest";
import { parseAdbDevices } from "./android.js";
import { goIosError, parseDetailedList, parsePlainList } from "./ios-devices.js";

describe("go-ios output", () => {
  it("keeps the USB entry of a device listed on cable and Wi-Fi", () => {
    const stdout = `${JSON.stringify({
      deviceList: [
        {
          Udid: "00008110-A",
          ProductType: "iPhone14,2",
          ProductVersion: "17.5",
          ConnectionType: "Network",
        },
        {
          Udid: "00008110-A",
          ProductType: "iPhone14,2",
          ProductVersion: "17.5",
          ConnectionType: "USB",
        },
        {
          Udid: "00008030-B",
          ProductType: "iPad13,1",
          ProductVersion: "16.7",
          ConnectionType: "Network",
        },
      ],
    })}\n`;
    expect(parseDetailedList(stdout)).toEqual([
      {
        udid: "00008110-A",
        name: "",
        model: "iPhone14,2",
        osVersion: "17.5",
        connection: "usb",
        paired: true,
      },
      {
        udid: "00008030-B",
        name: "",
        model: "iPad13,1",
        osVersion: "16.7",
        connection: "wifi",
        paired: true,
      },
    ]);
  });

  it("lists nothing when no device is attached", () => {
    expect(parseDetailedList('{"deviceList":[]}\n')).toEqual([]);
    expect(parsePlainList('{"deviceList":["x","x"]}')).toEqual(["x"]);
  });

  it("reads the error go-ios logs", () => {
    const stderr = [
      '{"time":"t","level":"WARN","msg":"go-ios agent is not running."}',
      '{"time":"t","level":"ERROR","msg":"failed writing","err":"ApplicationVerificationFailed"}',
    ].join("\n");
    expect(goIosError(stderr)).toBe("failed writing: ApplicationVerificationFailed");
  });
});

describe("adb devices -l", () => {
  it("parses USB, wireless and unauthorized devices", () => {
    const stdout = [
      "List of devices attached",
      "R5CT1234ABC            device usb:1-1 product:panther model:Pixel_7 device:panther transport_id:1",
      "adb-R5CT-AbCd._adb-tls-connect._tcp device product:panther model:Pixel_7 transport_id:2",
      "192.168.1.20:37099     unauthorized transport_id:3",
      "",
    ].join("\n");
    expect(parseAdbDevices(stdout)).toEqual([
      {
        serial: "R5CT1234ABC",
        state: "device",
        model: "Pixel 7",
        osVersion: "",
        connection: "usb",
      },
      {
        serial: "adb-R5CT-AbCd._adb-tls-connect._tcp",
        state: "device",
        model: "Pixel 7",
        osVersion: "",
        connection: "wifi",
      },
      {
        serial: "192.168.1.20:37099",
        state: "unauthorized",
        model: "",
        osVersion: "",
        connection: "wifi",
      },
    ]);
  });
});
