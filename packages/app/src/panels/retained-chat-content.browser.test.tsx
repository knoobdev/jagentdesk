import React, { act, Profiler } from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect } from "vitest";
import { useAgentStreamTail } from "@/agent-stream/use-agent-stream-tail";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { RetainedChatContent as NativeChat } from "./retained-chat-content.js";
import { RetainedChatContent as WebChat } from "./retained-chat-content.web";
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
for (const [runtime, Chat] of [
  ["native", NativeChat],
  ["web", WebChat],
] as const) {
  it(`${runtime} ignores hidden stream chunks and reads the latest transcript on reveal`, async () => {
    const serverId = `hidden-stream-${runtime}`;
    const agentId = "background-agent";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null);
    const profile = {
      commits: 0,
      onRender() {
        profile.commits++;
      },
    };
    const publish = (text: string) => {
      const item: StreamItem = {
        id: "message",
        kind: "assistant_message",
        text,
        timestamp: new Date(),
      };
      store.setAgentStreamTail(serverId, new Map([[agentId, [item]]]));
    };
    function Content() {
      const items = useAgentStreamTail(serverId, agentId);
      const [draft] = useState("unsent draft");
      return (
        <span>
          {draft}:{items?.[0]?.kind === "assistant_message" ? items[0].text : ""}
        </span>
      );
    }
    const show = (active: boolean) =>
      act(() =>
        root.render(
          <Profiler id="workspace" onRender={profile.onRender}>
            <RetainedPanelActivity active={active}>
              <Chat>
                <Content />
              </Chat>
            </RetainedPanelActivity>
          </Profiler>,
        ),
      );
    try {
      publish("first chunk");
      show(true);
      expect(container.textContent).toBe("unsent draft:first chunk");
      show(false);
      const hiddenCommits = profile.commits;
      for (let index = 0; index < 10; index++) {
        await act(async () => publish(`chunk ${index}`));
      }
      expect(profile.commits).toBe(hiddenCommits);
      show(true);
      expect(container.textContent).toBe("unsent draft:chunk 9");
      await act(async () => publish("live after reveal"));
      expect(container.textContent).toBe("unsent draft:live after reveal");
    } finally {
      act(() => root.render(null));
      store.clearSession(serverId);
    }
  });
}
