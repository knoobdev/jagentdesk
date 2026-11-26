import { describe, expect, it, vi } from "vitest";
import * as generated from "@jagentdesk/protocol/generated/validation/ws-outbound.aot";
import * as shim from "./ws-outbound-zod-validator";

// Phones run `validateWSOutboundMessage` with metro.config.cjs swapping the generated module for
// the shim. Run that exact path here: the generated module is replaced by the shim for the
// validator only (the `generated` import above is the real module, read before the mock applies to
// the dynamic import below).
vi.mock("@jagentdesk/protocol/generated/validation/ws-outbound.aot", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const native = await import("./ws-outbound-zod-validator");
  globalThis.__realWsOutboundAot = real;
  return native;
});

declare global {
  // eslint-disable-next-line no-var
  var __realWsOutboundAot: Record<string, unknown> | undefined;
}

describe("native (Hermes) ws-outbound validator path", () => {
  it("exports every name the generated module exports", async () => {
    await import("@jagentdesk/protocol/validation/ws-outbound");
    const realExports = Object.keys(globalThis.__realWsOutboundAot ?? generated).filter(
      (name) => name === "WSOutboundEnvelope" || name === "SessionOutboundMessageValidators",
    );
    expect(realExports.sort()).toEqual(["SessionOutboundMessageValidators", "WSOutboundEnvelope"]);
    for (const name of realExports) expect(shim).toHaveProperty(name);
    const realTags = Object.keys(
      (globalThis.__realWsOutboundAot ?? generated).SessionOutboundMessageValidators as object,
    ).sort();
    expect(Object.keys(shim.SessionOutboundMessageValidators).sort()).toEqual(realTags);
  });

  it("accepts the relay/tailnet challenge and session messages through validateWSOutboundMessage", async () => {
    const { validateWSOutboundMessage } =
      await import("@jagentdesk/protocol/validation/ws-outbound");
    const challenge = validateWSOutboundMessage({ type: "challenge", nonce: "bm9uY2U" });
    expect(challenge.success).toBe(true);
    expect(validateWSOutboundMessage({ type: "pong" }).success).toBe(true);
    const session = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "jira.connections.list.response",
        payload: { requestId: "r1", connections: [], error: null },
      },
    });
    expect(session.success).toBe(true);
    expect(
      validateWSOutboundMessage({
        type: "session",
        message: { type: "not-a-real-message", payload: {} },
      }).success,
    ).toBe(false);
  });
});
