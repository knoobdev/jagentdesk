/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARCHIFY_REPLAY_MESSAGE } from "./archify-document";
import { ArchifyFrame } from "./archify-frame.web";

// ADR-0021 §4 on web/Electron: sandbox="allow-scripts" only, srcDoc, and replay via postMessage.

beforeEach(() => vi.stubGlobal("React", React));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(replayToken: number) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <ArchifyFrame
        document="<p>diagram</p>"
        replayToken={replayToken}
        height={400}
        title="Diagram"
      />,
    ),
  );
  return container.querySelector("iframe")!;
}

function rerender(replayToken: number) {
  act(() =>
    root!.render(
      <ArchifyFrame
        document="<p>diagram</p>"
        replayToken={replayToken}
        height={400}
        title="Diagram"
      />,
    ),
  );
}

describe("ArchifyFrame (web)", () => {
  it("isolates the document in an opaque-origin sandbox", () => {
    const frame = mount(0);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toBe("<p>diagram</p>");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Diagram");
    expect(frame.getAttribute("src")).toBeNull();
  });

  it("posts a replay message only when the token changes after mount", () => {
    const frame = mount(3);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    rerender(3);
    expect(post).not.toHaveBeenCalled();
    rerender(4);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: ARCHIFY_REPLAY_MESSAGE }, "*");
  });
});
