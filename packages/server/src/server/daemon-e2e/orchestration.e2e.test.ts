import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  describe("multi-agent orchestration", () => {
    test("round-trips config and prepares a brief through the daemon RPC", async () => {
      const initial = await ctx.client.getOrchestrationConfig();
      expect(initial.config.enabled).toBe(true);
      expect(initial.config.roles.peer.profiles.length).toBeGreaterThan(1);

      const updated = await ctx.client.patchOrchestrationConfig({
        askWhenAmbiguous: false,
        roles: {
          peer: {
            profiles: [
              ...initial.config.roles.peer.profiles,
              {
                id: "peer-test-profile",
                label: "Configured peer profile",
                provider: "codex",
                model: "gpt-5.6-luna",
                thinkingOptionId: "max",
                enabled: true,
              },
            ],
            defaultProfileId: initial.config.roles.peer.defaultProfileId,
          },
        },
      });
      expect(updated.config.askWhenAmbiguous).toBe(false);
      expect(updated.config.roles.peer.profiles.map((profile) => profile.id)).toContain(
        "peer-test-profile",
      );

      const prepared = await ctx.client.prepareOrchestrationTask({
        rawRequest: "Investigate why reconnect is slow and report evidence.",
        cwd: process.cwd(),
      });
      expect(prepared.brief.status).toBe("ready");
      expect(prepared.brief.routeCategory).toBe("research");
      expect(prepared.brief.normalizedPrompt).toContain("Supervisor");
    });
  });
});
