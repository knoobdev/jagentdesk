// Live device screen frames (spec 27.5, 27.7, ADR-0033). One binary WebSocket frame per JPEG:
//
//   u8  opcode (0x20)
//   u8  subscriptionId byte length (1..255)
//   …   subscriptionId (UTF-8)
//   u32 seq            (big endian, per subscription, starts at 1)
//   u16 width, u16 height (pixels of this JPEG)
//   f64 timestamp_ms   (Unix UTC milliseconds the daemon captured the frame)
//   …   JPEG bytes
//
// Only sent to clients that advertise CLIENT_CAPS.binaryScreenFrames.

export const ScreenFrameOpcode = 0x20;

export interface ScreenFrame {
  subscriptionId: string;
  seq: number;
  width: number;
  height: number;
  timestamp_ms: number;
  jpeg: Uint8Array;
}

const FIXED_AFTER_ID = 4 + 2 + 2 + 8;

export function encodeScreenFrame(frame: ScreenFrame): Uint8Array {
  const id = new TextEncoder().encode(frame.subscriptionId);
  if (id.byteLength === 0 || id.byteLength > 0xff) {
    throw new RangeError("Screen frame subscriptionId must be 1..255 bytes");
  }
  const headerLength = 2 + id.byteLength + FIXED_AFTER_ID;
  const bytes = new Uint8Array(headerLength + frame.jpeg.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[0] = ScreenFrameOpcode;
  bytes[1] = id.byteLength;
  bytes.set(id, 2);
  let offset = 2 + id.byteLength;
  view.setUint32(offset, frame.seq >>> 0);
  offset += 4;
  view.setUint16(offset, frame.width);
  offset += 2;
  view.setUint16(offset, frame.height);
  offset += 2;
  view.setFloat64(offset, frame.timestamp_ms);
  offset += 8;
  bytes.set(frame.jpeg, offset);
  return bytes;
}

export function decodeScreenFrame(bytes: Uint8Array): ScreenFrame | null {
  if (bytes.byteLength < 2 || bytes[0] !== ScreenFrameOpcode) {
    return null;
  }
  const idLength = bytes[1];
  const headerLength = 2 + idLength + FIXED_AFTER_ID;
  if (idLength === 0 || bytes.byteLength < headerLength) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const subscriptionId = new TextDecoder().decode(bytes.subarray(2, 2 + idLength));
  let offset = 2 + idLength;
  const seq = view.getUint32(offset);
  offset += 4;
  const width = view.getUint16(offset);
  offset += 2;
  const height = view.getUint16(offset);
  offset += 2;
  const timestamp_ms = view.getFloat64(offset);
  offset += 8;
  return { subscriptionId, seq, width, height, timestamp_ms, jpeg: bytes.subarray(offset) };
}
