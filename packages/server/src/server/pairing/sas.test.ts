import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { SasPairing, ephemeralKey, sasCode } from "./sas.js";
import { createPairedDeviceStore } from "./paired-devices.js";
import { exportDevicePublicKey, generateDeviceKeyPair } from "./device-signature-crypto.js";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
test("both peers derive the same SAS and neither single confirmation grants trust", async () => {
  const home = await mkdtemp(join(tmpdir(), "jad-sas-"));
  homes.push(home);
  const devices = createPairedDeviceStore({ jagentdeskHome: home });
  const events: SessionOutboundMessage[] = [];
  const sas = new SasPairing(devices, (message) => {
    events.push(message);
  });
  const offer = sas.begin({ serverId: "server", host: "", ip: "127.0.0.1", port: 8765 });
  const messages: string[] = [];
  const socket = {
    send(data: string) {
      messages.push(data);
    },
    close() {},
  };
  const client = ephemeralKey();
  const pk = client.publicKey.toString("base64url");
  const nonce = Buffer.alloc(32, 9).toString("base64url");
  const device = generateDeviceKeyPair();
  expect(
    sas.handle(
      socket,
      {
        type: "pair_hello",
        pk: offer.pk,
        pk_client: pk,
        nonce_client: nonce,
        publicKeyEd25519: exportDevicePublicKey(device.publicKey),
        kind: "daemon",
        label: "A",
      },
      "node-a",
    ),
  ).toBe(true);
  const challenge = JSON.parse(messages[0]!);
  const event = events.find(
    (message) => message.type === "pairing.sas.changed" && message.payload.state === "comparing",
  );
  expect(event).toMatchObject({
    payload: {
      code: sasCode(client.privateKey, offer.pk, nonce, challenge.nonce_host, pk, offer.pk),
    },
  });
  sas.confirm(offer.pk, true);
  expect(devices.list()).toEqual([]);
  sas.handle(socket, { type: "pair_confirm", pk: offer.pk, accepted: true });
  expect(devices.list()).toEqual([
    expect.objectContaining({ kind: "daemon", tailnetNodeId: "node-a" }),
  ]);
  sas.cancel();
});
