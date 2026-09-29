/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spec 23.4: an archify version loads its HTML via forum.diagram.html.request and shows it in the
// sandboxed frame; not_found / failures / no host show a status instead.

vi.mock("react-native", () => ({
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Pressable: ({ children, onPress }: { children?: React.ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));

vi.mock("react-native-unistyles", () => ({
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./archify-frame", () => ({
  ArchifyFrame: ({ document, height }: { document: string; height: number }) => (
    <iframe data-testid="frame" sandbox="allow-scripts" srcDoc={document} height={height} />
  ),
}));

import { ArchifyDiagramView } from "./archify-diagram-view";

beforeEach(() => vi.stubGlobal("React", React));

const NO_STYLE = {};
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function fakeClient(impl: () => Promise<string | null>) {
  const forumDiagramHtml = vi.fn(impl);
  return { client: { forumDiagramHtml } as unknown as DaemonClient, forumDiagramHtml };
}

async function mount(client: DaemonClient | null, diagramId: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ArchifyDiagramView
        client={client}
        topicId="forum_a1b2c3"
        diagramId={diagramId}
        replayToken={0}
        statusTextStyle={NO_STYLE}
        retryTextStyle={NO_STYLE}
      />,
    );
  });
  return container;
}

describe("ArchifyDiagramView", () => {
  it("fetches the rendered HTML and shows it in the sandbox document", async () => {
    const { client, forumDiagramHtml } = fakeClient(async () => "<svg data-x></svg>");
    const view = await mount(client, "diagram_ok");
    expect(forumDiagramHtml).toHaveBeenCalledWith({
      topicId: "forum_a1b2c3",
      diagramId: "diagram_ok",
    });
    const frame = view.querySelector('[data-testid="frame"]')!;
    const doc = frame.getAttribute("srcdoc")!;
    expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc).toContain("<svg data-x></svg>");
    expect(doc).toContain('var scheme="dark"');
  });

  it("reports a version whose HTML is gone", async () => {
    const { client } = fakeClient(async () => null);
    const view = await mount(client, "diagram_gone");
    expect(view.textContent).toContain("forumArch.notFound");
    expect(view.querySelector('[data-testid="frame"]')).toBeNull();
  });

  it("offers a retry after a failed request", async () => {
    let calls = 0;
    const { client, forumDiagramHtml } = fakeClient(async () => {
      calls += 1;
      if (calls === 1) throw new Error("timeout");
      return "<svg></svg>";
    });
    const view = await mount(client, "diagram_retry");
    expect(view.textContent).toContain("forumArch.loadFailed");
    await act(async () => {
      view.querySelector("button")!.click();
    });
    expect(forumDiagramHtml).toHaveBeenCalledTimes(2);
    expect(view.querySelector('[data-testid="frame"]')).not.toBeNull();
  });

  it("asks for a host connection when there is no client", async () => {
    const view = await mount(null, "diagram_offline");
    expect(view.textContent).toContain("forumArch.offline");
  });
});
