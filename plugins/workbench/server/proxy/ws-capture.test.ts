import net from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { WorkbenchCA } from "./ca.js";
import { CaptureStore } from "./capture-store.js";
import { MitmProxy } from "./mitm-proxy.js";

// End-to-end WebSockets tap: a real ws server, a raw client that upgrades THROUGH the proxy, and an
// assertion that the proxy observed the client→server text frame (Burp WebSockets history).

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "wb-wscap-"));
const env = { ...process.env, JAGENTDESK_HOME: tmpHome } as NodeJS.ProcessEnv;
let wss: WebSocketServer;
let wsPort = 0;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  wsPort = (wss.address() as { port: number }).port;
});

afterAll(async () => {
  wss?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = [0x81, 0x80 | payload.length];
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4]!;
  return Buffer.concat([Buffer.from(header), key, masked]);
}

describe("WebSocket capture through the proxy", () => {
  it("observes a client→server frame tunneled through the proxy", async () => {
    const ca = new WorkbenchCA(env);
    const store = new CaptureStore();
    const seen: { direction: string; text: string }[] = [];
    const proxy = new MitmProxy({
      ca,
      sessionId: "ws",
      store,
      onTransaction: () => {},
      onWsMessage: (m) => seen.push({ direction: m.direction, text: m.payload.toString("utf8") }),
    });
    const port = await proxy.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1", () => {
          const key = randomBytes(16).toString("base64");
          sock.write(
            `GET / HTTP/1.1\r\nHost: 127.0.0.1:${wsPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
        });
        let handshakeDone = false;
        sock.on("data", (chunk) => {
          if (!handshakeDone && chunk.toString("latin1").includes("101")) {
            handshakeDone = true;
            sock.write(maskedTextFrame("hello-through-proxy"));
            setTimeout(() => {
              sock.destroy();
              resolve();
            }, 300);
          }
        });
        sock.on("error", reject);
        setTimeout(() => reject(new Error("ws handshake timeout")), 4000);
      });
      expect(
        seen.some((s) => s.direction === "to-server" && s.text === "hello-through-proxy"),
      ).toBe(true);
    } finally {
      await proxy.stop();
    }
  });
});
