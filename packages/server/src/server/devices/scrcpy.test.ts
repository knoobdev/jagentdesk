import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MotionAction,
  SCRCPY_SERVER_SHA256,
  SCRCPY_VERSION,
  ScrcpyVideoParser,
  encodeKeycode,
  encodeRotate,
  encodeText,
  encodeTouch,
  resolveScrcpyServer,
  scrcpyServerArgs,
} from "./scrcpy.js";

describe("scrcpy", () => {
  it("bundles the pinned, unmodified scrcpy-server", () => {
    const jar = resolveScrcpyServer();
    expect(jar).not.toBeNull();
    expect(jar?.endsWith(`scrcpy-server-v${SCRCPY_VERSION}`)).toBe(true);
    const digest = createHash("sha256")
      .update(readFileSync(jar ?? ""))
      .digest("hex");
    expect(digest).toBe(SCRCPY_SERVER_SHA256);
  });

  it("starts the server with the pinned version, H.264, ≤ 1280 px and ≤ 15 fps", () => {
    const args = scrcpyServerArgs("0a1b2c3d");
    expect(args.slice(0, 5)).toEqual([
      "CLASSPATH=/data/local/tmp/jagentdesk-scrcpy-server.jar",
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      "5.0.1",
    ]);
    expect(args).toContain("scid=0a1b2c3d");
    expect(args).toContain("tunnel_forward=true");
    expect(args).toContain("video_codec=h264");
    expect(args).toContain("max_size=1280");
    expect(args).toContain("max_fps=15");
    expect(args).toContain("audio=false");
  });

  it("encodes a touch event as the 32-byte INJECT_TOUCH_EVENT", () => {
    const message = encodeTouch({
      action: MotionAction.Down,
      x: 100,
      y: 200,
      width: 576,
      height: 1280,
    });
    expect(message.length).toBe(32);
    expect(message.readUInt8(0)).toBe(2);
    expect(message.readUInt8(1)).toBe(0);
    expect(message.readBigInt64BE(2)).toBe(-2n);
    expect(message.readInt32BE(10)).toBe(100);
    expect(message.readInt32BE(14)).toBe(200);
    expect(message.readUInt16BE(18)).toBe(576);
    expect(message.readUInt16BE(20)).toBe(1280);
    expect(message.readUInt16BE(22)).toBe(0xffff);
    const up = encodeTouch({ action: MotionAction.Up, x: 100, y: 200, width: 576, height: 1280 });
    expect(up.readUInt16BE(22)).toBe(0);
  });

  it("encodes keycodes, text and rotation", () => {
    const key = encodeKeycode(1, 3);
    expect([...key]).toEqual([0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
    const [text] = encodeText("héllo");
    expect(text.readUInt8(0)).toBe(1);
    expect(text.readUInt32BE(1)).toBe(Buffer.byteLength("héllo"));
    expect(text.subarray(5).toString("utf8")).toBe("héllo");
    expect(encodeText("x".repeat(301))).toHaveLength(2);
    expect([...encodeRotate()]).toEqual([11]);
  });

  it("parses codec id, session and media packets across chunk boundaries", () => {
    const codec = Buffer.alloc(4);
    codec.writeUInt32BE(0x68323634);
    const session = Buffer.alloc(12);
    session.writeUInt32BE(0x80000000, 0);
    session.writeUInt32BE(576, 4);
    session.writeUInt32BE(1280, 8);
    const config = Buffer.alloc(12 + 3);
    config.writeBigUInt64BE(1n << 62n, 0);
    config.writeUInt32BE(3, 8);
    config.set([0, 0, 1], 12);
    const media = Buffer.alloc(12 + 4);
    media.writeBigUInt64BE((1n << 61n) | 1234n, 0);
    media.writeUInt32BE(4, 8);
    media.set([9, 8, 7, 6], 12);
    const stream = Buffer.concat([codec, session, config, media]);
    const parser = new ScrcpyVideoParser();
    const events = [
      ...parser.push(stream.subarray(0, 3)),
      ...parser.push(stream.subarray(3, 20)),
      ...parser.push(stream.subarray(20)),
    ];
    expect(events).toEqual([
      { type: "codec", codecId: 0x68323634 },
      { type: "session", width: 576, height: 1280 },
      { type: "packet", config: true, keyFrame: false, data: Buffer.from([0, 0, 1]) },
      { type: "packet", config: false, keyFrame: true, data: Buffer.from([9, 8, 7, 6]) },
    ]);
  });
});
