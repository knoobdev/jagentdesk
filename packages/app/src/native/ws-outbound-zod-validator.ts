import { WSOutboundMessageSchema as SourceWSOutboundMessageSchema } from "@jagentdesk/protocol/messages";

// Android only (metro.config.cjs swaps this in for the zod-aot output): the generated validator is a
// single ~6 MB function, and hermesc needs more than 10 GB of memory to compile it, which kills the
// release runner. Android validates the same schema with zod's own parser instead; web, desktop and
// iOS keep the generated validator.
export const WSOutboundMessageSchema = {
  safeParse: (input: unknown) => SourceWSOutboundMessageSchema.safeParse(input),
};
