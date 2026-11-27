import type { JAgentDeskBrowserWebviewRegistry } from "./registry.js";

// Spec 04 §27d.1–2: every live browser webview, parked or visible, is listed in the sidebar
// footer. Main owns the list because only main sees every guest WebContents — including one
// that attached but never registered a browser id — and its crash/hang events.

export const BROWSER_LIVE_TABS_EVENT = "jagentdesk:event:browser-live-tabs";

export type LiveBrowserTabStatus = "ready" | "loading" | "notResponding" | "crashed";

export interface LiveBrowserTab {
  webContentsId: number;
  browserId: string | null;
  workspaceId: string | null;
  url: string;
  title: string;
  faviconUrl: string | null;
  status: LiveBrowserTabStatus;
}

interface GuestState {
  hostWebContentsId: number;
  url: string;
  title: string;
  faviconUrl: string | null;
  loading: boolean;
  unresponsive: boolean;
  /** Set from outside, e.g. when a CDP identity apply never answers (spec 04 §27d.3). */
  notResponding: boolean;
  crashed: boolean;
}

export type LiveBrowserTabPatch = Partial<Omit<GuestState, "hostWebContentsId">>;

interface LiveBrowserTabsOptions {
  registry: Pick<
    JAgentDeskBrowserWebviewRegistry,
    "subscribe" | "getRegistrationForWebContents" | "getWorkspaceId"
  >;
  /** Delivers one host window's full list; called at most once per flush per host. */
  publish(hostWebContentsId: number, tabs: LiveBrowserTab[]): void;
  /** Coalesces bursts (title + favicon + stop-loading arrive together). */
  schedule(flush: () => void): void;
}

function statusOf(state: GuestState): LiveBrowserTabStatus {
  if (state.crashed) return "crashed";
  if (state.unresponsive || state.notResponding) return "notResponding";
  if (state.loading) return "loading";
  return "ready";
}

export class LiveBrowserTabs {
  private readonly guests = new Map<number, GuestState>();
  private readonly dirtyHosts = new Set<number>();
  private flushScheduled = false;

  constructor(private readonly options: LiveBrowserTabsOptions) {
    options.registry.subscribe(() => {
      for (const guest of this.guests.values()) {
        this.markDirty(guest.hostWebContentsId);
      }
    });
  }

  public attach(input: {
    webContentsId: number;
    hostWebContentsId: number;
    url: string;
    title: string;
  }): void {
    this.guests.set(input.webContentsId, {
      hostWebContentsId: input.hostWebContentsId,
      url: input.url,
      title: input.title,
      faviconUrl: null,
      loading: false,
      unresponsive: false,
      notResponding: false,
      crashed: false,
    });
    this.markDirty(input.hostWebContentsId);
  }

  public update(webContentsId: number, patch: LiveBrowserTabPatch): void {
    const state = this.guests.get(webContentsId);
    if (!state) return;
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<
      [keyof LiveBrowserTabPatch, LiveBrowserTabPatch[keyof LiveBrowserTabPatch]]
    >) {
      if (value !== undefined && state[key] !== value) {
        (state as unknown as Record<string, unknown>)[key] = value;
        changed = true;
      }
    }
    if (changed) this.markDirty(state.hostWebContentsId);
  }

  public detach(webContentsId: number): void {
    const state = this.guests.get(webContentsId);
    if (!state) return;
    this.guests.delete(webContentsId);
    this.markDirty(state.hostWebContentsId);
  }

  public listForHost(hostWebContentsId: number): LiveBrowserTab[] {
    const tabs: LiveBrowserTab[] = [];
    for (const [webContentsId, state] of this.guests) {
      if (state.hostWebContentsId !== hostWebContentsId) continue;
      const registration = this.options.registry.getRegistrationForWebContents(webContentsId);
      const browserId = registration?.browserId ?? null;
      tabs.push({
        webContentsId,
        browserId,
        workspaceId: browserId ? this.options.registry.getWorkspaceId(browserId) : null,
        url: state.url,
        title: state.title,
        faviconUrl: state.faviconUrl,
        status: statusOf(state),
      });
    }
    return tabs;
  }

  public count(): number {
    return this.guests.size;
  }

  private markDirty(hostWebContentsId: number): void {
    this.dirtyHosts.add(hostWebContentsId);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.options.schedule(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    const hosts = [...this.dirtyHosts];
    this.dirtyHosts.clear();
    for (const hostWebContentsId of hosts) {
      this.options.publish(hostWebContentsId, this.listForHost(hostWebContentsId));
    }
  }
}
