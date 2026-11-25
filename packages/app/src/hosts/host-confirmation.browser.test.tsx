import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { HostConfirmationRequest } from "@/runtime/host-confirmation";
import { i18n } from "@/i18n/i18next";
import { HostConfirmationSheet } from "./host-confirmation-sheet";

// Keep this browser test at the rendered store boundary. The real confirmation
// model and its persistence gate are covered separately without native Expo APIs.
const state = vi.hoisted(() => ({
  pending: null as HostConfirmationRequest | null,
  answers: [] as boolean[],
  listeners: new Set<() => void>(),
}));
vi.mock("@/runtime/host-runtime", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useHostConfirmation: () => ({
      pending: useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.pending,
      ),
      answer: (approved: boolean) => {
        state.answers.push(approved);
        state.pending = null;
        for (const listener of state.listeners) listener();
      },
    }),
  };
});
void i18n;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  state.pending = null;
  state.answers = [];
});
function ask() {
  state.pending = {
    id: 1,
    kind: "changedConnection",
    serverId: "browser-confirm-host",
    keyFingerprint: "aaaa bbbb cccc dddd eeee ffff 1111 2222",
    previousKeyFingerprint: "1111 2222 3333 4444 5555 6666 7777 8888",
    keyChanged: true,
    routes: "Relay: ws://127.0.0.1:6934",
    previousRoutes: "Tailscale: ws://100.64.0.1:6767",
  };
  for (const listener of state.listeners) listener();
}
it("renders changed host details and forwards cancellation and approval", async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<HostConfirmationSheet />);
    ask();
  });
  await expect
    .poll(() => document.querySelector('[data-testid="host-confirmation-server-id"]')?.textContent)
    .toBe("browser-confirm-host");
  expect(document.body.textContent).toContain("Warning: the daemon key has changed");
  expect(document.body.textContent).toContain("100.64.0.1:6767");
  expect(document.querySelector('[data-testid="host-confirmation-fingerprint"]')?.textContent).toBe(
    state.pending!.keyFingerprint,
  );
  await act(async () => {
    document.querySelector<HTMLElement>('[data-testid="host-confirmation-cancel"]')!.click();
  });
  expect(state.answers).toEqual([false]);
  await act(async () => {
    ask();
  });
  await expect
    .poll(() => document.querySelector('[data-testid="host-confirmation-connect"]'))
    .not.toBeNull();
  await act(async () => {
    document.querySelector<HTMLElement>('[data-testid="host-confirmation-connect"]')!.click();
  });
  expect(state.answers).toEqual([false, true]);
});
