import { describe, expect, it } from "vitest";
import {
  deriveSshTabDotStatus,
  initialSshTabStatusState,
  sshTabStatus,
  type SshTabEvent,
  type SshTabStatusState,
} from "./tab-status-state";

function run(...events: SshTabEvent[]): SshTabStatusState {
  return events.reduce(sshTabStatus, initialSshTabStatusState);
}

describe("sshTabStatus", () => {
  it("marks output as unseen while the tab is not focused", () => {
    const state = run({ type: "output" });
    expect(state).toEqual({ ...initialSshTabStatusState, unseenOutput: true });
  });

  it("does not mark output as unseen while the tab is focused", () => {
    const state = run({ type: "focused" }, { type: "output" });
    expect(state).toEqual({ ...initialSshTabStatusState, focused: true, unseenOutput: false });
  });

  it("clears unseen output when the tab becomes focused", () => {
    const state = run({ type: "output" }, { type: "focused" });
    expect(state).toEqual({ ...initialSshTabStatusState, focused: true, unseenOutput: false });
  });

  it("keeps unseen output across focus and blur when nothing views it again", () => {
    const state = run({ type: "output" }, { type: "blurred" });
    expect(state).toEqual({ ...initialSshTabStatusState, unseenOutput: true, focused: false });
  });

  it("re-arms unseen output for output after blur", () => {
    const state = run({ type: "focused" }, { type: "blurred" }, { type: "output" });
    expect(state.unseenOutput).toBe(true);
    expect(state.focused).toBe(false);
  });

  it("tracks host key prompts as pending by id", () => {
    const state = run({ type: "hostkey_prompt", promptId: "p1" });
    expect(state.pendingPromptIds).toEqual(["p1"]);
  });

  it("tracks auth prompts as pending by id", () => {
    const state = run({ type: "auth_prompt", promptId: "a1" });
    expect(state.pendingPromptIds).toEqual(["a1"]);
  });

  it("ignores a repeated prompt id", () => {
    const state = run(
      { type: "auth_prompt", promptId: "a1" },
      { type: "auth_prompt", promptId: "a1" },
    );
    expect(state.pendingPromptIds).toEqual(["a1"]);
  });

  it("keeps multiple prompts pending at once", () => {
    const state = run(
      { type: "hostkey_prompt", promptId: "p1" },
      { type: "auth_prompt", promptId: "a1" },
    );
    expect(state.pendingPromptIds).toEqual(["p1", "a1"]);
  });

  it("removes only the resolved prompt", () => {
    const state = run(
      { type: "hostkey_prompt", promptId: "p1" },
      { type: "auth_prompt", promptId: "a1" },
      { type: "prompt_resolved", promptId: "p1" },
    );
    expect(state.pendingPromptIds).toEqual(["a1"]);
  });

  it("ignores resolving an unknown prompt", () => {
    const state = run(
      { type: "auth_prompt", promptId: "a1" },
      { type: "prompt_resolved", promptId: "zz" },
    );
    expect(state).toEqual({ ...initialSshTabStatusState, pendingPromptIds: ["a1"] });
  });

  it("records every connection state", () => {
    const connecting = run({ type: "connection", state: "connecting" });
    expect(connecting.connection).toBe("connecting");
    expect(connecting.everConnected).toBe(false);

    const connected = run({ type: "connection", state: "connected" });
    expect(connected.connection).toBe("connected");
    expect(connected.everConnected).toBe(true);
  });

  it("remembers the last connection state once connected", () => {
    const state = run(
      { type: "connection", state: "connecting" },
      { type: "connection", state: "connected" },
      { type: "connection", state: "reconnecting" },
    );
    expect(state.connection).toBe("reconnecting");
    expect(state.everConnected).toBe(true);
  });

  it("returns the same state object for a no-op event", () => {
    const before = run({ type: "output" });
    const after = sshTabStatus(before, { type: "prompt_resolved", promptId: "missing" });
    expect(after).toBe(before);
  });
});

describe("deriveSshTabDotStatus", () => {
  it("is idle for a fresh tab", () => {
    expect(deriveSshTabDotStatus(initialSshTabStatusState)).toBe("idle");
  });

  it("is idle while connecting", () => {
    const state = run({ type: "connection", state: "connecting" });
    expect(deriveSshTabDotStatus(state)).toBe("idle");
  });

  it("is green for unseen output", () => {
    const state = run({ type: "output" });
    expect(deriveSshTabDotStatus(state)).toBe("unseen_output");
  });

  it("turns green again after focus clears and new output arrives", () => {
    const state = run({ type: "focused" }, { type: "blurred" }, { type: "output" });
    expect(deriveSshTabDotStatus(state)).toBe("unseen_output");
  });

  it("is yellow for a pending host key prompt", () => {
    const state = run({ type: "hostkey_prompt", promptId: "p1" });
    expect(deriveSshTabDotStatus(state)).toBe("awaiting_input");
  });

  it("is yellow for a pending auth prompt", () => {
    const state = run({ type: "auth_prompt", promptId: "a1" });
    expect(deriveSshTabDotStatus(state)).toBe("awaiting_input");
  });

  it("is yellow while the connection awaits a host key", () => {
    const state = run({ type: "connection", state: "awaiting_hostkey" });
    expect(deriveSshTabDotStatus(state)).toBe("awaiting_input");
  });

  it("is yellow while the connection awaits auth", () => {
    const state = run({ type: "connection", state: "awaiting_auth" });
    expect(deriveSshTabDotStatus(state)).toBe("awaiting_input");
  });

  it("returns to the previous color once the only prompt resolves", () => {
    const state = run(
      { type: "output" },
      { type: "auth_prompt", promptId: "a1" },
      { type: "prompt_resolved", promptId: "a1" },
    );
    expect(deriveSshTabDotStatus(state)).toBe("unseen_output");
  });

  it("is red on error", () => {
    const state = run({ type: "connection", state: "error" });
    expect(deriveSshTabDotStatus(state)).toBe("error");
  });

  it("is red on error even before a first successful connect", () => {
    const state = run(
      { type: "connection", state: "connecting" },
      { type: "connection", state: "error" },
    );
    expect(deriveSshTabDotStatus(state)).toBe("error");
  });

  it("is red when a connected session drops to disconnected", () => {
    const state = run(
      { type: "connection", state: "connected" },
      { type: "connection", state: "disconnected" },
    );
    expect(deriveSshTabDotStatus(state)).toBe("error");
  });

  it("is red while reconnecting after a connection existed", () => {
    const state = run(
      { type: "connection", state: "connected" },
      { type: "connection", state: "reconnecting" },
    );
    expect(deriveSshTabDotStatus(state)).toBe("error");
  });

  it("is idle when a session was never connected and is disconnected", () => {
    const state = run({ type: "connection", state: "disconnected" });
    expect(deriveSshTabDotStatus(state)).toBe("idle");
  });

  it("shows yellow, not red, when a prompt is pending and the connection errored", () => {
    const state = run(
      { type: "connection", state: "connected" },
      { type: "connection", state: "error" },
      { type: "auth_prompt", promptId: "a1" },
    );
    expect(deriveSshTabDotStatus(state)).toBe("awaiting_input");
  });

  it("shows red, not green, when output went unseen and the connection errored", () => {
    const state = run({ type: "output" }, { type: "connection", state: "error" });
    expect(deriveSshTabDotStatus(state)).toBe("error");
  });

  it("keeps unseen output after the connection recovers", () => {
    const state = run(
      { type: "output" },
      { type: "connection", state: "connected" },
      { type: "connection", state: "reconnecting" },
      { type: "connection", state: "connected" },
    );
    expect(deriveSshTabDotStatus(state)).toBe("unseen_output");
  });
});
