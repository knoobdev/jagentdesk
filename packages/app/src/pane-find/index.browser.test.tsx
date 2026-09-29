import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { PaneFind } from "./index";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

const mounted: { root: Root; container: HTMLDivElement }[] = [];
const noop = () => {};

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountFind(replace?: {
  value: string;
  onChange(value: string): void;
  onReplace(): void;
  onReplaceAll(): void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <PaneFind
        query="one"
        status="1 of 2"
        canNavigate
        onQueryChange={noop}
        onNext={noop}
        onPrevious={noop}
        onClose={noop}
        replace={replace}
      />,
    ),
  );
  mounted.push({ root, container });
  return container;
}

function byLabel(container: HTMLElement, label: string) {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

function buttonWithText(container: HTMLElement, text: string) {
  const buttons = Array.from(container.querySelectorAll<HTMLElement>("button, [role=button]"));
  return buttons.find((button) => button.textContent === text) ?? null;
}

describe("PaneFind", () => {
  it("offers no replace controls without a replace handler", () => {
    const container = mountFind();
    expect(byLabel(container, "Find in pane")).not.toBeNull();
    expect(byLabel(container, "Toggle replace")).toBeNull();
  });

  it("reveals the replacement row from the disclosure toggle", () => {
    const onReplace = vi.fn();
    const onReplaceAll = vi.fn();
    const container = mountFind({ value: "", onChange: noop, onReplace, onReplaceAll });

    expect(byLabel(container, "Replace with")).toBeNull();
    act(() => byLabel(container, "Toggle replace")?.click());
    expect(byLabel(container, "Replace with")).not.toBeNull();

    const replaceAll = buttonWithText(container, "Replace all");
    const replaceOne = buttonWithText(container, "Replace");
    act(() => replaceAll?.click());
    act(() => replaceOne?.click());
    expect(onReplaceAll).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledTimes(1);
  });
});
