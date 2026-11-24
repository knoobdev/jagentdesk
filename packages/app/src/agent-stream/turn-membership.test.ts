import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { continuesTurn } from "./turn-membership";

function at(second: number): Date {
  return new Date(`2026-01-01T00:00:${second.toString().padStart(2, "0")}.000Z`);
}

function assistant(id: string, second: number, turnId: string): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: at(second), turnId };
}

function runningTool(id: string, second: number, turnId: string): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: at(second),
    turnId,
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "Bash",
        status: "running",
        error: null,
        detail: { type: "unknown", input: null, output: null },
      },
    },
  };
}

describe("canonical turn membership", () => {
  it("uses trigger fallback for missing IDs without pretending to recover batching", () => {
    const previous = assistant("reply", 1, "first");
    const trigger = runningTool("heartbeat", 2, "first");
    if (trigger.kind !== "tool_call" || trigger.payload.source !== "agent")
      throw new Error("Expected agent tool");
    trigger.payload.data.name = "heartbeat";
    expect(continuesTurn(previous, trigger)).toBe(true);
    delete trigger.turnId;
    expect(continuesTurn(previous, trigger)).toBe(false);
    trigger.payload.data.name = "agent_message";
    trigger.payload.data.agentMessage = {
      event: "finished",
      sender: { id: "worker" },
      text: "Done",
    };
    expect(continuesTurn(previous, trigger)).toBe(false);
  });

  it("stops tagged traversal at every mismatching turn ID", () => {
    expect(continuesTurn(assistant("first", 1, "turn-1"), runningTool("next", 2, "turn-2"))).toBe(
      false,
    );
    expect(continuesTurn(runningTool("first", 1, "turn-1"), assistant("next", 2, "turn-1"))).toBe(
      true,
    );
  });
});
