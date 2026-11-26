import type { RelaySocketLike } from "./relay-transport.js";

/**
 * Per-connection frame counts for one relay data socket, logged when it closes.
 *
 * A phone that connects over the relay and never sends its signed hello leaves
 * the daemon with only "challenge issued" and "client disconnected". The counts
 * tell the cases apart without reading payloads: E2EE hellos that keep arriving
 * after the daemon's ready mean the client never accepted the ready; encrypted
 * records in mean the client did send after the handshake; none means it stopped
 * before replying to the challenge.
 */
export interface RelayFrameTally {
  summary(): RelayFrameSummary;
}

export interface RelayFrameSummary {
  openMs: number;
  in: {
    e2eeHellos: number;
    /** ms after open of each inbound E2EE hello (first 8). */
    e2eeHelloAtMs: number[];
    records: number;
    recordBytes: number;
    /** Relay control frames (ownership challenge and similar); counted by type. */
    control: Record<string, number>;
    firstRecordAtMs: number | null;
    lastAtMs: number | null;
  };
  out: {
    e2eeReadies: number;
    records: number;
    recordBytes: number;
    lastAtMs: number | null;
  };
}

const MAX_HELLO_TIMES = 8;
const MAX_CONTROL_TYPES = 8;

/** Reads the `type` of a plaintext JSON frame. Encrypted records are base64 or binary. */
function plaintextType(text: string): string | null {
  if (!text.startsWith('{"type":"')) return null;
  const end = text.indexOf('"', 9);
  if (end === -1 || end - 9 > 40) return null;
  return text.slice(9, end);
}

function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  return null;
}

function frameBytes(data: unknown): number {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + frameBytes(part), 0);
  return 0;
}

/**
 * Starts counting frames on `socket`. Must run before the socket is handed to the
 * ownership guard so outbound frames written through it are counted too.
 */
export function tallyRelayFrames(
  socket: RelaySocketLike,
  now: () => number = Date.now,
): RelayFrameTally {
  const openedAt = now();
  const summary: RelayFrameSummary = {
    openMs: 0,
    in: {
      e2eeHellos: 0,
      e2eeHelloAtMs: [],
      records: 0,
      recordBytes: 0,
      control: {},
      firstRecordAtMs: null,
      lastAtMs: null,
    },
    out: { e2eeReadies: 0, records: 0, recordBytes: 0, lastAtMs: null },
  };

  socket.on("message", (...args: unknown[]) => {
    const data = args[0];
    const isBinary = args[1] === true;
    const at = now() - openedAt;
    summary.in.lastAtMs = at;
    const text = isBinary ? null : frameText(Buffer.isBuffer(data) ? data.toString("utf8") : data);
    const type = text ? plaintextType(text) : null;
    if (type === "e2ee_hello") {
      summary.in.e2eeHellos += 1;
      if (summary.in.e2eeHelloAtMs.length < MAX_HELLO_TIMES) summary.in.e2eeHelloAtMs.push(at);
      return;
    }
    if (type) {
      const known = type in summary.in.control;
      if (known || Object.keys(summary.in.control).length < MAX_CONTROL_TYPES)
        summary.in.control[type] = (summary.in.control[type] ?? 0) + 1;
      return;
    }
    summary.in.records += 1;
    summary.in.recordBytes += frameBytes(data);
    summary.in.firstRecordAtMs ??= at;
  });

  const send = socket.send.bind(socket);
  socket.send = (data, callback) => {
    summary.out.lastAtMs = now() - openedAt;
    const type = typeof data === "string" ? plaintextType(data) : null;
    if (type === "e2ee_ready") summary.out.e2eeReadies += 1;
    else if (!type) {
      summary.out.records += 1;
      summary.out.recordBytes += frameBytes(data);
    }
    return send(data, callback);
  };

  return {
    summary() {
      return { ...summary, openMs: now() - openedAt };
    },
  };
}
