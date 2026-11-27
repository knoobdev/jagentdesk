import { WSOutboundMessageSchema as SourceWSOutboundMessageSchema } from "@jagentdesk/protocol/messages";
import {
  WSOutboundEnvelopeSchema,
  sessionOutboundMessageOptions,
} from "@jagentdesk/protocol/validation/ws-outbound-envelope";

// Android and iOS (metro.config.cjs swaps this in for the zod-aot output): the generated validator is
// a single ~6 MB function, and hermesc needs more than 10 GB of memory to compile it, which kills the
// release runner (the iOS IPA job hit it in v0.9.53). Hermes builds validate the same schemas with
// zod's own parser instead; web and desktop keep the generated validator.
//
// This module must export everything the generated module exports, under the same names:
// `validation/ws-outbound.ts` reads `WSOutboundEnvelope` and `SessionOutboundMessageValidators`
// (the per-message split ported from Paseo #6847, v0.10.0). When this file only exported
// `WSOutboundMessageSchema`, both were undefined on phones, every daemon message threw in
// validation, the relay/tailnet `challenge` was never answered and phones could not connect after
// pairing ("challenge timed out; refusing unsigned hello"). `ws-outbound-zod-validator.test.ts`
// keeps the export lists equal.

/**
 * The envelope validator: pong, challenge, and session messages reduced to their tag. zod strips
 * keys a schema does not declare, so a session envelope parsed by zod would hand the per-message
 * validator `{ type }` without its payload; zod-aot passes them through. Keep the original message
 * so the next step validates the whole of it, as on web and desktop.
 */
export const WSOutboundEnvelope = {
  safeParse(input: unknown) {
    const result = WSOutboundEnvelopeSchema.safeParse(input);
    if (!result.success || result.data.type !== "session") return result;
    const message = (input as { message: unknown }).message;
    return { success: true as const, data: { ...result.data, message } };
  },
};

/** One validator per session message type, keyed by the message's `type` tag. */
export const SessionOutboundMessageValidators = Object.fromEntries(
  sessionOutboundMessageOptions.map((option) => [option.shape.type.value, option]),
);

/** Kept for callers that validate the whole outbound message in one pass. */
export const WSOutboundMessageSchema = {
  safeParse: (input: unknown) => SourceWSOutboundMessageSchema.safeParse(input),
};
