import type { TypeOf } from "zod";
import { FigmaColorSchema, FigmaTransitionSchema } from "@jagentdesk/protocol/figma/rpc-schemas";

// The wire contract ships these schemas without inferred type exports (protocol is fixed, see
// docs/protocol-compatibility.md). Derive the types from the schemas so they can never drift.

export type FigmaColor = TypeOf<typeof FigmaColorSchema>;
export type FigmaTransition = TypeOf<typeof FigmaTransitionSchema>;
