import { WebSocket } from "ws";

// The fake plugin speaks the daemon side of the JAgentDesk Figma Link protocol
// (see ../protocol.ts): hello → pairing frames → request/response. Tests drive
// it against a real FigmaLinkServer bound to an ephemeral port — no network
// beyond loopback, no Figma, no mocks of our own classes.

export interface FakePluginOptions {
  /** ws://127.0.0.1:<port>/ws */
  url: string;
  name?: string;
  version?: string;
  protocol?: number;
  fileKey?: string;
  fileName?: string;
  pairingId?: string;
  pairingKey?: string;
  /** Sent as the WebSocket Origin header ("null" is what the real plugin iframe presents). */
  origin?: string;
}

export interface FakeRequestFrame {
  type: "request";
  requestId: string;
  toolName: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
}

export interface ToolReply {
  ok?: boolean;
  message?: string;
  data?: unknown;
}

type Listener = (frame: Record<string, unknown>) => void;

export class FakePlugin {
  readonly requests: FakeRequestFrame[] = [];
  readonly received: Array<Record<string, unknown>> = [];
  /** Canned replies per tool name; fall back to `{ ok: true, message: "ok", data: {} }`. */
  private readonly replies = new Map<
    string,
    ToolReply | ((request: FakeRequestFrame) => ToolReply)
  >();
  private readonly listeners: Listener[] = [];
  private socket?: WebSocket;

  constructor(private readonly options: FakePluginOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.options.url, {
        headers: this.options.origin === undefined ? undefined : { Origin: this.options.origin },
      });
      this.socket = socket;
      socket.on("open", () => resolve());
      socket.on("error", reject);
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type === "request") {
          const request = frame as unknown as FakeRequestFrame;
          this.requests.push(request);
          void this.answer(request);
          return;
        }
        this.received.push(frame);
        for (const listener of this.listeners) listener(frame);
      });
    });
  }

  /** Program the reply for one tool (a function gets the request to build dynamic data). */
  respond(toolName: string, reply: ToolReply | ((request: FakeRequestFrame) => ToolReply)): void {
    this.replies.set(toolName, reply);
  }

  hello(): void {
    this.send({
      type: "hello",
      name: this.options.name ?? "JAgentDesk Figma Link",
      version: this.options.version ?? "1.0.0",
      protocol: this.options.protocol ?? 1,
      fileKey: this.options.fileKey ?? "fk-1",
      fileName: this.options.fileName ?? "Design file",
      manager: "Marie",
      ...(this.options.pairingId ? { pairingId: this.options.pairingId } : {}),
      ...(this.options.pairingKey ? { pairingKey: this.options.pairingKey } : {}),
    });
  }

  send(frame: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(frame));
  }

  /** Push a document status (what the plugin sends on documentchange/selectionchange). */
  pluginStatus(overrides: Record<string, unknown> = {}): void {
    this.send({
      type: "plugin_status",
      connected: true,
      fileName: this.options.fileName ?? "Design file",
      fileKey: this.options.fileKey ?? "fk-1",
      pageCount: 1,
      currentPage: "Page 1",
      hasSelection: false,
      selectionCount: 0,
      selectionTypes: [],
      selectionNodes: [],
      lastUpdatedAt: Date.now(),
      ...overrides,
    });
  }

  /** Resolve with the next frame of `type` already buffered or still to arrive. */
  nextFrame(type: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const buffered = this.received.find((frame) => frame.type === type);
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for a "${type}" frame`)),
        timeoutMs,
      );
      const listener: Listener = (frame) => {
        if (frame.type !== type) return;
        clearTimeout(timer);
        this.listeners.splice(this.listeners.indexOf(listener), 1);
        resolve(frame);
      };
      this.listeners.push(listener);
    });
  }

  /** Every frame of `type` received so far. */
  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.received.filter((frame) => frame.type === type);
  }

  /** Resolves with the close code once the server closes this connection. */
  closed(): Promise<number> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve(1006);
      if (this.socket.readyState === WebSocket.CLOSED) return resolve(1006);
      this.socket.on("close", (closeCode) => resolve(closeCode));
    });
  }

  get readyState(): number {
    return this.socket?.readyState ?? WebSocket.CLOSED;
  }

  async close(): Promise<void> {
    this.socket?.close();
    await new Promise<void>((resolve) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) resolve();
      else this.socket.on("close", () => resolve());
    });
  }

  private async answer(request: FakeRequestFrame): Promise<void> {
    // Let tests observe the request before the response lands.
    await new Promise((resolve) => setImmediate(resolve));
    const canned = this.replies.get(request.toolName);
    const reply = typeof canned === "function" ? canned(request) : canned;
    this.send({
      type: "response",
      requestId: request.requestId,
      ok: reply?.ok ?? true,
      message: reply?.message ?? "ok",
      data: reply?.data ?? {},
    });
  }
}

export function linkUrl(port: number): string {
  return `ws://${"127.0.0.1"}:${port}/ws`;
}
