import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseConnectionOfferFromUrl } from "@jagentdesk/protocol/connection-offer";
import { generateLocalPairingOffer } from "./pairing-offer.js";
import { DEFAULT_RELAY_ENDPOINT } from "./config.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function createHome() {
  const dir = await mkdtemp(path.join(tmpdir(), "jad-relay-offer-"));
  homes.push(dir);
  return dir;
}

test("issues a relay-only pairing link when Tailscale is offline", async () => {
  const pairing = await generateLocalPairingOffer({
    jagentdeskHome: await createHome(),
    relayEnabled: true,
    relayEndpoint: DEFAULT_RELAY_ENDPOINT,
    includeQr: false,
  });
  expect(pairing.tailnetEnabled).toBe(false);
  expect(pairing.relayEnabled).toBe(true);
  const offer = parseConnectionOfferFromUrl(pairing.url!);
  expect(offer?.tailnetAddress).toBeUndefined();
  expect(offer?.relay).toEqual({ endpoint: "desk-relay.jagents.workers.dev", useTls: true });
  expect(Buffer.from(offer!.daemonPublicKeyB64, "base64").length).toBe(32);
});

test("keeps both pairing routes and an explicit unencrypted local relay endpoint", async () => {
  const pairing = await generateLocalPairingOffer({
    jagentdeskHome: await createHome(),
    tailnetAddress: "100.64.0.1:8765",
    relayEnabled: true,
    relayEndpoint: "127.0.0.1:12345",
    relayUseTls: false,
    includeQr: false,
  });
  const offer = parseConnectionOfferFromUrl(pairing.url!);
  expect(offer?.tailnetAddress).toBe("100.64.0.1:8765");
  expect(offer?.relay).toEqual({ endpoint: "127.0.0.1:12345", useTls: false });
});

test("disabling relay omits its route and produces no link when Tailscale is offline", async () => {
  const jagentdeskHome = await createHome();
  const pairing = await generateLocalPairingOffer({
    jagentdeskHome,
    tailnetAddress: "100.64.0.1:8765",
    relayEnabled: false,
    relayEndpoint: DEFAULT_RELAY_ENDPOINT,
    includeQr: false,
  });
  expect(parseConnectionOfferFromUrl(pairing.url!)?.relay).toBeUndefined();
  const offline = await generateLocalPairingOffer({ jagentdeskHome, relayEnabled: false });
  expect(offline.url).toBeNull();
  expect(offline.qr).toBeNull();
  expect(offline.relayEnabled).toBe(false);
});
