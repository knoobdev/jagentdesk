import { describe, expect, it } from "vitest";

import {
  ConnectionOfferSchema,
  decodeOfferFragmentPayload,
  parseConnectionOfferFromUrl,
} from "./connection-offer.js";

function encodeBase64UrlNoPadUtf8(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("connection offer", () => {
  it("decodes base64url JSON payloads", () => {
    const payload = {
      v: 3,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      tailnetAddress: "daemon.tailnet.ts.net:6767",
    };

    expect(decodeOfferFragmentPayload(encodeBase64UrlNoPadUtf8(JSON.stringify(payload)))).toEqual(
      payload,
    );
  });

  it("parses connection offers from QR-style URLs", () => {
    const offer = ConnectionOfferSchema.parse({
      v: 3,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      tailnetAddress: "daemon.tailnet.ts.net:6767",
    });
    const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

    expect(parseConnectionOfferFromUrl(`jagentdesk://app/#offer=${encoded}`)).toEqual(offer);
  });

  it("parses a tailnet offer", () => {
    const offer = ConnectionOfferSchema.parse({
      v: 3,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      tailnetAddress: "daemon.tailnet.ts.net:6767",
    });

    expect(offer).toEqual({
      v: 3,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      tailnetAddress: "daemon.tailnet.ts.net:6767",
    });
  });

  it("round-trips tailnet offers through QR-style URLs", () => {
    const offer = ConnectionOfferSchema.parse({
      v: 3,
      serverId: "server-123",
      daemonPublicKeyB64: "pubkey",
      tailnetAddress: "daemon.tailnet.ts.net:6767",
      useTls: true,
    });
    const encoded = encodeBase64UrlNoPadUtf8(JSON.stringify(offer));

    expect(parseConnectionOfferFromUrl(`jagentdesk://app/#offer=${encoded}`)).toEqual(offer);
  });

  it("rejects a v3 tailnet offer without a tailnet address", () => {
    expect(() =>
      ConnectionOfferSchema.parse({
        v: 3,
        serverId: "server-123",
        daemonPublicKeyB64: "pubkey",
      }),
    ).toThrow();
  });

  it("returns null when the URL has no offer fragment", () => {
    expect(parseConnectionOfferFromUrl("jagentdesk://app/pair")).toBeNull();
  });
});
