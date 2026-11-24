import { afterEach, describe, expect, it } from "vitest";
import { mermaidRuntimeHtml } from "./html.gen";
import { parseMermaidRuntimeMessage, type MermaidRuntimeMessage } from "./messages";

const mountedFrames: HTMLIFrameElement[] = [];

function waitForRuntimeMessage(
  frame: HTMLIFrameElement,
  predicate: (message: MermaidRuntimeMessage) => boolean,
): Promise<MermaidRuntimeMessage> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Timed out waiting for Mermaid runtime"));
    }, 10_000);
    function receive(event: MessageEvent): void {
      if (event.source !== frame.contentWindow) {
        return;
      }
      const message = parseMermaidRuntimeMessage(event.data);
      if (!message || !predicate(message)) {
        return;
      }
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve(message);
    }
    window.addEventListener("message", receive);
  });
}

async function mountRuntime(
  size?: { width: number; height: number },
  options?: { allowSameOrigin?: boolean },
): Promise<HTMLIFrameElement> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  if (options?.allowSameOrigin) {
    frame.sandbox.add("allow-same-origin");
  }
  if (size) {
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
  }
  const ready = waitForRuntimeMessage(frame, (message) => message.type === "bridgeReady");
  frame.srcdoc = mermaidRuntimeHtml;
  document.body.append(frame);
  mountedFrames.push(frame);
  await ready;
  return frame;
}

function render(
  frame: HTMLIFrameElement,
  input: { revision: number; source: string },
): Promise<MermaidRuntimeMessage> {
  const response = waitForRuntimeMessage(
    frame,
    (message) =>
      message.type !== "bridgeReady" &&
      "revision" in message &&
      message.revision === input.revision,
  );
  frame.contentWindow?.postMessage(
    {
      type: "render",
      revision: input.revision,
      source: input.source,
      colorScheme: "dark",
      interactive: false,
    },
    "*",
  );
  return response;
}

afterEach(() => {
  for (const frame of mountedFrames.splice(0)) {
    frame.remove();
  }
});

describe("Mermaid labels containing @", () => {
  /**
   * Agents often write a label that starts with a mention or holds an email address. Mermaid 11
   * read the text up to the "@" as an edge id, so these diagrams failed to parse.
   */
  it.each([
    "flowchart LR\n  F[@mention in any workspace] --> G[Look up token]",
    "flowchart LR\n  A[ops@example.com] --> B",
    "flowchart LR\n  A -->|@user approves| B",
    "graph TD\n  A(@x) --> B{@x?}",
  ])("renders a flowchart whose label contains an @: %s", async (source) => {
    const frame = await mountRuntime();

    const result = await render(frame, { revision: 1, source });

    expect(result).toMatchObject({ type: "rendered", revision: 1, source });
  });

  it("still renders a flowchart edge id", async () => {
    const frame = await mountRuntime();
    const source = "flowchart LR\n  A[Start] e1@--> B[End]";

    const result = await render(frame, { revision: 1, source });

    expect(result).toMatchObject({ type: "rendered", revision: 1, source });
  });
});
