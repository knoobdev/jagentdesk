import { describe, expect, it } from "vitest";
import { cabledIosDevices, lastJson, parseGoIosAppList, parseGoIosList } from "./go-ios.js";
import {
  classifyIosFailure,
  iosMajorVersion,
  iosReadiness,
  type IosReadinessInput,
} from "./ios.js";
import { buildPlist, encodeUsbmuxMessage, parsePlist, usbmuxPort } from "./usbmux.js";
import { parseWdaSource } from "./wda.js";

const NOW = 1_793_000_000_000;
const WDA = {
  bundleId: "com.facebook.WebDriverAgentRunner.xctrunner",
  accountId: "acc_a1b2c3",
  expiresAt_ms: NOW + 86_400_000,
  installedAt_ms: NOW - 1000,
};

function input(overrides: Partial<IosReadinessInput>): IosReadinessInput {
  return {
    majorVersion: 17,
    pairing: "paired",
    developerMode: true,
    wda: WDA,
    wdaInstalled: true,
    lastWdaFailure: null,
    wdaLocked: null,
    now_ms: NOW,
    ...overrides,
  };
}

describe("go-ios output", () => {
  it("parses `ios list --details` and ignores slog lines", () => {
    const stdout =
      '{"deviceList":[{"Udid":"00008110-001A2B3C4D5E6F70","ProductName":"iPhone OS","ProductType":"iPhone14,2","ProductVersion":"17.4.1","ConnectionType":"USB"}]}\n';
    expect(parseGoIosList(stdout)).toEqual([
      {
        udid: "00008110-001A2B3C4D5E6F70",
        productName: "iPhone OS",
        productType: "iPhone14,2",
        productVersion: "17.4.1",
        connectionType: "USB",
      },
    ]);
  });

  it("keeps only cabled devices for control (spec 27.1)", () => {
    const usb = {
      udid: "00008110-001A2B3C4D5E6F70",
      productName: "iPhone OS",
      productType: "iPhone14,2",
      productVersion: "17.4.1",
      connectionType: "USB",
    };
    const wifiOnly = { ...usb, udid: "00008030-000A1B2C3D4E5F60", connectionType: "Network" };
    const sameOnWifi = { ...usb, connectionType: "Network" };
    expect(cabledIosDevices([wifiOnly, sameOnWifi, usb])).toEqual([usb]);
    expect(cabledIosDevices([wifiOnly])).toEqual([]);
  });

  it("returns an empty list when no device is attached", () => {
    expect(parseGoIosList('{"deviceList":[]}\n')).toEqual([]);
    expect(parseGoIosList("")).toEqual([]);
  });

  it("takes the last JSON line of mixed output", () => {
    expect(lastJson('{"level":"WARN","msg":"go-ios agent is not running"}\ntrue\n')).toBe(true);
  });

  it("lists bundle ids from `ios apps --list`", () => {
    expect(
      parseGoIosAppList(
        "com.facebook.WebDriverAgentRunner.xctrunner WebDriverAgentRunner-Runner 1.0\ncom.apple.mobilenotes Notes 4.11\n",
      ),
    ).toEqual(["com.facebook.WebDriverAgentRunner.xctrunner", "com.apple.mobilenotes"]);
  });
});

describe("iOS readiness (spec 27.4)", () => {
  it("walks trust → unlock → Developer Mode → WebDriverAgent", () => {
    expect(iosReadiness(input({ pairing: "untrusted" }))).toBe("needs_trust");
    expect(iosReadiness(input({ pairing: "locked" }))).toBe("needs_unlock");
    expect(iosReadiness(input({ wdaLocked: true }))).toBe("needs_unlock");
    expect(iosReadiness(input({ lastWdaFailure: "locked" }))).toBe("needs_unlock");
    expect(iosReadiness(input({ developerMode: false }))).toBe("needs_developer_mode");
    // iOS 15 has no Developer Mode switch.
    expect(iosReadiness(input({ majorVersion: 15, developerMode: false }))).toBe("ready");
    expect(iosReadiness(input({ wda: null }))).toBe("needs_wda");
    expect(iosReadiness(input({ wdaInstalled: false }))).toBe("needs_wda");
    expect(iosReadiness(input({ wda: { ...WDA, expiresAt_ms: NOW } }))).toBe("wda_expired");
    expect(iosReadiness(input({ lastWdaFailure: "expired" }))).toBe("wda_expired");
    expect(iosReadiness(input({}))).toBe("ready");
  });

  it("classifies go-ios and testmanagerd failures", () => {
    expect(classifyIosFailure("lockdown error: PairingDialogResponsePending")).toBe("untrusted");
    expect(classifyIosFailure("could not retrieve PairRecord with error")).toBe("untrusted");
    expect(classifyIosFailure("failed: PasswordProtected")).toBe("locked");
    expect(classifyIosFailure("The device is locked; unlock it to continue")).toBe("locked");
    expect(classifyIosFailure("The provisioning profile has expired")).toBe("expired");
    expect(classifyIosFailure("Developer Mode is disabled")).toBe("developer_mode");
    expect(classifyIosFailure("connection reset")).toBe("other");
  });

  it("reads the major version", () => {
    expect(iosMajorVersion("17.4.1")).toBe(17);
    expect(iosMajorVersion("")).toBe(0);
  });
});

describe("usbmux", () => {
  it("round-trips the plist it sends and reads usbmuxd replies", () => {
    const reply = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>DeviceList</key><array><dict><key>DeviceID</key><integer>7</integer><key>MessageType</key><string>Attached</string><key>Properties</key><dict><key>ConnectionType</key><string>USB</string><key>DeviceID</key><integer>7</integer><key>SerialNumber</key><string>00008110-001A2B3C4D5E6F70</string><key>USBSerialNumber</key><string>00008110001A2B3C4D5E6F70</string></dict></dict></array></dict></plist>`;
    expect(parsePlist(reply)).toEqual({
      DeviceList: [
        {
          DeviceID: 7,
          MessageType: "Attached",
          Properties: {
            ConnectionType: "USB",
            DeviceID: 7,
            SerialNumber: "00008110-001A2B3C4D5E6F70",
            USBSerialNumber: "00008110001A2B3C4D5E6F70",
          },
        },
      ],
    });
    const sent = { MessageType: "Connect", DeviceID: 7, PortNumber: usbmuxPort(8100), Flag: true };
    expect(parsePlist(buildPlist(sent))).toEqual(sent);
  });

  it("frames messages with the 16-byte little-endian header and swaps the port bytes", () => {
    const message = encodeUsbmuxMessage({ MessageType: "ListDevices" }, 1);
    expect(message.readUInt32LE(0)).toBe(message.length);
    expect(message.readUInt32LE(4)).toBe(1);
    expect(message.readUInt32LE(8)).toBe(8);
    expect(message.readUInt32LE(12)).toBe(1);
    expect(usbmuxPort(8100)).toBe(0xa41f);
  });
});

describe("WebDriverAgent source", () => {
  it("keeps visible elements with their point frames", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Notes" label="Notes" enabled="true" visible="true" x="0" y="0" width="390" height="844"><XCUIElementTypeTextView type="XCUIElementTypeTextView" value="Hello" name="note-body" enabled="true" visible="true" x="16" y="120" width="358" height="600"/><XCUIElementTypeButton type="XCUIElementTypeButton" name="hidden" label="Hidden" enabled="true" visible="false" x="0" y="0" width="1" height="1"/></XCUIElementTypeApplication>`;
    expect(parseWdaSource(xml)).toEqual([
      {
        role: "Application",
        label: "Notes",
        identifier: "Notes",
        x: 0,
        y: 0,
        width: 390,
        height: 844,
        enabled: true,
      },
      {
        role: "TextView",
        label: "Hello",
        identifier: "note-body",
        x: 16,
        y: 120,
        width: 358,
        height: 600,
        enabled: true,
      },
    ]);
  });
});
