import { describe, expect, it } from "vitest";
import { createDefaultOrchestrationConfig } from "@jagentdesk/protocol/orchestration";
import { prepareTaskBrief } from "./task-brief.js";

describe("orchestration task brief compiler", () => {
  it("turns a natural-language request into a ready Supervisor brief", () => {
    const brief = prepareTaskBrief({
      rawRequest:
        "Add an Output Format ON/OFF setting to the Use Case form, default it OFF, and test both paths.",
      config: createDefaultOrchestrationConfig(),
      nowMs: 123,
    });

    expect(brief.status).toBe("ready");
    expect(brief.routeCategory).toBe("impl");
    expect(brief.selectedRoute.profileId).toBe("peer-deepseek-flash");
    expect(brief.normalizedPrompt).toContain("Acceptance criteria");
    expect(brief.createdAtMs).toBe(123);
  });

  it("preserves labeled decisions and asks only for material missing information", () => {
    const brief = prepareTaskBrief({
      rawRequest: [
        "Objective: Investigate the connection timeout.",
        "Context: It happens after reconnect.",
        "Constraints: Do not change the pairing protocol.",
        "Accepted decisions: Keep Tailscale as the transport.",
        "Validation: Run the connection integration test.",
        "Route: research",
      ].join("\n"),
      config: createDefaultOrchestrationConfig(),
    });

    expect(brief.status).toBe("ready");
    expect(brief.context).toBe("It happens after reconnect.");
    expect(brief.constraints).toEqual(["Do not change the pairing protocol."]);
    expect(brief.acceptedDecisions).toEqual(["Keep Tailscale as the transport."]);
    expect(brief.routeCategory).toBe("research");
    expect(brief.openQuestions).toEqual([]);
  });

  it("does not dispatch an empty request as if it were complete", () => {
    const brief = prepareTaskBrief({
      rawRequest: "",
      config: createDefaultOrchestrationConfig(),
    });
    expect(brief.status).toBe("needs_clarification");
    expect(brief.openQuestions.length).toBeGreaterThan(0);
  });
});
