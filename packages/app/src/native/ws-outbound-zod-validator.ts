import { WSOutboundMessageSchema as SourceWSOutboundMessageSchema } from "@jagentdesk/protocol/messages";

// Android and iOS (metro.config.cjs swaps this in for the zod-aot output): the generated validator is
// a single ~6 MB function, and hermesc needs more than 10 GB of memory to compile it, which kills the
// release runner (the iOS IPA job hit it in v0.9.53). Hermes builds validate the same schema with
// zod's own parser instead; web and desktop keep the generated validator.
export const WSOutboundMessageSchema = {
  safeParse: (input: unknown) => SourceWSOutboundMessageSchema.safeParse(input),
};
