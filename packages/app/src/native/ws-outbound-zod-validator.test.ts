import { describe, expect, it } from "vitest";
import { validateWSOutboundMessage } from "@jagentdesk/protocol/validation/ws-outbound";
import { WSOutboundMessageSchema } from "./ws-outbound-zod-validator";

// The Android shim must accept and reject exactly what the zod-aot validator does, with the same
// declared fields.
const samples: unknown[] = [
  { type: "pong", payload: {} },
  {
    type: "session",
    message: {
      type: "jira.connections.list.response",
      payload: { requestId: "r1", connections: [] },
    },
  },
  { type: "session", message: { type: "not-a-real-message", payload: {} } },
  { type: "session", message: { type: "agent.spec_mode.state", payload: { agentId: 1 } } },
  { nope: true },
  null,
];

describe("Android ws-outbound validator shim", () => {
  it.each(samples.map((sample, index) => [index, sample]))(
    "sample %i matches zod-aot",
    (_index, sample) => {
      const aot = validateWSOutboundMessage(sample);
      const shim = WSOutboundMessageSchema.safeParse(sample);
      expect(shim.success).toBe(aot.success);
      // zod strips keys the schema does not declare; zod-aot passes them through. Every declared
      // field (including defaults) must match.
      if (aot.success && shim.success) expect(aot.data).toMatchObject(shim.data as object);
    },
  );

  it("accepts at least one real message", () => {
    expect(samples.some((sample) => WSOutboundMessageSchema.safeParse(sample).success)).toBe(true);
  });
});
