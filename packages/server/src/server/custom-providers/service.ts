// TEMPORARY stub (C10): C9 owns the real createCustomProviderService implementation (spec 34.2–34.6:
// config.json `agents.providers.<id>` with an `api` block, secret-store keys `provider.apikey.<id>`,
// tailnet/ssh listeners, hot reload emitting providers_snapshot_update). This file only exists so the
// protocol/session/agent-tools wiring below C10 compiles and every `providers.custom.*` request still
// gets an error response instead of timing out. Delete when C9's service lands.
import type { CustomProviderService } from "./types.js";

const NOT_IMPLEMENTED = "custom provider service is not implemented yet (C9 owns the service)";

export function createCustomProviderService(): CustomProviderService {
  return {
    list: () => {
      throw new Error(NOT_IMPLEMENTED);
    },
    save: () => {
      throw new Error(NOT_IMPLEMENTED);
    },
    delete: () => {
      throw new Error(NOT_IMPLEMENTED);
    },
    test: () => {
      throw new Error(NOT_IMPLEMENTED);
    },
    onChanged: () => () => {},
  };
}
