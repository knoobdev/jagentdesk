import { describe, expect, it } from "vitest";
import { LiveBrowserTabs, type LiveBrowserTab } from "./live-tabs";
import { JAgentDeskBrowserWebviewRegistry } from "./registry";

const HOST = 1;
const OTHER_HOST = 2;

function setup() {
  const registry = new JAgentDeskBrowserWebviewRegistry();
  const published: Array<{ host: number; tabs: LiveBrowserTab[] }> = [];
  const pending: Array<() => void> = [];
  const live = new LiveBrowserTabs({
    registry,
    publish: (host, tabs) => published.push({ host, tabs }),
    schedule: (flush) => pending.push(flush),
  });
  const flush = () => {
    for (const run of pending.splice(0)) run();
  };
  return { registry, live, published, flush };
}

describe("LiveBrowserTabs", () => {
  it("lists every attached guest of a host, registered or not", () => {
    const { registry, live } = setup();
    live.attach({ webContentsId: 10, hostWebContentsId: HOST, url: "", title: "" });
    live.attach({ webContentsId: 11, hostWebContentsId: HOST, url: "", title: "" });
    live.attach({ webContentsId: 20, hostWebContentsId: OTHER_HOST, url: "", title: "" });
    registry.registerWebContents({
      webContentsId: 10,
      browserId: "tab-a",
      hostWebContentsId: HOST,
    });
    registry.registerWorkspace({ browserId: "tab-a", workspaceId: "ws-1" });

    expect(live.listForHost(HOST)).toEqual([
      {
        webContentsId: 10,
        browserId: "tab-a",
        workspaceId: "ws-1",
        url: "",
        title: "",
        faviconUrl: null,
        status: "ready",
      },
      {
        webContentsId: 11,
        browserId: null,
        workspaceId: null,
        url: "",
        title: "",
        faviconUrl: null,
        status: "ready",
      },
    ]);
    expect(live.listForHost(OTHER_HOST).map((tab) => tab.webContentsId)).toEqual([20]);
  });

  it("reports crashed over not responding over loading", () => {
    const { live } = setup();
    live.attach({ webContentsId: 10, hostWebContentsId: HOST, url: "", title: "" });
    const status = () => live.listForHost(HOST)[0]?.status;

    live.update(10, { loading: true });
    expect(status()).toBe("loading");
    live.update(10, { notResponding: true });
    expect(status()).toBe("notResponding");
    live.update(10, { crashed: true });
    expect(status()).toBe("crashed");
    live.update(10, { crashed: false, notResponding: false, loading: false, unresponsive: true });
    expect(status()).toBe("notResponding");
    live.update(10, { unresponsive: false });
    expect(status()).toBe("ready");
  });

  it("publishes one coalesced list per changed host and an empty list after the last close", () => {
    const { registry, live, published, flush } = setup();
    live.attach({ webContentsId: 10, hostWebContentsId: HOST, url: "", title: "" });
    live.update(10, { url: "http://localhost:5173/", loading: true });
    live.update(10, { title: "Dev server", loading: false });
    registry.registerWebContents({
      webContentsId: 10,
      browserId: "tab-a",
      hostWebContentsId: HOST,
    });
    flush();

    expect(published).toEqual([
      {
        host: HOST,
        tabs: [
          {
            webContentsId: 10,
            browserId: "tab-a",
            workspaceId: null,
            url: "http://localhost:5173/",
            title: "Dev server",
            faviconUrl: null,
            status: "ready",
          },
        ],
      },
    ]);

    published.length = 0;
    live.update(10, { title: "Dev server" });
    flush();
    expect(published).toEqual([]);

    live.detach(10);
    flush();
    expect(published).toEqual([{ host: HOST, tabs: [] }]);
  });

  it("republishes when the registry assigns a workspace", () => {
    const { registry, live, published, flush } = setup();
    live.attach({ webContentsId: 10, hostWebContentsId: HOST, url: "", title: "" });
    registry.registerWebContents({
      webContentsId: 10,
      browserId: "tab-a",
      hostWebContentsId: HOST,
    });
    flush();
    published.length = 0;

    registry.registerWorkspace({ browserId: "tab-a", workspaceId: "ws-2" });
    flush();
    expect(published.map(({ tabs }) => tabs[0]?.workspaceId)).toEqual(["ws-2"]);
  });

  it("ignores updates for guests it does not track", () => {
    const { live, published, flush } = setup();
    live.update(99, { crashed: true });
    live.detach(99);
    flush();
    expect(published).toEqual([]);
    expect(live.count()).toBe(0);
  });
});
