import { describe, expect, it } from "vitest";

import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
  WSOutboundMessageSchema,
} from "./messages.js";

describe("WS-level challenge message", () => {
  it("parses a challenge and accepts it through WSOutboundMessageSchema", () => {
    const parsed = WSOutboundMessageSchema.safeParse({
      type: "challenge",
      nonce: "nonce-abc123",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("challenge");
      expect(parsed.data.nonce).toBe("nonce-abc123");
    }
  });

  it("rejects a challenge without a nonce", () => {
    const parsed = WSOutboundMessageSchema.safeParse({ type: "challenge" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a challenge with an empty nonce", () => {
    const parsed = WSOutboundMessageSchema.safeParse({ type: "challenge", nonce: "" });
    expect(parsed.success).toBe(false);
  });
});

describe("signed hello fields", () => {
  const baseHello = {
    type: "hello",
    clientId: "client-1",
    clientType: "mobile",
    protocolVersion: 1,
  } as const;

  it("accepts nonce, signature, and devicePublicKeyB64", () => {
    const parsed = WSHelloMessageSchema.safeParse({
      ...baseHello,
      nonce: "nonce-abc123",
      signature: "c2lnbmF0dXJl",
      devicePublicKeyB64: "cHVibGlja2V5",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.nonce).toBe("nonce-abc123");
      expect(parsed.data.signature).toBe("c2lnbmF0dXJl");
      expect(parsed.data.devicePublicKeyB64).toBe("cHVibGlja2V5");
    }
  });

  it("still parses without the optional fields", () => {
    expect(WSHelloMessageSchema.safeParse(baseHello).success).toBe(true);
  });

  it("rejects empty nonce", () => {
    expect(WSHelloMessageSchema.safeParse({ ...baseHello, nonce: "" }).success).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(WSHelloMessageSchema.safeParse({ ...baseHello, signature: "" }).success).toBe(false);
  });

  it("rejects empty devicePublicKeyB64", () => {
    expect(WSHelloMessageSchema.safeParse({ ...baseHello, devicePublicKeyB64: "" }).success).toBe(
      false,
    );
  });
});

describe("pairing device RPCs", () => {
  it("accepts the unauthenticated device identity hint used while waiting for the code", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "pairing.device.identify.request",
      requestId: "req-identify-1",
      deviceName: "My Phone",
      devicePublicKeyB64: "ZGV2aWNl",
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips pairing.device.register.request through SessionInboundMessageSchema", () => {
    const request = {
      type: "pairing.device.register.request",
      requestId: "req-1",
      daemonPublicKeyB64: "ZGFlbW9u",
      devicePublicKeyB64: "ZGV2aWNl",
      deviceName: "My Phone",
    };

    const parsed = SessionInboundMessageSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("pairing.device.register.request");
      expect(parsed.data.daemonPublicKeyB64).toBe("ZGFlbW9u");
      expect(parsed.data.deviceName).toBe("My Phone");
    }
  });

  it("accepts pairing.device.register.request without a deviceName", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "pairing.device.register.request",
      requestId: "req-1",
      daemonPublicKeyB64: "ZGFlbW9u",
      devicePublicKeyB64: "ZGV2aWNl",
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips pairing.device.cancel.request through SessionInboundMessageSchema", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "pairing.device.cancel.request",
      requestId: "cancel-1",
      targetRequestId: "pair-request-1",
      reason: "Declined on desktop",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects pairing.device.register.request missing daemonPublicKeyB64", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "pairing.device.register.request",
      requestId: "req-1",
      devicePublicKeyB64: "ZGV2aWNl",
    });
    expect(parsed.success).toBe(false);
  });

  it("round-trips pairing.device.register.response through SessionOutboundMessageSchema", () => {
    const response = {
      type: "pairing.device.register.response",
      payload: { requestId: "req-1", ok: true, deviceId: "device-1" },
    };

    const parsed = SessionOutboundMessageSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("pairing.device.register.response");
      expect(parsed.data.payload.ok).toBe(true);
      expect(parsed.data.payload.deviceId).toBe("device-1");
    }
  });

  it("accepts pairing.device.register.response with an error instead of a deviceId", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "pairing.device.register.response",
      payload: { requestId: "req-1", ok: false, error: "key mismatch" },
    });
    expect(parsed.success).toBe(true);
  });

  it("round-trips pairing.device.cancel.response and cancelled event", () => {
    const response = SessionOutboundMessageSchema.safeParse({
      type: "pairing.device.cancel.response",
      payload: {
        requestId: "cancel-1",
        targetRequestId: "pair-request-1",
        ok: true,
      },
    });
    const event = SessionOutboundMessageSchema.safeParse({
      type: "pairing.device.cancelled",
      payload: {
        requestId: "pair-request-1",
        reason: "Declined on desktop",
      },
    });
    expect(response.success).toBe(true);
    expect(event.success).toBe(true);
  });

  it("round-trips pairing.device.revoke.request through SessionInboundMessageSchema", () => {
    const request = {
      type: "pairing.device.revoke.request",
      requestId: "req-2",
      deviceId: "device-1",
    };

    const parsed = SessionInboundMessageSchema.safeParse(request);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("pairing.device.revoke.request");
      expect(parsed.data.deviceId).toBe("device-1");
    }
  });

  it("rejects pairing.device.revoke.request missing deviceId", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "pairing.device.revoke.request",
      requestId: "req-2",
    });
    expect(parsed.success).toBe(false);
  });

  it("round-trips pairing.device.revoke.response through SessionOutboundMessageSchema", () => {
    const response = {
      type: "pairing.device.revoke.response",
      payload: { requestId: "req-2", ok: true },
    };

    const parsed = SessionOutboundMessageSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("pairing.device.revoke.response");
      expect(parsed.data.payload.ok).toBe(true);
    }
  });

  it("round-trips pairing.device.list.request through SessionInboundMessageSchema", () => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "pairing.device.list.request",
      requestId: "req-3",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("pairing.device.list.request");
    }
  });

  it("round-trips pairing.device.list.response through SessionOutboundMessageSchema", () => {
    const response = {
      type: "pairing.device.list.response",
      payload: {
        requestId: "req-3",
        devices: [
          {
            deviceId: "device-1",
            devicePublicKeyB64: "ZGV2aWNl",
            deviceName: "My Phone",
            pairedAtMs: 1700000000000,
          },
        ],
      },
    };

    const parsed = SessionOutboundMessageSchema.safeParse(response);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe("pairing.device.list.response");
      expect(parsed.data.payload.devices).toHaveLength(1);
      expect(parsed.data.payload.devices[0]?.deviceName).toBe("My Phone");
    }
  });

  it("accepts pairing.device.list.response devices without a deviceName", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "pairing.device.list.response",
      payload: {
        requestId: "req-3",
        devices: [
          {
            deviceId: "device-1",
            devicePublicKeyB64: "ZGV2aWNl",
            pairedAtMs: 1700000000000,
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });
});
