import { describe, expect, it } from "vitest";
import {
  OrchestrationConfigGetRequestSchema,
  OrchestrationTaskPrepareResponseSchema,
  createDefaultOrchestrationConfig,
} from "./orchestration.js";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("orchestration protocol", () => {
  it("provides multiple provider/model profiles for each role", () => {
    const config = createDefaultOrchestrationConfig();
    expect(config.roles.supervisor.profiles.length).toBeGreaterThan(1);
    expect(config.roles.lead.profiles.length).toBeGreaterThan(1);
    expect(config.roles.peer.profiles.length).toBeGreaterThan(1);
    expect(config.routes.impl.primary.profileId).toBe("peer-deepseek-flash");
    expect(config.routes.impl_deep.primary.profileId).toBe("peer-codex-luna");
  });

  it("validates namespaced request and response messages", () => {
    expect(
      OrchestrationConfigGetRequestSchema.parse({
        type: "orchestration.config.get.request",
        requestId: "req-1",
      }).type,
    ).toBe("orchestration.config.get.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "orchestration.task.prepare.request",
        requestId: "req-2",
        rawRequest: "Fix the task",
      }).type,
    ).toBe("orchestration.task.prepare.request");
    const response = SessionOutboundMessageSchema.parse({
      type: "orchestration.task.prepare.response",
      payload: {
        requestId: "req-2",
        brief: {
          id: "brief-1",
          rawRequest: "Fix the task",
          objective: "Fix the task",
          constraints: [],
          acceptedDecisions: [],
          requestedOutcome: "Fix the task",
          acceptanceCriteria: ["The task is implemented and verified."],
          validationPlan: ["Run targeted tests."],
          openQuestions: [],
          routeCategory: "impl",
          selectedRoute: { role: "peer", profileId: "peer-deepseek-flash" },
          normalizedPrompt: "Objective: Fix the task",
          status: "ready",
          createdAtMs: 1,
        },
      },
    });
    expect(OrchestrationTaskPrepareResponseSchema.parse(response).type).toBe(
      "orchestration.task.prepare.response",
    );
  });
});
