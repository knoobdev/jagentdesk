import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useAgentAutocomplete } from "./use-agent-autocomplete";

vi.mock("@/agent-commands", () => ({
  useAutocompleteCommands: () => ({ commands: [], isLoading: false, isError: false, error: null }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { host: { agents: new Map([["agent", { cwd: "/repo" }]]) } } }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let menu: ReturnType<typeof useAgentAutocomplete>;
const execute = vi.fn();
const setInput = vi.fn();
function Harness() {
  menu = useAgentAutocomplete({
    serverId: "host",
    agentId: "agent",
    userInput: "/ex",
    cursorIndex: 3,
    setUserInput: setInput,
    onClientSlashCommand: execute,
    canExecuteClientSlashCommand: true,
  });
  return null;
}
function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  expect(menu.options[menu.selectedIndex].id).toBe("exit");
}
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

it.each(["Tab", "Enter"])(
  "does not execute an old /exit suggestion on %s after the live text changed",
  (key) => {
    mount();
    const preventDefault = vi.fn();
    act(() =>
      expect(
        menu.onKeyPress({
          key,
          preventDefault,
          input: { text: "/hello", selection: { start: 6, end: 6 } },
        }),
      ).toBe(true),
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(setInput).not.toHaveBeenCalled();
  },
);
it.each(["Tab", "Enter"])(
  "executes the current suggestion on %s when its live range still matches",
  (key) => {
    mount();
    act(() =>
      menu.onKeyPress({
        key,
        preventDefault: vi.fn(),
        input: { text: "/ex", selection: { start: 3, end: 3 } },
      }),
    );
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: "exit" }));
  },
);
it("rejects a matching query at a different cursor range", () => {
  mount();
  act(() =>
    menu.onKeyPress({
      key: "Enter",
      preventDefault: vi.fn(),
      input: { text: "prefix /ex", selection: { start: 10, end: 10 } },
    }),
  );
  expect(execute).not.toHaveBeenCalled();
});
it("lets a pointer choose the visible suggestion", () => {
  mount();
  act(() => menu.onSelectOption(menu.options[menu.selectedIndex]));
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ name: "exit" }));
});
