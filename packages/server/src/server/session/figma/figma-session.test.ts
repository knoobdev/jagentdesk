import pino from "pino";
import { describe, expect, it } from "vitest";
import { FIGMA_REQUEST_TYPES, FigmaResponseSchemas } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FileSecretStore } from "../../database/secret-store.js";
import { FigmaService } from "../../figma/service.js";
import {
  unavailableCache,
  unavailableLink,
  unavailableRest,
  unavailableStore,
  unavailableTokens,
} from "../../figma/unavailable.js";
import { FigmaSession } from "./figma-session.js";

// Every figma.* request gets exactly one response that passes its wire schema — including the
// error responses the placeholders produce (required data fields filled with empty values).
describe("FigmaSession", () => {
  it("answers every request type with a schema-valid response", async () => {
    const service = new FigmaService({
      jagentdeskHome: "/tmp/jad-figma-session-test",
      logger: pino({ level: "silent" }),
      secrets: new FileSecretStore("/tmp/jad-figma-session-test/figma"),
      parts: {
        store: unavailableStore,
        tokens: unavailableTokens,
        rest: unavailableRest,
        cache: unavailableCache,
        link: unavailableLink,
      },
    });
    const emitted: { type: string }[] = [];
    const session = new FigmaSession({
      service,
      emit: (msg) => emitted.push(msg as { type: string }),
      logger: pino({ level: "silent" }),
      canRunLoopback: () => false,
    });
    const schemas = new Map(FigmaResponseSchemas.map((s) => [s.shape.type.value as string, s]));
    for (const type of FIGMA_REQUEST_TYPES) {
      emitted.length = 0;
      // Minimal bodies are fine: placeholders throw before reading them.
      await session.handle({ type, requestId: "r1" } as never);
      expect(emitted).toHaveLength(1);
      const responseType = type.replace(/\.request$/, ".response");
      expect(emitted[0]!.type).toBe(responseType);
      expect(() => schemas.get(responseType)!.parse(emitted[0])).not.toThrow();
    }
    session.dispose();
  });
});
