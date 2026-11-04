import { describe, expect, it } from "vitest";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { controlRefusal } from "./hub.js";

const PHYSICAL: SimDevice = {
  udid: "android:serial:R58M123ABC",
  name: "<device name>",
  state: "Connected",
  isBooted: true,
  runtime: "Android 14",
  deviceType: "<model>",
  slimState: "unknown",
  platform: "android",
  kind: "physical",
  connection: "usb",
  controlEnabled: false,
  readiness: "ready",
  osVersion: "14",
  model: "<model>",
};

describe("control switch (spec 27.3)", () => {
  it("refuses a physical device until control is enabled", () => {
    expect(controlRefusal(PHYSICAL, false)?.code).toBe("control_disabled");
    expect(controlRefusal(PHYSICAL, true)).toBeNull();
  });

  it("leaves emulators controllable without enabling", () => {
    const emulator: SimDevice = {
      ...PHYSICAL,
      udid: "android:serial:emulator-5554",
      kind: "emulator",
    };
    expect(controlRefusal(emulator, false)).toBeNull();
  });
});
