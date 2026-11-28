// Loads the transcript footer before `@/components/message`, which imports it back: evaluated the
// other way round, the footer's styles read the message module's constants before they exist.
import { TurnFooter } from "@/agent-stream/turn-footer";
import React, { act, useCallback, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { BackgroundWorkTrack } from "./index";
import { requestBackgroundWorkTrackOpen } from "./shared";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));
expect(TurnFooter).toBeDefined();

/**
 * The background work pill opens on a press, or once for the sidebar line or timeline row that
 * asked for it. Leaving the agent and coming back must never open it again (user report
 * 2026-11-28: "the background task popover opens by itself when I come back to the agent").
 *
 * No host is connected here, so the pill shows the directory count it is given; the panel's open
 * state is what is under test, read from the pill's `aria-expanded`.
 */

const SERVER = "track-open-host";

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.useRealTimers();
});

function byTestId(testID: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`${testID} did not render`);
  return element;
}

function click(testID: string): void {
  act(() => byTestId(testID).click());
}

function isOpen(agentId: string): boolean {
  return (
    document
      .querySelector(`[data-track-agent="${agentId}"] [data-testid="background-work"]`)
      ?.getAttribute("aria-expanded") === "true"
  );
}

function request(agentId: string): void {
  act(() => requestBackgroundWorkTrackOpen(SERVER, agentId));
}

/** One agent pane: hidden and shown the way the workspace deck and tab slots retain it. */
function Pane({ agentId, initiallyActive = true }: { agentId: string; initiallyActive?: boolean }) {
  const [active, setActive] = useState(initiallyActive);
  const [present, setPresent] = useState(true);
  const hide = useCallback(() => setActive(false), []);
  const show = useCallback(() => setActive(true), []);
  const unmount = useCallback(() => setPresent(false), []);
  const remount = useCallback(() => setPresent(true), []);
  return (
    <div data-track-agent={agentId}>
      <Pressable accessibilityRole="button" testID={`${agentId}-hide`} onPress={hide} />
      <Pressable accessibilityRole="button" testID={`${agentId}-show`} onPress={show} />
      <Pressable accessibilityRole="button" testID={`${agentId}-unmount`} onPress={unmount} />
      <Pressable accessibilityRole="button" testID={`${agentId}-remount`} onPress={remount} />
      {present ? (
        <RetainedPanelActivity active={active}>
          <BackgroundWorkTrack serverId={SERVER} agentId={agentId} count={1} />
        </RetainedPanelActivity>
      ) : null}
    </div>
  );
}

describe("background work track open intent", () => {
  it("opens once for the line that asked, and stays closed when the agent comes back", () => {
    mount(<Pane agentId="agent-once" />);
    request("agent-once");
    expect(isOpen("agent-once")).toBe(true);

    // The user closes it, leaves the agent and returns — retained, then remounted.
    click("background-work");
    expect(isOpen("agent-once")).toBe(false);
    click("agent-once-hide");
    click("agent-once-show");
    expect(isOpen("agent-once")).toBe(false);
    click("agent-once-unmount");
    click("agent-once-remount");
    expect(isOpen("agent-once")).toBe(false);
  });

  it("drops a request no track took, instead of opening on a later visit", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
    // A timeline row in a view without the track (a bot chat, an archived agent) asks for it.
    request("agent-later");
    // Minutes later the user opens that agent from the sidebar.
    vi.setSystemTime(new Date("2026-11-28T10:05:00Z"));
    mount(<Pane agentId="agent-later" />);
    expect(isOpen("agent-later")).toBe(false);
  });

  it("lets a newer request replace an older one for another agent", () => {
    request("agent-first");
    request("agent-second");
    mount(<Pane agentId="agent-first" />);
    expect(isOpen("agent-first")).toBe(false);
    mount(<Pane agentId="agent-second" />);
    expect(isOpen("agent-second")).toBe(true);
  });

  it("waits for a hidden pane to come on screen instead of opening it behind the scenes", () => {
    mount(<Pane agentId="agent-hidden" initiallyActive={false} />);
    request("agent-hidden");
    expect(isOpen("agent-hidden")).toBe(false);
    // The navigation the line started brings the retained pane back.
    click("agent-hidden-show");
    expect(isOpen("agent-hidden")).toBe(true);
    click("background-work");
    click("agent-hidden-hide");
    click("agent-hidden-show");
    expect(isOpen("agent-hidden")).toBe(false);
  });

  it("is taken by one copy of the track only", () => {
    mount(<Pane agentId="agent-twice" />);
    mount(<Pane agentId="agent-twice" />);
    request("agent-twice");
    const pills = document.querySelectorAll(
      '[data-track-agent="agent-twice"] [data-testid="background-work"]',
    );
    const expanded = Array.from(pills).filter(
      (pill) => pill.getAttribute("aria-expanded") === "true",
    );
    expect(pills.length).toBe(2);
    expect(expanded.length).toBe(1);
  });
});
