import { describe, expect, it } from "vitest";
import { filterPairedDevices, sortPairedDevices, type PairedDevice } from "./paired-devices";

function device(id: string, pairedAtMs: number, extra: Partial<PairedDevice> = {}): PairedDevice {
  return { deviceId: id, devicePublicKeyB64: `key-${id}`, pairedAtMs, ...extra };
}

describe("paired devices list", () => {
  it("puts the newest pairing first", () => {
    const sorted = sortPairedDevices([device("a", 1), device("b", 3), device("c", 2)]);
    expect(sorted.map((entry) => entry.deviceId)).toEqual(["b", "c", "a"]);
  });

  it("searches names, kinds and ids", () => {
    const devices = [
      device("a", 1, { deviceName: "Pixel 8", kind: "mobile" }),
      device("b", 2, { deviceName: "Work MacBook", kind: "desktop" }),
      device("c3f9", 3),
    ];
    expect(filterPairedDevices(devices, "pixel").map((entry) => entry.deviceId)).toEqual(["a"]);
    expect(filterPairedDevices(devices, "DESKTOP").map((entry) => entry.deviceId)).toEqual(["b"]);
    expect(filterPairedDevices(devices, "c3f").map((entry) => entry.deviceId)).toEqual(["c3f9"]);
    expect(filterPairedDevices(devices, "  ")).toHaveLength(3);
  });
});
