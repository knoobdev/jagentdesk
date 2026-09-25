import { describe, expect, it } from "vitest";
import { deviceSpec, pngAspect } from "@/screens/sim-device-spec";
import { uniqueNames } from "@/screens/sim-names";

describe("deviceSpec", () => {
  it("gives Touch-ID devices a rectangular screen with real forehead/chin bezels", () => {
    for (const name of [
      "iPhone SE (3rd generation)",
      "iPhone 8 Plus",
      "iPod touch (7th generation)",
      "iPad (9th generation)",
      "iPad mini 4",
      "iPad Air 2",
      "iPad Pro (12.9-inch) (2nd generation)",
    ]) {
      const spec = deviceSpec(name);
      expect(spec.homeButton, name).toBe(true);
      expect(spec.radiusRatio, name).toBe(0);
      expect(spec.bezelY, name).toBeGreaterThan(spec.bezelX);
    }
    // iPhone SE 2/3: 67.3 × 138.4 mm body around a 750 × 1334 @ 326 ppi display.
    const se = deviceSpec("iPhone SE (3rd generation)");
    expect(se.bezelX).toBeCloseTo(0.076, 3);
    expect(se.bezelY).toBeCloseTo(0.166, 3);
  });

  it("uses Apple's per-generation screen corner radius for Face-ID devices", () => {
    expect(deviceSpec("iPhone X").radiusRatio).toBeCloseTo(39 / 375, 4);
    expect(deviceSpec("iPhone Xʀ").radiusRatio).toBeCloseTo(41.5 / 414, 4);
    expect(deviceSpec("iPhone 12 mini").radiusRatio).toBeCloseTo(44 / 375, 4);
    expect(deviceSpec("iPhone 14 Pro").radiusRatio).toBeCloseTo(55 / 393, 4);
    expect(deviceSpec("iPhone 15 Pro Max").radiusRatio).toBeCloseTo(55 / 430, 4);
    expect(deviceSpec("iPhone 17 Pro").radiusRatio).toBeCloseTo(62 / 402, 4);
    expect(deviceSpec("iPad mini (6th generation)").radiusRatio).toBeCloseTo(21.5 / 744, 4);
    expect(deviceSpec("iPad Air 11-inch (M2)").homeButton).toBe(false);
  });

  it("keeps Face-ID bezels uniform on all four sides", () => {
    const pro = deviceSpec("iPhone 15 Pro");
    // 1179 × 2556 @ 460 ppi → 65.1 × 141.1 mm inside 70.6 × 146.6 mm: ~2.75 mm each side.
    expect(pro.bezelX * ((1179 / 460) * 25.4)).toBeCloseTo(pro.bezelY * ((2556 / 460) * 25.4), 1);
  });
});

describe("pngAspect", () => {
  it("reads width/height from the PNG header", () => {
    const header = new Uint8Array(24);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(header.buffer);
    view.setUint32(16, 750);
    view.setUint32(20, 1334);
    const b64 = btoa(String.fromCharCode(...header));
    expect(pngAspect(`data:image/png;base64,${b64}`)).toBeCloseTo(750 / 1334, 6);
  });
});

describe("uniqueNames", () => {
  it("numbers copies and skips names already in the fleet", () => {
    expect(uniqueNames("iPhone 15 Pro", 1, [])).toEqual(["iPhone 15 Pro"]);
    expect(uniqueNames("iPhone 15 Pro", 3, ["iPhone 15 Pro", "iPhone 15 Pro 3"])).toEqual([
      "iPhone 15 Pro 2",
      "iPhone 15 Pro 4",
      "iPhone 15 Pro 5",
    ]);
  });
});
