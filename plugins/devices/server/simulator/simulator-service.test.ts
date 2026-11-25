import { describe, expect, it } from "vitest";
import { imageSize, parseDevices, parseRuntimes } from "./simulator-service.js";

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

// SOI, an APP0 segment to skip, then SOF0 (height before width).
function jpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x06,
    0x4a,
    0x46,
    0x49,
    0x46,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

describe("imageSize", () => {
  it("reads PNG and JPEG frame sizes", () => {
    expect(imageSize(png(1179, 2556))).toEqual({ width: 1179, height: 2556 });
    expect(imageSize(jpeg(221, 480))).toEqual({ width: 221, height: 480 });
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
  });
});

describe("parseRuntimes", () => {
  it("keeps available iOS runtimes, newest first, with their creatable device types", () => {
    const json = JSON.stringify({
      runtimes: [
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-4",
          name: "iOS 17.4",
          isAvailable: true,
          supportedDeviceTypes: [
            {
              identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
              name: "iPhone 15 Pro",
              productFamily: "iPhone",
            },
          ],
        },
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-17-5",
          name: "iOS 17.5",
          isAvailable: true,
        },
        { identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-10-4", name: "watchOS 10.4" },
        {
          identifier: "com.apple.CoreSimulator.SimRuntime.iOS-16-0",
          name: "iOS 16.0",
          isAvailable: false,
        },
      ],
    });
    const runtimes = parseRuntimes(json);
    expect(runtimes.map((r) => r.name)).toEqual(["iOS 17.5", "iOS 17.4"]);
    expect(runtimes[1]?.deviceTypes).toEqual([
      {
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
        name: "iPhone 15 Pro",
        productFamily: "iPhone",
      },
    ]);
  });
});

describe("parseDevices", () => {
  it("reports Apple's device type name, not the identifier or the user's device name", () => {
    const json = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-4": [
          {
            udid: "wks_a1b2c3",
            name: "My test phone",
            state: "Booted",
            deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation",
          },
        ],
      },
    });
    const names = new Map([
      [
        "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation",
        "iPhone SE (3rd generation)",
      ],
    ]);
    const [device] = parseDevices(json, names);
    expect(device).toMatchObject({
      name: "My test phone",
      deviceType: "iPhone SE (3rd generation)",
      runtime: "iOS 17.4",
      isBooted: true,
    });
    // Without the catalog it falls back to the identifier tail.
    expect(parseDevices(json)[0]?.deviceType).toBe("iPhone SE 3rd generation");
  });
});
