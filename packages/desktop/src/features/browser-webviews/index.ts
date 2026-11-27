import { webContents as allWebContents, type WebContents } from "electron";
import { JAGENTDESK_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  BROWSER_DIALOG_EVENT,
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
  PendingBrowserWindowOpenRequests,
} from "./window-open.js";
import { JAgentDeskBrowserWebviewRegistry } from "./registry.js";
import { BROWSER_LIVE_TABS_EVENT, LiveBrowserTabs, type LiveBrowserTab } from "./live-tabs.js";

export type { LiveBrowserTab, LiveBrowserTabStatus } from "./live-tabs.js";

export {
  BROWSER_LIVE_TABS_EVENT,
  BROWSER_DIALOG_EVENT,
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  PendingBrowserWindowOpenRequests,
};

const browserRegistry = new JAgentDeskBrowserWebviewRegistry();
const LIVE_TABS_PUBLISH_DELAY_MS = 50;
const liveBrowserTabs = new LiveBrowserTabs({
  registry: browserRegistry,
  publish: (hostWebContentsId, tabs) => {
    const host = allWebContents.fromId(hostWebContentsId);
    if (host && !host.isDestroyed()) {
      host.send(BROWSER_LIVE_TABS_EVENT, tabs);
    }
  },
  schedule: (flush) => {
    setTimeout(flush, LIVE_TABS_PUBLISH_DELAY_MS);
  },
});

interface BrowserWebContentsIdentity {
  readonly id: number;
  isDestroyed(): boolean;
}

interface RegisteredBrowserWebContents extends BrowserWebContentsIdentity {
  readonly hostWebContents: BrowserWebContentsIdentity | null;
  readonly session: object;
  setBackgroundThrottling(allowed: boolean): void;
  once(event: "destroyed", listener: () => void): void;
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

interface RegisterAttachedBrowserInput extends AttachedBrowserRegistration {
  sender: BrowserWebContentsIdentity;
  profileSession: object;
  findWebContents(webContentsId: number): RegisteredBrowserWebContents | null;
}

export function isJAgentDeskBrowserWebviewAttach(input: {
  src?: string;
  partition?: string;
}): boolean {
  return (
    isAllowedBrowserWebviewUrl(input.src) &&
    input.partition === JAGENTDESK_BROWSER_PROFILE_PARTITION
  );
}

export function listRegisteredJAgentDeskBrowserIds(): string[] {
  return browserRegistry.listBrowserIds();
}

export function getJAgentDeskBrowserWebviewRegistry(): JAgentDeskBrowserWebviewRegistry {
  return browserRegistry;
}

export function prepareJAgentDeskBrowserWebContents(contents: RegisteredBrowserWebContents): void {
  const webContentsId = contents.id;
  contents.setBackgroundThrottling(false);
  contents.once("destroyed", () => {
    browserRegistry.unregisterWebContents(webContentsId);
  });
}

/**
 * Lists a guest in the host window's "browser tabs open" list for as long as it lives
 * (spec 04 §27d.1). Reads only cached event payloads afterwards, so a crashed or hung guest is
 * never asked for anything.
 */
export function trackJAgentDeskBrowserLiveTab(contents: WebContents): void {
  const host = contents.hostWebContents;
  if (!host || contents.isDestroyed()) {
    return;
  }
  const webContentsId = contents.id;
  liveBrowserTabs.attach({
    webContentsId,
    hostWebContentsId: host.id,
    url: contents.getURL(),
    title: contents.getTitle(),
  });
  contents.on("did-start-loading", () => {
    liveBrowserTabs.update(webContentsId, { loading: true, crashed: false });
  });
  contents.on("did-stop-loading", () => {
    liveBrowserTabs.update(webContentsId, { loading: false });
  });
  contents.on("did-navigate", (_event, url) => {
    liveBrowserTabs.update(webContentsId, { url, faviconUrl: null });
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) liveBrowserTabs.update(webContentsId, { url });
  });
  contents.on("page-title-updated", (_event, title) => {
    liveBrowserTabs.update(webContentsId, { title });
  });
  contents.on("page-favicon-updated", (_event, favicons) => {
    liveBrowserTabs.update(webContentsId, { faviconUrl: favicons[0] ?? null });
  });
  contents.on("unresponsive", () => {
    liveBrowserTabs.update(webContentsId, { unresponsive: true });
  });
  contents.on("responsive", () => {
    liveBrowserTabs.update(webContentsId, { unresponsive: false });
  });
  contents.on("render-process-gone", () => {
    liveBrowserTabs.update(webContentsId, { crashed: true, loading: false });
  });
  contents.once("destroyed", () => {
    liveBrowserTabs.detach(webContentsId);
  });
}

/**
 * Marks a guest "Not responding" in the browser tabs list, or clears it. Integration point for
 * a CDP command that never answers (spec 04 §27d.3: identity apply timing out after 10 s).
 */
export function setJAgentDeskBrowserNotResponding(
  webContentsId: number,
  notResponding: boolean,
): void {
  liveBrowserTabs.update(webContentsId, { notResponding });
}

export function listLiveJAgentDeskBrowserTabs(hostWebContentsId: number): LiveBrowserTab[] {
  return liveBrowserTabs.listForHost(hostWebContentsId);
}

export function registerAttachedJAgentDeskBrowser(input: RegisterAttachedBrowserInput): boolean {
  const guest = input.findWebContents(input.webContentsId);
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.hostWebContents !== input.sender ||
    guest.session !== input.profileSession
  ) {
    return false;
  }

  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
  });
  browserRegistry.registerWorkspace({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
  });
  return true;
}

export function getJAgentDeskBrowserIdForWebContents(
  contents: BrowserWebContentsIdentity | null,
): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserRegistry.getBrowserIdForWebContents(contents.id);
}

export function unregisterJAgentDeskBrowser(browserId: string): void {
  browserRegistry.unregisterBrowser(browserId);
}

export function unregisterJAgentDeskBrowserFromHost(
  hostWebContentsId: number,
  browserId: string,
): void {
  browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
}

export function unregisterJAgentDeskBrowserHost(hostWebContentsId: number): void {
  browserRegistry.unregisterHostWebContents(hostWebContentsId);
}

export function getJAgentDeskBrowserWorkspaceId(browserId: string): string | null {
  return browserRegistry.getWorkspaceId(browserId);
}

export function listRegisteredJAgentDeskBrowserIdsForWorkspace(workspaceId: string): string[] {
  return browserRegistry.listBrowserIdsForWorkspace(workspaceId);
}

export function setWorkspaceActiveJAgentDeskBrowserId(input: {
  hostWebContentsId: number;
  workspaceId: string;
  browserId: string | null;
}): void {
  browserRegistry.setWorkspaceActiveBrowser(input);
}

export function getWorkspaceActiveJAgentDeskBrowserId(workspaceId: string): string | null {
  return browserRegistry.getMostRecentActiveBrowserIdForWorkspace(workspaceId);
}

export function getWorkspaceActiveJAgentDeskBrowserIdForHostWindow(
  workspaceId: string,
  hostWebContentsId: number,
): string | null {
  return browserRegistry.getActiveBrowserIdForWorkspaceInHostWindow(hostWebContentsId, workspaceId);
}

export function getJAgentDeskBrowserWebContentsForHostWindow(
  browserId: string,
  hostWebContentsId: number,
): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

export function getActiveJAgentDeskBrowserWebContentsForHostWindow(
  hostWebContentsId: number,
): WebContents | null {
  const browserId = browserRegistry.getActiveBrowserIdForHostWindow(hostWebContentsId);
  if (!browserId) {
    return null;
  }
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

function preventUnsafeBrowserWebviewNavigation(
  event: { preventDefault: () => void },
  url: string | undefined,
): void {
  if (!isAllowedBrowserWebviewUrl(url)) {
    event.preventDefault();
  }
}

export function registerBrowserWebviewNavigationGuards(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-frame-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
  contents.on("will-redirect", (event) => {
    preventUnsafeBrowserWebviewNavigation(event, event.url);
  });
}
