import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createWebSocketTransportFactory } from "@jagentdesk/client/internal/daemon-client-transport";
import { SasPairing } from "./sas.js";
import { createPairedDeviceStore } from "./paired-devices.js";
import { exportDevicePublicKey, generateDeviceKeyPair } from "./device-signature-crypto.js";
import { pairAppDevice } from "../../../../app/src/pairing/sas-client.js";

test.each(["desktop", "mobile"] as const)(
  "%s app uses the F5 exchange over a real socket with two approvals and a node pin",
  async (kind) => {
    const home = await mkdtemp(join(tmpdir(), "int8-app-sas-"));
    const devices = createPairedDeviceStore({ jagentdeskHome: home });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.on("listening", resolve));
    let hostCode: string | undefined;
    const sas = new SasPairing(devices, (message) => {
      if (message.type === "pairing.sas.changed" && message.payload.code)
        hostCode = message.payload.code;
    });
    const offer = sas.begin({ serverId: "local", host: "", ip: "127.0.0.1", port: 8765 });
    server.on("connection", (socket) => {
      socket.on("message", (data) => sas.handle(socket, JSON.parse(String(data)), "verified-node"));
      socket.on("close", () => sas.disconnected(socket));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listening address");
    const transport = createWebSocketTransportFactory((url) => new WebSocket(url))({
      url: `ws://127.0.0.1:${address.port}`,
    });
    try {
      await pairAppDevice({
        transport,
        pk: offer.pk,
        publicKey: exportDevicePublicKey(generateDeviceKeyPair().publicKey),
        kind,
        label: kind,
        signal: new AbortController().signal,
        compare: async (code) => {
          await expect.poll(() => hostCode).toBe(code);
          expect(code).toMatch(/^\d{6}$/);
          expect(devices.list()).toEqual([]);
          sas.confirm(offer.pk, true);
          expect(devices.list()).toEqual([]);
          return true;
        },
      });
      expect(devices.list()).toEqual([
        expect.objectContaining({ kind, tailnetNodeId: "verified-node" }),
      ]);
    } finally {
      sas.cancel();
      transport.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
