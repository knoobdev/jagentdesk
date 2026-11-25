import { describe, expect, it } from "vitest";
import {
  androidInfoFromProps,
  inputTextArg,
  parseUiautomatorDump,
  parseWmSize,
} from "./android.js";

describe("android", () => {
  it("parses uiautomator dumps into elements in device pixels", () => {
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.google.android.apps.nexuslauncher" content-desc="" enabled="true" bounds="[0,0][1080,2400]"><node index="1" text="Settings" resource-id="com.android.launcher3:id/icon" class="android.widget.TextView" package="com.google.android.apps.nexuslauncher" content-desc="" enabled="true" bounds="[540,1500][810,1800]" /><node index="2" text="" resource-id="" class="android.widget.ImageView" package="x" content-desc="Search &amp; apps" enabled="false" bounds="[10,20][110,220]" /></node></hierarchy>`;
    expect(parseUiautomatorDump(xml)).toEqual([
      {
        role: "FrameLayout",
        label: "",
        identifier: "",
        x: 0,
        y: 0,
        width: 1080,
        height: 2400,
        enabled: true,
      },
      {
        role: "TextView",
        label: "Settings",
        identifier: "com.android.launcher3:id/icon",
        x: 540,
        y: 1500,
        width: 270,
        height: 300,
        enabled: true,
      },
      {
        role: "ImageView",
        label: "Search & apps",
        identifier: "",
        x: 10,
        y: 20,
        width: 100,
        height: 200,
        enabled: false,
      },
    ]);
  });

  it("prefers the override display size", () => {
    expect(parseWmSize("Physical size: 1080x2400\n")).toEqual({ width: 1080, height: 2400 });
    expect(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n")).toEqual({
      width: 720,
      height: 1600,
    });
    expect(parseWmSize("")).toBeNull();
  });

  it("names a device from its settings name, else manufacturer + model", () => {
    const props = new Map([
      ["ro.product.manufacturer", "Google"],
      ["ro.product.model", "Pixel 7"],
      ["ro.build.version.release", "14"],
    ]);
    expect(androidInfoFromProps(props, "")).toEqual({
      name: "Google Pixel 7",
      model: "Google Pixel 7",
      osVersion: "14",
      isEmulator: false,
    });
    expect(androidInfoFromProps(props, "Test bench phone\n").name).toBe("Test bench phone");
    const emulator = new Map([
      ["ro.product.model", "sdk_gphone64_arm64"],
      ["ro.boot.qemu", "1"],
    ]);
    expect(androidInfoFromProps(emulator, "").isEmulator).toBe(true);
  });

  it("encodes spaces for `input text`", () => {
    expect(inputTextArg("hello world")).toBe("hello%sworld");
  });
});
