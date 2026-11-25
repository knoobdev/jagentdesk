import { describe, expect, it } from "vitest";
import { clearGrantsWhenSessionsEnd, type AgentStateEvent } from "./agent-grants.js";

function harness() {
  let emit: (event: AgentStateEvent) => void = () => {};
  const forgotten: string[] = [];
  const stop = clearGrantsWhenSessionsEnd(
    (callback) => {
      emit = callback;
      return () => {
        emit = () => {};
      };
    },
    { forgetAgent: (agentId) => forgotten.push(agentId) },
  );
  const state = (id: string, lifecycle: string, session: object | null) =>
    emit({ type: "agent_state", agent: { id, lifecycle, session } });
  return { state, emit: (event: AgentStateEvent) => emit(event), forgotten, stop };
}

describe("agent device grants end with the agent session (spec 27.6)", () => {
  it("keeps grants while the same session runs", () => {
    const { state, forgotten } = harness();
    const session = {};
    state("agent-a1b2c3", "idle", session);
    state("agent-a1b2c3", "running", session);
    state("agent-a1b2c3", "idle", session);
    expect(forgotten).toEqual([]);
  });

  it("clears them when the agent is closed or archived", () => {
    const { state, forgotten } = harness();
    state("agent-a1b2c3", "idle", {});
    state("agent-a1b2c3", "closed", null);
    state("agent-d4e5f6", "closed", null);
    expect(forgotten).toEqual(["agent-a1b2c3", "agent-d4e5f6"]);
  });

  it("clears them when a new session replaces the old one", () => {
    const { state, forgotten } = harness();
    state("agent-a1b2c3", "idle", {});
    state("agent-a1b2c3", "initializing", {});
    expect(forgotten).toEqual(["agent-a1b2c3"]);
  });

  it("ignores other agent events and stops on unsubscribe", () => {
    const { state, emit, forgotten, stop } = harness();
    emit({ type: "agent_stream" });
    stop();
    state("agent-a1b2c3", "closed", null);
    expect(forgotten).toEqual([]);
  });
});
