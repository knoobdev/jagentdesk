import React, { act, useCallback, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, Text, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import {
  ComposerTrackBar,
  ComposerTrackPill,
  ComposerTrackRow,
  type ComposerTrackPillSegment,
} from "./tracks";

const SUBAGENT_SEGMENTS: ComposerTrackPillSegment[] = [{ bucket: null, text: "3 subagents" }];

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The real menu engine, in a real browser, because both things under test only exist there: the
 * panel's dismissal runs through `selectItem`, and the running mark is a Web Animations rotation
 * that jsdom cannot report.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function pill(): HTMLElement {
  const trigger = document.querySelector('[data-testid="pill"]');
  if (!(trigger instanceof HTMLElement)) {
    throw new Error("track pill did not render");
  }
  return trigger;
}

function openPanel(): void {
  click(pill());
}

function row(testID: string): Element | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function isPanelOpen(): boolean {
  return pill().getAttribute("aria-expanded") === "true";
}

describe("composer track panel", () => {
  it("dismisses itself when a row is chosen", () => {
    const onPress = vi.fn();
    mount(
      <ComposerTrackPill testID="pill" segments={SUBAGENT_SEGMENTS} panelTitle="Subagents">
        <ComposerTrackRow accessibilityLabel="Subagent one" testID="row" onPress={onPress}>
          <Text>Subagent one</Text>
        </ComposerTrackRow>
      </ComposerTrackPill>,
    );

    openPanel();
    const target = row("row");
    expect(target).not.toBeNull();

    click(target as Element);

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(isPanelOpen()).toBe(false);
    expect(row("row")).toBeNull();
  });

  it("stays open for a row whose result lands in the panel", () => {
    const onPress = vi.fn();
    mount(
      <ComposerTrackPill testID="pill" segments={SUBAGENT_SEGMENTS} panelTitle="Subagents">
        <ComposerTrackRow
          accessibilityLabel="Archive finished"
          testID="row"
          closeOnSelect={false}
          onPress={onPress}
        >
          <Text>Archive finished</Text>
        </ComposerTrackRow>
      </ComposerTrackPill>,
    );

    openPanel();
    click(row("row") as Element);

    expect(onPress).toHaveBeenCalledTimes(1);
    expect(isPanelOpen()).toBe(true);
    expect(row("row")).not.toBeNull();
  });

  it("closes for good when the panel it belongs to leaves the screen", () => {
    const onPress = vi.fn();
    function Harness() {
      const [active, setActive] = useState(true);
      const hide = useCallback(() => setActive(false), []);
      const show = useCallback(() => setActive(true), []);
      return (
        <>
          <Pressable accessibilityRole="button" testID="hide" onPress={hide} />
          <Pressable accessibilityRole="button" testID="show" onPress={show} />
          <RetainedPanelActivity active={active}>
            <ComposerTrackPill testID="pill" segments={SUBAGENT_SEGMENTS} panelTitle="Subagents">
              <ComposerTrackRow
                accessibilityLabel="Subagent one"
                testID="row"
                closeOnSelect={false}
                onPress={onPress}
              >
                <Text>Subagent one</Text>
              </ComposerTrackRow>
            </ComposerTrackPill>
          </RetainedPanelActivity>
        </>
      );
    }
    mount(<Harness />);

    openPanel();
    expect(isPanelOpen()).toBe(true);

    click(row("hide") as Element);
    click(row("show") as Element);

    expect(isPanelOpen()).toBe(false);
    expect(row("row")).toBeNull();
  });

  it("leaves the panel alone when a row's own action button is pressed", () => {
    const onPress = vi.fn();
    const onAction = vi.fn();
    mount(
      <ComposerTrackPill testID="pill" segments={SUBAGENT_SEGMENTS} panelTitle="Subagents">
        <ComposerTrackRow accessibilityLabel="Subagent one" testID="row" onPress={onPress}>
          <Text>Subagent one</Text>
          <Pressable accessibilityRole="button" testID="row-archive" onPress={onAction}>
            <Text>Archive</Text>
          </Pressable>
        </ComposerTrackRow>
      </ComposerTrackPill>,
    );

    openPanel();
    expect(document.querySelector("button button")).toBeNull();
    expect(row("row")?.getAttribute("role")).toBe("menuitem");
    click(row("row-archive") as Element);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
    expect(isPanelOpen()).toBe(true);
  });

  it.each(["Enter", " "])("selects a track row with %j", (key) => {
    const select = vi.fn();
    mount(
      <ComposerTrackPill testID="pill" segments={SUBAGENT_SEGMENTS} panelTitle="Subagents">
        <ComposerTrackRow accessibilityLabel="Subagent one" testID="row" onPress={select}>
          <Text>Subagent one</Text>
        </ComposerTrackRow>
      </ComposerTrackPill>,
    );
    openPanel();
    const target = row("row") as HTMLElement;
    act(() => {
      target.focus();
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(isPanelOpen()).toBe(false);
  });
});

const BAR_PILL_STYLE = { width: 120, height: 32 };
const TRANSCRIPT_STYLE = { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } as const;
const NARROW_HOST = { position: "relative", width: 300, height: 120 } as const;
const WIDE_HOST = { position: "relative", width: 400, height: 120 } as const;

function mountTrackBar({
  host,
  pills,
}: {
  host: typeof NARROW_HOST | typeof WIDE_HOST;
  pills: number;
}): void {
  mount(
    <MobilePanelsProvider>
      <View style={host}>
        <View testID="transcript" style={TRANSCRIPT_STYLE} />
        <ComposerTrackBar>
          {Array.from({ length: pills }, (_, index) => (
            <View key={index} testID={`bar-pill-${index}`} style={BAR_PILL_STYLE} />
          ))}
        </ComposerTrackBar>
      </View>
    </MobilePanelsProvider>,
  );
}

function byTestID(testID: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`${testID} did not render`);
  }
  return element;
}

/** The element that receives a touch landing at this point of the page. */
function hitTest(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y);
}

describe("composer track bar", () => {
  // Android's horizontal ScrollView ignores the drag unless the scroller itself can be touched.
  // Browsers scroll either way, so this is the only part of that bug a browser can see.
  it("keeps the scroller touchable, so Android can drag the row", () => {
    mountTrackBar({ host: NARROW_HOST, pills: 4 });

    expect(getComputedStyle(byTestID("composer-track-scroll")).pointerEvents).toBe("auto");
  });

  it("stays inside the bar when the pills overflow it", () => {
    mountTrackBar({ host: NARROW_HOST, pills: 4 });

    const scroller = byTestID("composer-track-scroll");
    expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(
      byTestID("transcript").getBoundingClientRect().right,
    );
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
  });

  it("leaves the empty part of the row to the transcript", () => {
    mountTrackBar({ host: WIDE_HOST, pills: 1 });

    const pillRect = byTestID("bar-pill-0").getBoundingClientRect();
    const transcript = byTestID("transcript");
    const emptyX = transcript.getBoundingClientRect().right - 40;
    expect(emptyX).toBeGreaterThan(pillRect.right);

    expect(hitTest(emptyX, pillRect.top + pillRect.height / 2)).toBe(transcript);
  });

  it("fades the full height of the row without taking its touches", () => {
    mountTrackBar({ host: NARROW_HOST, pills: 4 });

    const scroller = byTestID("composer-track-scroll").getBoundingClientRect();
    const shade = byTestID("composer-track-scroll-shade-right").getBoundingClientRect();
    expect(shade.bottom).toBe(scroller.bottom);

    const underShade = hitTest(shade.left + shade.width / 2, shade.top + shade.height / 2);
    expect(byTestID("composer-track-scroll").contains(underShade)).toBe(true);
  });
});

describe("composer track pill segments", () => {
  it("draws every state it is given, so a running child survives a failed sibling", () => {
    const container = mount(
      <ComposerTrackPill
        testID="pill"
        segments={[
          { bucket: "failed", text: "1 failed" },
          { bucket: "running", text: "1 working" },
        ]}
        panelTitle="Subagents"
      >
        <Text>rows</Text>
      </ComposerTrackPill>,
    );

    const segments = [...container.querySelectorAll('[data-testid^="pill-segment-"]')];
    expect(segments.map((segment) => segment.textContent)).toEqual(["1 failed", "1 working"]);
    // The ring is the only mark that animates, so its presence proves the second state survived.
    const animated = segments[1]?.querySelectorAll("*") ?? [];
    expect([...animated].filter((element) => element.getAnimations().length > 0)).toHaveLength(1);
  });
});
