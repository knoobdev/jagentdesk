import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeBackgroundWorkTrackOpen } from "./shared";
import { BackgroundWorkLine } from "./sidebar-line";

const navigateToAgent = vi.hoisted(() => vi.fn());
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent }));
const compactLayout = vi.hoisted(() => ({ compact: false }));
vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/layout")>()),
  useIsCompactFormFactor: () => compactLayout.compact,
}));

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * A sidebar row with background work has a second line that opens the agent with its background
 * track open (spec 38 §4.4b). The rest of the row opens the agent and nothing else, so the line's
 * press target ends where its text does; a line as wide as the row turned every press on the
 * row's lower half into "open the track" (user report 2026-11-28).
 */

/** Narrow enough to fit the test page, wide enough to leave room right of the line's text. */
const ROW_FRAME = { width: 320 };

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  navigateToAgent.mockClear();
  compactLayout.compact = false;
  takeBackgroundWorkTrackOpen("sidebar-line-host", "agent");
});

function byTestId(testID: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`${testID} did not render`);
  return element;
}

function renderRow(openRow: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <View style={ROW_FRAME}>
        <Pressable accessibilityRole="button" testID="row" onPress={openRow}>
          <View testID="column">
            <Text numberOfLines={1}>Agent title</Text>
            <BackgroundWorkLine
              serverId="sidebar-line-host"
              agentId="agent"
              totalCount={1}
              testID="line"
            />
          </View>
        </Pressable>
      </View>,
    ),
  );
  mounted.push({ root, container });
}

describe("background work sidebar line", () => {
  /**
   * On a phone the line is 16 px under the agent's name in a drawer row: far below a finger's
   * target, so a tap meant for the row ("go back to that agent") landed on it and the agent came
   * back with its Background work sheet open (user report 2026-11-28, iPhone). There the line
   * only shows the work; the whole row opens the agent.
   */
  it("on a phone, a tap on the line opens the agent like the rest of the row", () => {
    compactLayout.compact = true;
    const openRow = vi.fn();
    renderRow(openRow);

    act(() => byTestId("line").click());
    expect(openRow).toHaveBeenCalledTimes(1);
    expect(navigateToAgent).not.toHaveBeenCalled();
    expect(takeBackgroundWorkTrackOpen("sidebar-line-host", "agent")).toBe(false);
  });

  it("leaves the empty part of the row's second line to the row", () => {
    const openRow = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <View style={ROW_FRAME}>
          <Pressable accessibilityRole="button" testID="row" onPress={openRow}>
            <View testID="column">
              <Text numberOfLines={1}>Agent title</Text>
              <BackgroundWorkLine
                serverId="sidebar-line-host"
                agentId="agent"
                totalCount={1}
                testID="line"
              />
            </View>
          </Pressable>
        </View>,
      ),
    );
    mounted.push({ root, container });

    const column = byTestId("column").getBoundingClientRect();
    const line = byTestId("line").getBoundingClientRect();
    expect(line.width).toBeGreaterThan(0);
    expect(line.right).toBeLessThan(column.right - 60);

    // A press on the second line, right of its text.
    const blank = document.elementFromPoint(column.right - 10, line.top + line.height / 2);
    expect(blank).not.toBeNull();
    act(() => (blank as HTMLElement).click());
    expect(openRow).toHaveBeenCalledTimes(1);
    expect(navigateToAgent).not.toHaveBeenCalled();

    // The text itself still opens the agent with the track.
    act(() => byTestId("line").click());
    expect(navigateToAgent).toHaveBeenCalledWith({
      serverId: "sidebar-line-host",
      agentId: "agent",
    });
  });
});
