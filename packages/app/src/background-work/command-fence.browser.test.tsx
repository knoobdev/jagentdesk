import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { COMMAND_COLLAPSED_HEIGHT } from "./command-collapse";
import { CommandFence } from "./command-fence";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * The real fence in a real browser, laid out at a phone's width: the collapse decision has to
 * settle once and never move again while nobody touches it.
 */

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

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
});

function byTestId(testID: string): HTMLElement | null {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  return element instanceof HTMLElement ? element : null;
}

async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

interface FenceSample {
  toggle: string | null;
  height: number;
}

function sample(): FenceSample {
  return {
    toggle: byTestId("background-work-detail-command-toggle")?.textContent ?? null,
    height: Math.round(byTestId("background-work-detail-command-fence")?.offsetHeight ?? -1),
  };
}

/** Samples the fence over many frames; every sample must equal the first. */
async function samplesOverFrames(count: number): Promise<FenceSample[]> {
  const samples: FenceSample[] = [];
  for (let index = 0; index < count; index += 1) {
    await frames(1);
    samples.push(sample());
  }
  return samples;
}

// A 400-character command, as in A4.27c.2.
const LONG_COMMAND = `for f in ${Array.from({ length: 40 }, (_, index) => `src/module-${index}.ts`).join(" ")}; do npx eslint "$f"; done`;

const PHONE_WIDTH = { width: 358 };
const toast: ToastApi = { show: () => () => {}, copied: () => {}, error: () => {} };

function Phone({ children }: { children: ReactNode }) {
  return (
    <ToastApiProvider api={toast}>
      <View style={PHONE_WIDTH}>{children}</View>
    </ToastApiProvider>
  );
}

describe("CommandFence", () => {
  beforeEach(async () => {
    if (!i18n.isInitialized) await i18n.init();
    await i18n.changeLanguage("en");
  });

  it("collapses a long command once and holds still while nobody touches it", async () => {
    mount(
      <Phone>
        <CommandFence command={LONG_COMMAND} />
      </Phone>,
    );
    await frames(3);
    const settled = sample();
    expect(settled.toggle).toBe("Show more");
    const command = byTestId("background-work-detail-command");
    expect(command?.parentElement?.offsetHeight).toBeLessThanOrEqual(COMMAND_COLLAPSED_HEIGHT);

    const samples = await samplesOverFrames(30);
    expect(samples.every((entry) => entry.toggle === settled.toggle)).toBe(true);
    expect(samples.every((entry) => entry.height === settled.height)).toBe(true);
  });

  it("expands on Show more and stays expanded", async () => {
    mount(
      <Phone>
        <CommandFence command={LONG_COMMAND} />
      </Phone>,
    );
    await frames(3);
    const collapsedHeight = sample().height;
    act(() => {
      byTestId("background-work-detail-command-toggle")?.click();
    });
    await frames(3);
    const expanded = sample();
    expect(expanded.toggle).toBe("Show less");
    expect(expanded.height).toBeGreaterThan(collapsedHeight);

    const samples = await samplesOverFrames(30);
    expect(samples.every((entry) => entry.toggle === "Show less")).toBe(true);
    expect(samples.every((entry) => entry.height === expanded.height)).toBe(true);
  });

  it("offers nothing to expand for a short command", async () => {
    mount(
      <Phone>
        <CommandFence command="sleep 30" />
      </Phone>,
    );
    await frames(3);
    const samples = await samplesOverFrames(10);
    expect(samples.every((entry) => entry.toggle === null)).toBe(true);
  });
});
