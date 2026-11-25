import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SshCommandHistoryEntry,
  SshSnippet,
  SshSnippetPackage,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { i18n as testI18n } from "@/i18n/i18next";
import { createSnippetsApi } from "./api";
import { CommandHistoryList } from "./command-history-list";
import type { SshRpcIo, SshRpcRequest } from "./rpc-io";
import type { SnippetWorkspacePlan } from "./snippet-input";
import { SnippetLibrary } from "./snippet-library";

void testI18n;

beforeEach(() => vi.stubGlobal("React", React));

// The Snippets tab in a real browser against a scripted daemon: every request type gets the
// payload the daemon sends for it. The daemon
// side is covered by packages/server/src/server/ssh/snippets/service.sshd.e2e.test.ts.
// A reply may set `error`, with its result fields null, exactly like the daemon.

type Reply = (message: SshRpcRequest) => Record<string, unknown>;

function scriptedDaemon(replies: Record<string, Reply>) {
  const requests: SshRpcRequest[] = [];
  const handlers = new Set<(message: unknown) => void>();
  const io: SshRpcIo = {
    send(message) {
      requests.push(message);
      const reply = replies[message.type];
      if (!reply) throw new Error(`unexpected ${message.type}`);
      const payload = { requestId: message.requestId, error: null, ...reply(message) };
      const response = { type: message.type.replace(/\.request$/, ".response"), payload };
      setTimeout(() => {
        for (const handler of Array.from(handlers)) handler(response);
      }, 0);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return { api: createSnippetsApi(io, "host_test"), requests };
}

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
  container.style.height = "900px";
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  mounted.push({ root, container });
  return within(container);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

function press(element: HTMLElement): void {
  act(() => element.click());
}

function type(element: HTMLElement, value: string): void {
  act(() => {
    fireEvent.change(element, { target: { value } });
  });
}

const deploy: SshSnippetPackage = {
  id: "pkg_deploy",
  label: "Deploy",
};
const restart: SshSnippet = {
  id: "snp_restart",
  label: "Restart app",
  script: "systemctl restart app",
  packageId: deploy.id,
  defaultTargets: [],
  createdAtMs: 1,
  updatedAtMs: 1,
};
const kernel: SshSnippet = { ...restart, id: "snp_kernel", label: "Kernel", script: "uname -a" };
delete kernel.packageId;

const servers = [
  { id: "srv_web1", label: "web-1", groupId: "grp_prod" },
  { id: "srv_web2", label: "web-2", groupId: "grp_prod_eu" },
  { id: "srv_dev", label: "dev-1", groupId: "grp_dev" },
];
const groups = [
  { id: "grp_prod", label: "Production" },
  { id: "grp_prod_eu", label: "EU", parentId: "grp_prod" },
  { id: "grp_dev", label: "Dev" },
];

function library(api: ReturnType<typeof scriptedDaemon>["api"], onRun = vi.fn()) {
  return mount(
    <SnippetLibrary
      api={api}
      servers={servers}
      groups={groups}
      onRunInWorkspace={onRun}
      onRunStarted={vi.fn()}
    />,
  );
}

describe("SnippetLibrary", () => {
  it("renames a package and keeps a rename failure visible", async () => {
    let fail = true;
    const daemon = scriptedDaemon({
      "ssh.snippets.list.request": () => ({ packages: [deploy], snippets: [restart, kernel] }),
      "ssh.snippets.save_package.request": (message) =>
        fail
          ? { error: "snippets.json is read-only", package: null }
          : { package: { ...deploy, ...(message.package as object) } },
    });
    const view = library(daemon.api);
    await settle();

    press(view.getByRole("button", { name: "Rename" }));
    type(view.getByTestId("ssh-snippet-package-rename-input-pkg_deploy"), "Release");
    press(view.getByTestId("ssh-snippet-package-rename-save-pkg_deploy"));
    await settle();

    expect(view.getByText("Could not save the package")).toBeTruthy();
    expect(view.getByText("snippets.json is read-only")).toBeTruthy();

    fail = false;
    press(view.getByTestId("ssh-snippet-package-rename-save-pkg_deploy"));
    await settle();

    expect(daemon.requests.at(-2)).toMatchObject({
      type: "ssh.snippets.save_package.request",
      package: { id: "pkg_deploy", label: "Release" },
    });
    expect(view.queryByTestId("ssh-snippet-package-rename-pkg_deploy")).toBeNull();
  });

  it("deletes a package only after confirming, saying its snippets are kept", async () => {
    const daemon = scriptedDaemon({
      "ssh.snippets.list.request": () => ({ packages: [deploy], snippets: [restart] }),
      "ssh.snippets.delete_package.request": () => ({}),
    });
    const view = library(daemon.api);
    await settle();

    press(view.getByTestId("ssh-snippet-package-delete-pkg_deploy"));

    expect(view.getByText("Its snippets move to No package.")).toBeTruthy();
    expect(daemon.requests.map((request) => request.type)).toEqual(["ssh.snippets.list.request"]);

    press(view.getByTestId("ssh-snippet-package-confirm-delete-pkg_deploy"));
    await settle();

    expect(daemon.requests).toContainEqual(
      expect.objectContaining({ type: "ssh.snippets.delete_package.request", id: "pkg_deploy" }),
    );
  });

  it("finds snippets by package name and collapses packages", async () => {
    const daemon = scriptedDaemon({
      "ssh.snippets.list.request": () => ({ packages: [deploy], snippets: [restart, kernel] }),
    });
    const view = library(daemon.api);
    await settle();

    press(view.getByTestId("ssh-snippet-package-toggle-pkg_deploy"));
    expect(view.queryByText("Restart app")).toBeNull();

    type(view.getByTestId("ssh-snippet-search"), "deploy");
    expect(view.getByText("Restart app")).toBeTruthy();
    expect(view.queryByText("Kernel")).toBeNull();

    type(view.getByTestId("ssh-snippet-search"), "nothing-like-this");
    expect(view.getByText('No snippets match "nothing-like-this"')).toBeTruthy();
  });

  it("runs on a whole group in a new workspace, one pane per server (criterion 9)", async () => {
    const daemon = scriptedDaemon({
      "ssh.snippets.list.request": () => ({ packages: [deploy], snippets: [restart] }),
    });
    const onRun = vi.fn<(plan: SnippetWorkspacePlan) => void>();
    const view = library(daemon.api, onRun);
    await settle();

    press(view.getByTestId("ssh-snippet-run-on-snp_restart"));
    press(view.getByTestId("ssh-snippet-target-group-grp_prod"));

    expect(view.getByText("2 selected")).toBeTruthy();

    press(view.getByTestId("ssh-snippet-run-workspace"));

    expect(onRun).toHaveBeenCalledTimes(1);
    const plan = onRun.mock.calls[0][0];
    expect(plan.inputByPaneId).toEqual({
      pane_srv_web1: "systemctl restart app\r",
      pane_srv_web2: "systemctl restart app\r",
    });
  });
});

describe("CommandHistoryList", () => {
  const entries: SshCommandHistoryEntry[] = [
    { command: "docker ps", source: "input", atMs: 2 },
    { command: "uname -a", source: "snippet", atMs: 1 },
  ];

  it("searches the history and acknowledges Save as snippet", async () => {
    const daemon = scriptedDaemon({
      "ssh.history.list.request": () => ({ entries }),
      "ssh.snippets.list.request": () => ({ packages: [], snippets: [] }),
      "ssh.snippets.save.request": (message) => ({
        snippet: { ...restart, ...(message.snippet as object), id: "snp_new" },
      }),
    });
    const view = mount(
      <CommandHistoryList api={daemon.api} serverId="srv_web1" servers={servers} />,
    );
    await settle();

    type(view.getByTestId("ssh-command-history-search"), "DOCKER");
    expect(view.getByText("docker ps")).toBeTruthy();
    expect(view.queryByText("uname -a")).toBeNull();

    press(view.getByRole("button", { name: "Save as snippet" }));
    await settle();
    press(view.getByRole("button", { name: "Save snippet" }));
    await settle();

    expect(daemon.requests).toContainEqual(
      expect.objectContaining({
        type: "ssh.snippets.save.request",
        snippet: expect.objectContaining({ script: "docker ps", defaultTargets: ["srv_web1"] }),
      }),
    );
    expect(view.getByTestId("ssh-command-history-saved").textContent).toBe(
      "Saved as a snippet: docker ps",
    );
  });

  it("clears the history only after confirming", async () => {
    const daemon = scriptedDaemon({
      "ssh.history.list.request": () => ({ entries }),
      "ssh.history.clear.request": () => ({}),
    });
    const view = mount(
      <CommandHistoryList api={daemon.api} serverId="srv_web1" servers={servers} />,
    );
    await settle();

    press(view.getByTestId("ssh-command-history-clear"));
    expect(daemon.requests.map((request) => request.type)).toEqual(["ssh.history.list.request"]);

    press(view.getByTestId("ssh-command-history-confirm-clear"));
    await settle();

    expect(daemon.requests).toContainEqual(
      expect.objectContaining({ type: "ssh.history.clear.request", serverId: "srv_web1" }),
    );
  });
});
