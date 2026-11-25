import { afterEach, describe, expect, it } from "vitest";
import { buildActivityGraphDocument } from "./activity-graph-document";

// Real Chromium: the frame document applies statuses on load, repaints them from postMessage
// without reloading (spec 31.3 / 31.7 #2), and posts `jad-archify-select` on node click (31.6).
// The iframe here is same-origin so the test can read the frame DOM; the production sandbox
// (allow-scripts only) is exercised by the end-to-end run. The archify markup is the minimal
// shape archify renders (div.diagram-container > svg > g[data-node-id] > rect.c-mask + rect).

const ARCHIFY_SHAPE = `<!doctype html><html><head></head><body><div class="container"><div class="diagram-container">
<svg viewBox="0 0 600 120">
<g data-node-id="start"><rect class="c-mask" x="10" y="10" width="140" height="64"/><rect class="c-frontend" x="10" y="10" width="140" height="64"/><text data-node-label="" x="80" y="40">Start</text></g>
<g data-node-id="tools-call_1"><rect class="c-mask" x="220" y="10" width="140" height="64"/><rect class="c-frontend" x="220" y="10" width="140" height="64"/><text data-node-label="" x="290" y="40">Read</text></g>
</svg></div></div></body></html>`;

const PALETTE = {
  surface0: "#181B1A",
  surface1: "#1E2120",
  surface2: "#272A29",
  foreground: "#fafafa",
  foregroundMuted: "#A1A5A4",
  foregroundExtraMuted: "#717574",
  border: "#252B2A",
};

let frame: HTMLIFrameElement | null = null;
afterEach(() => {
  frame?.remove();
  frame = null;
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mount() {
  const el = document.createElement("iframe");
  frame = el;
  el.style.width = "640px";
  el.style.height = "300px";
  let loads = 0;
  const loaded = new Promise<void>((resolve) =>
    el.addEventListener("load", () => {
      loads += 1;
      resolve();
    }),
  );
  el.srcdoc = buildActivityGraphDocument({
    html: ARCHIFY_SHAPE,
    colorScheme: "dark",
    palette: PALETTE,
    statuses: [
      { id: "start", status: "done" },
      { id: "tools-call_1", status: "running" },
    ],
    focusNodeId: "tools-call_1",
    scale: null,
    fit: false,
  });
  document.body.appendChild(el);
  await loaded;
  await sleep(50);
  const node = (id: string) =>
    el.contentDocument!.querySelector(`[data-node-id="${id}"]`) as SVGGElement;
  return { el, node, loads: () => loads };
}

describe("activity graph frame document", () => {
  it("keeps the ADR-0021 CSP as the first element", () => {
    const doc = buildActivityGraphDocument({
      html: ARCHIFY_SHAPE,
      colorScheme: "light",
      palette: PALETTE,
      statuses: [],
      focusNodeId: null,
      scale: null,
      fit: true,
    });
    expect(
      doc.startsWith(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'`,
      ),
    ).toBe(true);
    expect(doc).toContain("connect-src 'none'");
  });

  it("paints initial statuses and repaints pushed ones without reloading", async () => {
    const { el, node, loads } = await mount();
    expect(node("start").getAttribute("data-jad-status")).toBe("done");
    expect(node("tools-call_1").getAttribute("data-jad-status")).toBe("running");
    const runningStroke = getComputedStyle(
      node("tools-call_1").querySelector("rect.c-frontend")!,
    ).stroke;
    expect(runningStroke).toBe("rgb(59, 130, 246)");

    el.contentWindow!.postMessage(
      { type: "jad-archify-status", nodes: [{ id: "tools-call_1", status: "done" }] },
      "*",
    );
    await sleep(50);
    expect(node("tools-call_1").getAttribute("data-jad-status")).toBe("done");
    expect(getComputedStyle(node("tools-call_1").querySelector("rect.c-frontend")!).stroke).toBe(
      "rgb(34, 197, 94)",
    );
    // Unknown statuses and malformed entries are ignored.
    el.contentWindow!.postMessage(
      { type: "jad-archify-status", nodes: [{ id: "start", status: "exploded" }, null] },
      "*",
    );
    await sleep(50);
    expect(node("start").getAttribute("data-jad-status")).toBe("done");
    expect(loads()).toBe(1);
  });

  it("posts jad-archify-select with the clicked node id", async () => {
    const { el, node } = await mount();
    const received = new Promise<unknown>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (event.source !== el.contentWindow) return;
        if ((event.data as { type?: string })?.type !== "jad-archify-select") return;
        window.removeEventListener("message", onMessage);
        resolve(event.data);
      };
      window.addEventListener("message", onMessage);
    });
    node("tools-call_1")
      .querySelector("text")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(await received).toEqual({ type: "jad-archify-select", nodeId: "tools-call_1" });
    expect(node("tools-call_1").getAttribute("data-jad-selected")).toBe("true");
  });
});
