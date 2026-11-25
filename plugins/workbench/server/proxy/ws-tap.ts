// A minimal WebSocket frame parser used to observe (not modify) frames passing through the proxy
// tunnel, so the Workbench can show a WebSockets history like Burp. It handles text/binary data
// frames (opcodes 1/2), masking, and the 3 payload-length encodings; control frames (ping/pong/
// close) and continuation are ignored for display. Bytes are still forwarded verbatim by the caller.

export interface WsFrame {
  opcode: number;
  payload: Buffer;
}

export class WsFrameParser {
  private buf: Buffer = Buffer.alloc(0);

  // Feed raw bytes; returns any complete data frames found so far.
  push(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: WsFrame[] = [];
    for (;;) {
      const frame = this.tryParseOne();
      if (!frame) break;
      if (frame.opcode === 1 || frame.opcode === 2) frames.push(frame);
    }
    // Bound memory if a peer sends a huge/non-WS stream we can't parse.
    if (this.buf.length > 8 * 1024 * 1024) this.buf = Buffer.alloc(0);
    return frames;
  }

  private tryParseOne(): WsFrame | null {
    const b = this.buf;
    if (b.length < 2) return null;
    const opcode = b[0]! & 0x0f;
    const masked = (b[1]! & 0x80) !== 0;
    let len = b[1]! & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      // Only the low 32 bits are realistically needed for captured frames.
      len = Number(b.readBigUInt64BE(offset));
      offset += 8;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      maskKey = b.subarray(offset, offset + 4);
      offset += 4;
    }
    if (b.length < offset + len) return null;
    const raw = b.subarray(offset, offset + len);
    const payload = Buffer.from(raw);
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i % 4]!;
    }
    this.buf = b.subarray(offset + len);
    return { opcode, payload };
  }
}
