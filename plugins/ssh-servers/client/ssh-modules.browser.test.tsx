import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshTransfer } from "@jagentdesk/protocol/ssh/sftp-schemas";
import type { ForwardingRule } from "@jagentdesk/protocol/ssh/forwarding-schemas";
import { i18n as testI18n } from "@/i18n/i18next";
import type { SshModuleTransport } from "./module-rpc";
import { createSftpApi } from "./sftp/api";
import type { SftpApi } from "./sftp/api";
import { SftpPane, type SftpEndpointOption, type SftpPaneState } from "./sftp/sftp-pane";
import { SftpTransferQueue } from "./sftp/transfer-queue";
import { useTransferStore } from "./sftp/transfer-store";
import { createForwardingApi } from "./forwarding/api";
import { PortForwardingList } from "./forwarding/forwarding-list";

void testI18n;

beforeEach(() => vi.stubGlobal("React", React));

// Renders the SSH module screens in a real browser against a scripted daemon: each request type
// gets the response the daemon sends for it. The daemon side itself is covered by the
// real-sshd tests in packages/server/src/server/ssh/.

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}
const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  container.style.width = "1200px";
  container.style.height = "800px";
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  mounted.push({ root, container });
  return within(container);
}

function scriptedDaemon(replies: Record<string, (message: Record<string, unknown>) => unknown>) {
  const requests: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, Set<(message: unknown) => void>>();
  const transport: SshModuleTransport = {
    async request(message) {
      requests.push(message);
      const reply = replies[message.type];
      if (!reply) throw new Error(`unexpected ${message.type}`);
      return {
        type: message.type.replace(/\.request$/, ".response"),
        payload: { requestId: "req", ...(reply(message) as object) },
      };
    },
    subscribe(type, handler) {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
  };
  return { transport, requests };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const ENDPOINT_OPTIONS: SftpEndpointOption[] = [
  { endpoint: { kind: "daemon" }, label: "Local" },
  { endpoint: { kind: "server", serverId: "srv_a1b2c3" }, label: "web-1" },
];
const COPY_TARGET = { endpoint: { kind: "daemon" } as const, dir: "/home/user", label: "Local" };
const SERVER_HOME: SftpPaneState = {
  endpoint: { kind: "server", serverId: "srv_a1b2c3" },
  path: "",
  showHidden: false,
};
const DAEMON_ROOT: SftpPaneState = {
  endpoint: { kind: "daemon" },
  path: "/root",
  showHidden: false,
};

function noop(): void {}

// One pane plus the transfer queue — the desktop SftpBrowser minus its compact-layout tabs.
function PaneWithQueue({ api, initial }: { api: SftpApi; initial: SftpPaneState }) {
  const [state, setState] = React.useState(initial);
  const { store, state: transfers } = useTransferStore(api);
  return (
    <>
      <SftpPane
        api={api}
        scope="host_a1b2c3"
        state={state}
        onChange={setState}
        endpointOptions={ENDPOINT_OPTIONS}
        copyTarget={COPY_TARGET}
        compact={false}
        onOpenFile={noop}
        onTransfersQueued={noop}
      />
      <SftpTransferQueue api={api} store={store} state={transfers} />
    </>
  );
}

const entry = (name: string, kind: "file" | "directory", path: string) => ({
  name,
  path,
  kind,
  size: kind === "file" ? 2048 : 4096,
  modifiedAtMs: 1_700_000_000_000,
  mode: kind === "file" ? 0o644 : 0o755,
  permissions: kind === "file" ? "rw-r--r--" : "rwxr-xr-x",
});

const conflicted: SshTransfer = {
  id: "xfr_a1b2c3",
  source: { kind: "server", serverId: "srv_a1b2c3" },
  sourcePath: "/srv/app/config.yml",
  target: { kind: "daemon" },
  targetPath: "/home/user/config.yml",
  kind: "file",
  status: "conflict",
  bytesTotal: 2048,
  bytesTransferred: 0,
  filesTotal: 1,
  filesDone: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
};

describe("SFTP pane and transfer queue", () => {
  it("lists a server folder, opens a subfolder, and resolves a conflict with keep-both", async () => {
    const daemon = scriptedDaemon({
      "ssh.sftp.list.request": (message) => {
        if (message.path === "/srv/app/logs") {
          return {
            error: null,
            path: "/srv/app/logs",
            parentPath: "/srv/app",
            entries: [entry("access.log", "file", "/srv/app/logs/access.log")],
          };
        }
        return {
          error: null,
          path: "/srv/app",
          parentPath: "/srv",
          entries: [
            entry("logs", "directory", "/srv/app/logs"),
            entry("config.yml", "file", "/srv/app/config.yml"),
          ],
        };
      },
      "ssh.transfer.list.request": () => ({ error: null, transfers: [conflicted] }),
      "ssh.transfer.start.request": () => ({
        error: null,
        transfer: { ...conflicted, status: "queued", conflict: "keep-both", updatedAtMs: 2 },
      }),
    });
    const view = mount(
      <PaneWithQueue api={createSftpApi(daemon.transport)} initial={SERVER_HOME} />,
    );
    await settle();

    expect(view.getByRole("button", { name: "logs" })).toBeTruthy();
    expect(view.getByRole("button", { name: "config.yml" })).toBeTruthy();
    expect(view.getByText("rw-r--r--")).toBeTruthy();

    act(() => view.getByRole("button", { name: "logs" }).click());
    await settle();
    expect(view.getByRole("button", { name: "access.log" })).toBeTruthy();
    expect(daemon.requests).toContainEqual({
      type: "ssh.sftp.list.request",
      endpoint: { kind: "server", serverId: "srv_a1b2c3" },
      path: "/srv/app/logs",
      showHidden: false,
    });
    expect(view.getByText("config.yml already exists in the destination")).toBeTruthy();

    act(() => view.getByRole("button", { name: "Keep both" }).click());
    await settle();

    expect(daemon.requests.at(-1)).toMatchObject({
      type: "ssh.transfer.start.request",
      transferId: "xfr_a1b2c3",
      conflict: "keep-both",
    });
    expect(view.queryByText("Already exists")).toBeNull();
    expect(view.getByText("Queued")).toBeTruthy();
  });

  it("keeps a folder load failure visible with a retry", async () => {
    const daemon = scriptedDaemon({
      "ssh.sftp.list.request": () => ({
        error: { code: "permission_denied", message: "Permission denied" },
        path: null,
        parentPath: null,
        entries: [],
      }),
      "ssh.transfer.list.request": () => ({ error: null, transfers: [] }),
    });
    const view = mount(
      <PaneWithQueue api={createSftpApi(daemon.transport)} initial={DAEMON_ROOT} />,
    );
    await settle();

    expect(view.getByText("Could not open this folder")).toBeTruthy();
    expect(view.getByText("Permission denied")).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(view.getByText("No transfers")).toBeTruthy();
  });
});

describe("PortForwardingList", () => {
  const rule: ForwardingRule = {
    id: "fwd_a1b2c3",
    label: "Postgres",
    kind: "local",
    serverId: "srv_a1b2c3",
    bindAddress: "127.0.0.1",
    bindPort: 15432,
    destHost: "db",
    destPort: 5432,
    createdAtMs: 1,
    updatedAtMs: 1,
  };

  it("shows a port_in_use start failure on the rule", async () => {
    const daemon = scriptedDaemon({
      "ssh.forward.list.request": () => ({ error: null, rules: [rule], states: [] }),
      "ssh.forward.start.request": () => ({
        error: { code: "port_in_use", message: "Port 15432 on 127.0.0.1 is already in use" },
        state: {
          ruleId: rule.id,
          status: "error",
          activeConnections: 0,
          error: { code: "port_in_use", message: "Port 15432 on 127.0.0.1 is already in use" },
          changedAtMs: 2,
        },
      }),
    });
    const view = mount(
      <PortForwardingList
        api={createForwardingApi(daemon.transport)}
        servers={[{ serverId: "srv_a1b2c3", label: "web-1" }]}
      />,
    );
    await settle();

    expect(view.getByText("Postgres")).toBeTruthy();
    expect(view.getByText("127.0.0.1:15432")).toBeTruthy();
    expect(view.getByText("db:5432")).toBeTruthy();
    expect(view.getByText("Stopped")).toBeTruthy();

    act(() => view.getByRole("button", { name: "Start" }).click());
    await settle();

    expect(daemon.requests.at(-1)).toMatchObject({
      type: "ssh.forward.start.request",
      id: rule.id,
    });
    expect(view.getByRole("alert").textContent).toContain(
      "Port 15432 on 127.0.0.1 is already in use",
    );
  });
});
