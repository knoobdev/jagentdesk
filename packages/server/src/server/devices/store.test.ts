import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JpegStreamSplitter } from "./image.js";
import { PhysicalDeviceStore } from "./store.js";
import { runnerZipToIpa } from "./wda-prepare.js";

describe("physical device store", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "jad-devices-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("starts every device with control off and persists the switch", async () => {
    const store = new PhysicalDeviceStore(home);
    await store.load();
    expect(store.isControlEnabled("android:serial:R58M123ABC")).toBe(false);
    await store.setControlEnabled("android:serial:R58M123ABC", true, 1_793_000_000_000);
    const reloaded = new PhysicalDeviceStore(home);
    await reloaded.load();
    expect(reloaded.isControlEnabled("android:serial:R58M123ABC")).toBe(true);
    expect(JSON.parse(await readFile(path.join(home, "devices", "physical.json"), "utf8"))).toEqual(
      {
        version: 1,
        devices: {
          "android:serial:R58M123ABC": {
            controlEnabled: true,
            updatedAt_ms: 1_793_000_000_000,
            wda: null,
          },
        },
      },
    );
  });
});

describe("JPEG stream splitter", () => {
  it("cuts frames on SOI/EOI across chunks and drops junk between them", () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0x00, 3, 0xff, 0xd9]);
    const b = Buffer.from([0xff, 0xd8, 4, 0xff, 0xd9]);
    const stream = Buffer.concat([Buffer.from("--boundary\r\n"), a, Buffer.from("\r\n"), b]);
    const splitter = new JpegStreamSplitter();
    const frames = [
      ...splitter.push(stream.subarray(0, 15)),
      ...splitter.push(stream.subarray(15)),
    ];
    expect(frames).toEqual([a, b]);
  });
});

describe("WebDriverAgent packaging", () => {
  it("moves the runner app under Payload/ and leaves debug symbols out", () => {
    const zip = zipSync({
      "WebDriverAgentRunner-Runner.app/Info.plist": new Uint8Array([1]),
      "WebDriverAgentRunner-Runner.app/PlugIns/WebDriverAgentRunner.xctest/WebDriverAgentRunner":
        new Uint8Array([2]),
      "WebDriverAgentRunner-Runner.app/PlugIns/WebDriverAgentRunner.xctest.dSYM/Contents/Info.plist":
        new Uint8Array([3]),
    });
    expect(Object.keys(unzipSync(runnerZipToIpa(zip))).sort()).toEqual([
      "Payload/WebDriverAgentRunner-Runner.app/Info.plist",
      "Payload/WebDriverAgentRunner-Runner.app/PlugIns/WebDriverAgentRunner.xctest/WebDriverAgentRunner",
    ]);
  });
});
