import { describe, expect, it } from "vitest";
import { WsFrameParser } from "./ws-tap.js";

// Build a client→server (masked) or server→client (unmasked) text frame the way a browser / server
// would, then confirm the parser recovers the payload. This proves the WebSockets-history tap.
function textFrame(text: string, masked: boolean): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = [0x81]; // FIN + opcode 1 (text)
  if (payload.length < 126) header.push((masked ? 0x80 : 0) | payload.length);
  else {
    header.push((masked ? 0x80 : 0) | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  }
  if (!masked) return Buffer.concat([Buffer.from(header), payload]);
  const key = Buffer.from([1, 2, 3, 4]);
  const masked1 = Buffer.from(payload);
  for (let i = 0; i < masked1.length; i++) masked1[i] ^= key[i % 4]!;
  return Buffer.concat([Buffer.from(header), key, masked1]);
}

describe("WsFrameParser", () => {
  it("parses an unmasked (server→client) text frame", () => {
    const p = new WsFrameParser();
    const frames = p.push(textFrame("hello ws", false));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.opcode).toBe(1);
    expect(frames[0]!.payload.toString("utf8")).toBe("hello ws");
  });

  it("unmasks a client→server frame", () => {
    const p = new WsFrameParser();
    const frames = p.push(textFrame("secret=42", true));
    expect(frames[0]!.payload.toString("utf8")).toBe("secret=42");
  });

  it("handles a frame split across two chunks and back-to-back frames", () => {
    const p = new WsFrameParser();
    const whole = textFrame("abcdefghij", false);
    expect(p.push(whole.subarray(0, 3))).toHaveLength(0);
    const done = p.push(Buffer.concat([whole.subarray(3), textFrame("second", false)]));
    expect(done).toHaveLength(2);
    expect(done[0]!.payload.toString("utf8")).toBe("abcdefghij");
    expect(done[1]!.payload.toString("utf8")).toBe("second");
  });
});
