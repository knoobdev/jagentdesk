import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { SasPairing, ephemeralKey, type SasPairingLogger } from "./sas.js";
import { createPairedDeviceStore, type PairedDeviceStore } from "./paired-devices.js";
import { exportDevicePublicKey, generateDeviceKeyPair } from "./device-signature-crypto.js";

const address = { serverId: "server", host: "", ip: "127.0.0.1", port: 8765 };
let home: string;
let devices: PairedDeviceStore;
let events: SessionOutboundMessage[];
let logs: Array<{ level: string; message: string; fields: Record<string, unknown> }>;
let sas: SasPairing;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jad-sas-reasons-"));
  devices = createPairedDeviceStore({ jagentdeskHome: home });
  events = [];
  logs = [];
  const logger: SasPairingLogger = {
    info: (fields, message) => logs.push({ level: "info", message, fields }),
    warn: (fields, message) => logs.push({ level: "warn", message, fields }),
  };
  sas = new SasPairing(devices, (message) => events.push(message), logger);
});
afterEach(async () => {
  sas.cancel();
  vi.useRealTimers();
  await rm(home, { recursive: true, force: true });
});

function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  return {
    sent,
    closes,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close(code?: number, reason?: string) {
      closes.push({ code, reason });
    },
  };
}
function hello(pk: string, label = "Phone") {
  return {
    type: "pair_hello",
    pk,
    pk_client: ephemeralKey().publicKey.toString("base64url"),
    nonce_client: Buffer.alloc(32, 3).toString("base64url"),
    publicKeyEd25519: exportDevicePublicKey(generateDeviceKeyPair().publicKey),
    label,
    kind: "mobile",
  };
}
const cancelReasons = () =>
  events.flatMap((e) =>
    e.type === "pairing.sas.changed" && e.payload.state === "cancelled" ? [e.payload.reason] : [],
  );

test("a link replaced by a newer begin() is refused as replaced, not as a generic failure", () => {
  const first = sas.begin(address);
  sas.begin(address);
  const phone = fakeSocket();
  sas.handle(phone, hello(first.pk));
  expect(phone.sent).toEqual([{ type: "pair_error", code: "pairing_expired", reason: "replaced" }]);
  expect(phone.closes).toEqual([{ code: 1008, reason: "Pairing failed" }]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      message: "pairing_sas_refused",
      fields: expect.objectContaining({ step: "hello", reason: "replaced" }),
    }),
  );
});

test("begin() while a device is comparing tells that device the link was replaced", () => {
  const first = sas.begin(address);
  const phone = fakeSocket();
  sas.handle(phone, hello(first.pk));
  expect(phone.sent[0]).toMatchObject({ type: "pair_challenge" });
  sas.begin(address);
  expect(phone.sent[1]).toEqual({
    type: "pair_error",
    code: "pairing_expired",
    reason: "replaced",
  });
  expect(phone.closes).toHaveLength(1);
  expect(cancelReasons()).toEqual(["replaced"]);
});

test("a second device on the same link gets in_use and the first still completes", () => {
  const offer = sas.begin(address);
  const first = fakeSocket();
  const second = fakeSocket();
  sas.handle(first, hello(offer.pk, "First"));
  sas.handle(second, hello(offer.pk, "Second"));
  expect(second.sent).toEqual([{ type: "pair_error", code: "pairing_in_use", reason: "in_use" }]);
  expect(first.closes).toEqual([]);
  sas.confirm(offer.pk, true);
  sas.handle(first, { type: "pair_confirm", pk: offer.pk, accepted: true });
  expect(first.sent.at(-1)).toMatchObject({ type: "pair_done" });
  expect(devices.list()).toEqual([expect.objectContaining({ deviceName: "First" })]);
});

test("a duplicate hello on the socket that owns the attempt is ignored", () => {
  const offer = sas.begin(address);
  const phone = fakeSocket();
  sas.handle(phone, hello(offer.pk));
  sas.handle(phone, hello(offer.pk));
  expect(phone.sent.map((m) => m.type)).toEqual(["pair_challenge"]);
  expect(phone.closes).toEqual([]);
  expect(cancelReasons()).toEqual([]);
});

test("a dropped pairing socket ends the attempt as connection_lost and a rescan says so", () => {
  const offer = sas.begin(address);
  const phone = fakeSocket();
  sas.handle(phone, hello(offer.pk));
  sas.disconnected(phone, { code: 1006 });
  expect(cancelReasons()).toEqual(["connection_lost"]);
  // The socket is gone: nothing is sent on it.
  expect(phone.sent.map((m) => m.type)).toEqual(["pair_challenge"]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      message: "pairing_sas_socket_closed",
      fields: expect.objectContaining({ code: 1006 }),
    }),
  );
  const rescan = fakeSocket();
  sas.handle(rescan, hello(offer.pk));
  expect(rescan.sent).toEqual([
    { type: "pair_error", code: "pairing_expired", reason: "connection_lost" },
  ]);
});

test("host cancel, device decline, completion and unknown links each carry their reason", () => {
  const cancelled = sas.begin(address);
  const phone = fakeSocket();
  sas.handle(phone, hello(cancelled.pk));
  sas.confirm(cancelled.pk, false);
  expect(phone.sent.at(-1)).toEqual({
    type: "pair_error",
    code: "pairing_expired",
    reason: "host_cancelled",
  });

  const declined = sas.begin(address);
  const decliner = fakeSocket();
  sas.handle(decliner, hello(declined.pk));
  sas.handle(decliner, { type: "pair_confirm", pk: declined.pk, accepted: false });

  const done = sas.begin(address);
  const pairer = fakeSocket();
  sas.handle(pairer, hello(done.pk));
  sas.confirm(done.pk, true);
  sas.handle(pairer, { type: "pair_confirm", pk: done.pk, accepted: true });
  const late = fakeSocket();
  sas.handle(late, hello(done.pk));
  expect(late.sent).toEqual([{ type: "pair_error", code: "pairing_expired", reason: "completed" }]);

  const stranger = fakeSocket();
  sas.handle(stranger, hello(ephemeralKey().publicKey.toString("base64url")));
  expect(stranger.sent).toEqual([
    { type: "pair_error", code: "pairing_expired", reason: "unknown_link" },
  ]);
  expect(cancelReasons()).toEqual(["host_cancelled", "client_cancelled"]);
});

test("the 120 s window expires with reason expired on both sides", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
  const offer = sas.begin(address);
  const phone = fakeSocket();
  sas.handle(phone, hello(offer.pk));
  vi.advanceTimersByTime(120_001);
  expect(phone.sent.at(-1)).toEqual({
    type: "pair_error",
    code: "pairing_expired",
    reason: "expired",
  });
  expect(cancelReasons()).toEqual(["expired"]);
  const late = fakeSocket();
  sas.handle(late, hello(offer.pk));
  expect(late.sent).toEqual([{ type: "pair_error", code: "pairing_expired", reason: "expired" }]);
});

test("a bad device key is refused as bad_key", () => {
  const offer = sas.begin(address);
  const phone = fakeSocket();
  sas.handle(phone, { ...hello(offer.pk), publicKeyEd25519: "AAAA" });
  expect(phone.sent).toEqual([{ type: "pair_error", code: "pairing_bad_key", reason: "bad_key" }]);
});

test("the error reaches an async (encrypted relay) socket before its close", async () => {
  const offer = sas.begin(address);
  sas.begin(address);
  const order: string[] = [];
  let release: () => void = () => {};
  const relaySocket = {
    send: () => {
      order.push("send");
      return new Promise<void>((resolve) => {
        release = () => {
          order.push("sent");
          resolve();
        };
      });
    },
    close: () => order.push("close"),
  };
  sas.handle(relaySocket, hello(offer.pk));
  expect(order).toEqual(["send"]);
  release();
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["send", "sent", "close"]);
});

test("pairing logs every step without keys, nonces, codes or pks", () => {
  const offer = sas.begin(address);
  const phone = fakeSocket();
  const message = hello(offer.pk);
  sas.handle(phone, message, undefined, "relay");
  sas.confirm(offer.pk, true);
  sas.handle(phone, { type: "pair_confirm", pk: offer.pk, accepted: true });
  const code = events.flatMap((e) =>
    e.type === "pairing.sas.changed" && e.payload.code ? [e.payload.code] : [],
  )[0]!;
  expect(logs.map((l) => l.message)).toEqual([
    "pairing_sas_begin",
    "pairing_sas_hello_accepted",
    "pairing_sas_confirm",
    "pairing_sas_confirm",
    "pairing_sas_completed",
  ]);
  const text = JSON.stringify(logs);
  for (const secret of [
    offer.pk,
    message.pk_client,
    message.nonce_client,
    message.publicKeyEd25519,
    String(phone.sent[0]!.nonce_host),
    code,
  ])
    expect(text).not.toContain(secret);
});

describe("re-pairing a device key that is already registered", () => {
  function registeredHello(pk: string, label: string) {
    return { ...hello(pk, label), publicKeyEd25519: existingKey };
  }
  let existingKey: string;
  let existingId: string;
  beforeEach(() => {
    existingKey = exportDevicePublicKey(generateDeviceKeyPair().publicKey);
    existingId = devices.register({
      devicePublicKeyB64: existingKey,
      deviceName: "Old name",
      kind: "mobile",
    }).deviceId;
  });
  const completed = () =>
    events.flatMap((e) =>
      e.type === "pairing.sas.changed" && e.payload.state === "completed" ? [e.payload] : [],
    );

  test("phone confirms last: renews the record instead of failing", () => {
    const offer = sas.begin(address);
    const phone = fakeSocket();
    sas.handle(phone, registeredHello(offer.pk, "iPhone"));
    sas.confirm(offer.pk, true);
    sas.handle(phone, { type: "pair_confirm", pk: offer.pk, accepted: true });
    expect(phone.sent.at(-1)).toEqual({ type: "pair_done", deviceId: existingId, repaired: true });
    expect(phone.sent.some((m) => m.type === "pair_error")).toBe(false);
    expect(completed()).toEqual([expect.objectContaining({ repaired: true })]);
    expect(devices.list()).toEqual([
      expect.objectContaining({ deviceId: existingId, deviceName: "iPhone", kind: "mobile" }),
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: "pairing_sas_completed",
        fields: expect.objectContaining({ repaired: true }),
      }),
    );
  });

  test("host confirms last: renews the record and confirm does not throw", () => {
    const offer = sas.begin(address);
    const phone = fakeSocket();
    sas.handle(phone, registeredHello(offer.pk, "iPhone"));
    sas.handle(phone, { type: "pair_confirm", pk: offer.pk, accepted: true });
    expect(() => sas.confirm(offer.pk, true)).not.toThrow();
    expect(phone.sent.at(-1)).toEqual({ type: "pair_done", deviceId: existingId, repaired: true });
    expect(completed()).toEqual([expect.objectContaining({ repaired: true })]);
    expect(devices.list()).toHaveLength(1);
  });

  test("a new key still pairs as a new device without the repaired flag", () => {
    const offer = sas.begin(address);
    const phone = fakeSocket();
    sas.handle(phone, hello(offer.pk, "Other"));
    sas.confirm(offer.pk, true);
    sas.handle(phone, { type: "pair_confirm", pk: offer.pk, accepted: true });
    expect(phone.sent.at(-1)).toEqual({ type: "pair_done", deviceId: expect.any(String) });
    expect(completed()).toEqual([expect.not.objectContaining({ repaired: true })]);
    expect(devices.list()).toHaveLength(2);
  });
});

test("repair() keeps a tailnet pin unless the new pairing carries one", () => {
  const key = exportDevicePublicKey(generateDeviceKeyPair().publicKey);
  devices.register({ devicePublicKeyB64: key, tailnetNodeId: "node-a" });
  expect(devices.repair({ devicePublicKeyB64: key }).device.tailnetNodeId).toBe("node-a");
  expect(devices.repair({ devicePublicKeyB64: key, tailnetNodeId: "node-b" }).device).toMatchObject(
    { tailnetNodeId: "node-b" },
  );
  expect(createPairedDeviceStore({ jagentdeskHome: home }).getByPublicKey(key)).toMatchObject({
    tailnetNodeId: "node-b",
  });
});
