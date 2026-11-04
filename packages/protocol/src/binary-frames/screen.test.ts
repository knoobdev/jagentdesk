import { describe, expect, it } from "vitest";

import {
  FileTransferOpcode,
  ScreenFrameOpcode,
  TerminalStreamOpcode,
  decodeBinaryFrame,
  decodeScreenFrame,
  encodeScreenFrame,
} from "./index.js";

describe("screen binary frames", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);

  it("uses an opcode no other binary frame family uses", () => {
    expect(Object.values(TerminalStreamOpcode)).not.toContain(ScreenFrameOpcode);
    expect(Object.values(FileTransferOpcode)).not.toContain(ScreenFrameOpcode);
  });

  it("round-trips the fixed header and the JPEG bytes", () => {
    const encoded = encodeScreenFrame({
      subscriptionId: "screen-a1b2c3",
      seq: 4_000_000_001,
      width: 576,
      height: 1280,
      timestamp_ms: 1_793_000_000_123,
      jpeg,
    });
    expect(encoded[0]).toBe(0x20);
    expect(encoded.byteLength).toBe(2 + "screen-a1b2c3".length + 16 + jpeg.byteLength);
    expect(decodeScreenFrame(encoded)).toEqual({
      subscriptionId: "screen-a1b2c3",
      seq: 4_000_000_001,
      width: 576,
      height: 1280,
      timestamp_ms: 1_793_000_000_123,
      jpeg,
    });
  });

  it("is routed by the shared demux", () => {
    const encoded = encodeScreenFrame({
      subscriptionId: "s",
      seq: 1,
      width: 1,
      height: 1,
      timestamp_ms: 0,
      jpeg,
    });
    expect(decodeBinaryFrame(encoded)?.kind).toBe("screen");
  });

  it("rejects truncated frames", () => {
    const encoded = encodeScreenFrame({
      subscriptionId: "s",
      seq: 1,
      width: 1,
      height: 1,
      timestamp_ms: 0,
      jpeg,
    });
    expect(decodeScreenFrame(encoded.subarray(0, 10))).toBeNull();
    expect(decodeScreenFrame(new Uint8Array([0x20, 0]))).toBeNull();
  });
});
