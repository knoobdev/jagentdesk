/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useSessionStore } from "@/stores/session-store";
import { BuiltinPluginGate } from "./gate";

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession("one");
  useSessionStore.getState().clearSession("two");
});
it("hides and restores contributions live for only the changed host", () => {
  const store = useSessionStore.getState();
  store.initializeSession("one", null);
  store.initializeSession("two", null);
  const info = (serverId: string, docker: boolean) => ({
    status: "server_info" as const,
    serverId,
    hostname: "host",
    version: "0.9.59",
    features: { builtinPlugins: true, docker },
  });
  store.updateSessionServerInfo("one", info("one", true));
  store.updateSessionServerInfo("two", info("two", true));
  render(
    <>
      <BuiltinPluginGate serverId="one" id="docker">
        <span>First Docker</span>
      </BuiltinPluginGate>
      <BuiltinPluginGate serverId="two" id="docker">
        <span>Second Docker</span>
      </BuiltinPluginGate>
    </>,
  );
  expect(screen.queryByText("First Docker")?.textContent).toBe("First Docker");
  act(() => store.updateSessionServerInfo("one", info("one", false)));
  expect(screen.queryByText("First Docker")).toBe(null);
  expect(screen.queryByText("Second Docker")?.textContent).toBe("Second Docker");
  act(() => store.updateSessionServerInfo("one", info("one", true)));
  expect(screen.queryByText("First Docker")?.textContent).toBe("First Docker");
});
