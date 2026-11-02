import net from "node:net";
import { ProxyError } from "./proxy-error.js";

export interface ProxyDeadline {
  readonly timeoutMs: number;
  remainingMs(): number;
}

export function createProxyDeadline(timeoutMs: number): ProxyDeadline {
  const endAtMs = Date.now() + timeoutMs;
  return {
    timeoutMs,
    remainingMs: () => Math.max(1, endAtMs - Date.now()),
  };
}

const HEAD_DELIMITER = "\r\n\r\n";
const MAX_HEAD_BYTES = 32 * 1024;

/**
 * Framed reads for a proxy handshake. SOCKS5 steps read exact byte counts;
 * HTTP CONNECT reads until the head terminator. Whatever arrives past the
 * handshake goes back into the socket (`pushBackLeftover`) so ssh2 reads the
 * server version string from byte zero.
 */
export class ProxySocketReader {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly socket: net.Socket,
    private readonly deadline: ProxyDeadline,
  ) {}

  async readBytes(count: number, closedError: () => ProxyError): Promise<Buffer> {
    while (this.buffer.length < count) {
      const chunk = await this.nextChunk();
      if (chunk === null) throw closedError();
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    const result = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return result;
  }

  async readHead(closedError: () => ProxyError): Promise<string> {
    let searchFrom = 0;
    for (;;) {
      const end = this.buffer.indexOf(HEAD_DELIMITER, searchFrom, "latin1");
      if (end !== -1) {
        const head = this.buffer.subarray(0, end).toString("latin1");
        this.buffer = this.buffer.subarray(end + HEAD_DELIMITER.length);
        return head;
      }
      if (this.buffer.length > MAX_HEAD_BYTES) {
        throw new ProxyError("proxy_refused", "proxy sent an oversized response head");
      }
      searchFrom = Math.max(0, this.buffer.length - HEAD_DELIMITER.length + 1);
      const chunk = await this.nextChunk();
      if (chunk === null) throw closedError();
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
  }

  pushBackLeftover(): void {
    if (this.buffer.length > 0) {
      this.socket.unshift(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
  }

  private nextChunk(): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("end", onEnd);
        this.socket.off("close", onClose);
        this.socket.off("error", onError);
        this.socket.off("timeout", onTimeout);
        this.socket.setTimeout(0);
      };
      const onData = (chunk: Buffer) => {
        cleanup();
        resolve(chunk);
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const onClose = () => {
        cleanup();
        resolve(null);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(
          new ProxyError(
            "proxy_unreachable",
            `proxy socket failed while awaiting its reply: ${error.message}`,
          ),
        );
      };
      const onTimeout = () => {
        cleanup();
        reject(
          new ProxyError(
            "proxy_unreachable",
            `proxy did not respond within ${this.deadline.timeoutMs}ms`,
          ),
        );
      };
      this.socket.setTimeout(this.deadline.remainingMs());
      this.socket.once("data", onData);
      this.socket.once("end", onEnd);
      this.socket.once("close", onClose);
      this.socket.once("error", onError);
      this.socket.once("timeout", onTimeout);
    });
  }
}
