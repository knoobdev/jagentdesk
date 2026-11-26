import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { buildProviderSegments } from "./provider-segments";

function message(id: string): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: new Date(0) } as StreamItem;
}

function switchRow(id: string, from: string, to: string, model: string | null): StreamItem {
  return {
    kind: "activity_log",
    id,
    timestamp: new Date(0),
    activityType: "info",
    message: `Switched to ${to}`,
    providerSwitch: {
      fromProvider: from,
      toProvider: to,
      model,
      reason: "manual",
      mode: "handoff",
      handoffId: null,
    },
  } as StreamItem;
}

describe("buildProviderSegments", () => {
  it("attributes rows before each switch to the provider that wrote them", () => {
    const segments = buildProviderSegments([
      message("a"),
      switchRow("s1", "claude", "codex", "gpt-6"),
      message("b"),
      switchRow("s2", "codex", "claude", "haiku"),
      message("c"),
    ]);
    expect(segments.get("a")).toEqual({ provider: "claude", model: null });
    expect(segments.get("b")).toEqual({ provider: "codex", model: "gpt-6" });
    expect(segments.has("c")).toBe(false);
  });

  it("is empty when the agent never switched", () => {
    expect(buildProviderSegments([message("a"), message("b")]).size).toBe(0);
  });
});
