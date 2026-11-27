import type { DesktopLiveBrowserTab } from "@/desktop/host";
import type { BrowserWebviewElementInfo } from "@/desktop/browser/resident-webviews";
import type { BrowserRecord, BrowserTabOpener } from "@/desktop/browser/store/state";
import { collectAllTabs, type WorkspaceLayout } from "@/stores/workspace-layout-actions";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

export type BrowserTabStatus = DesktopLiveBrowserTab["status"];

export interface BrowserTabPlacement {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  tabId: string;
}

/** One live browser webview in the "Browser tabs" list (spec 04 §27d.1). */
export interface BrowserTabRow {
  key: string;
  browserId: string | null;
  webContentsId: number | null;
  title: string;
  url: string;
  host: string;
  faviconUrl: string | null;
  status: BrowserTabStatus;
  /** The workspace tab showing this webview; null for an orphan (spec 04 §27d.2). */
  placement: BrowserTabPlacement | null;
  workspaceName: string | null;
  agentName: string | null;
  /** The agent that opened this tab (`browser_new_tab`); null for a tab the user opened. */
  opener: { serverId: string; agentId: string } | null;
  /** Where the webview was registered or opened, for an orphan's Show. */
  homeWorkspace: { serverId: string | null; workspaceId: string } | null;
}

export interface BrowserTabLayouts {
  layoutByWorkspace: Record<string, WorkspaceLayout>;
  sheetsByWorkspace: Record<string, readonly { tab: WorkspaceTab }[]>;
}

export interface BuildBrowserTabRowsInput {
  liveTabs: readonly DesktopLiveBrowserTab[];
  elements: readonly BrowserWebviewElementInfo[];
  browsersById: Record<string, BrowserRecord>;
  layouts: BrowserTabLayouts;
  serverIds: readonly string[];
  resolveWorkspaceName(serverId: string, workspaceId: string): string | null;
  resolveAgentName(serverId: string, agentId: string): string | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function isBrowserTabFor(tab: WorkspaceTab, browserId: string): boolean {
  return tab.target.kind === "browser" && tab.target.browserId === browserId;
}

function splitWorkspaceKey(
  workspaceKey: string,
  serverIds: readonly string[],
): { serverId: string; workspaceId: string } | null {
  const serverId = serverIds.find((candidate) => workspaceKey.startsWith(`${candidate}:`));
  if (serverId) {
    return { serverId, workspaceId: workspaceKey.slice(serverId.length + 1) };
  }
  const separator = workspaceKey.indexOf(":");
  if (separator <= 0) return null;
  return {
    serverId: workspaceKey.slice(0, separator),
    workspaceId: workspaceKey.slice(separator + 1),
  };
}

export function findBrowserTabPlacement(
  browserId: string,
  layouts: BrowserTabLayouts,
  serverIds: readonly string[],
): BrowserTabPlacement | null {
  const placed = (workspaceKey: string, tabId: string): BrowserTabPlacement | null => {
    const parts = splitWorkspaceKey(workspaceKey, serverIds);
    return parts ? { ...parts, workspaceKey, tabId } : null;
  };
  for (const [workspaceKey, layout] of Object.entries(layouts.layoutByWorkspace)) {
    const tab = collectAllTabs(layout.root).find((candidate) =>
      isBrowserTabFor(candidate, browserId),
    );
    if (tab) return placed(workspaceKey, tab.tabId);
  }
  for (const [workspaceKey, sheets] of Object.entries(layouts.sheetsByWorkspace)) {
    const sheet = sheets.find((candidate) => isBrowserTabFor(candidate.tab, browserId));
    if (sheet) return placed(workspaceKey, sheet.tab.tabId);
  }
  return null;
}

/**
 * Main's live guests, plus webview elements main has not seen attach yet: every live webview
 * of the window appears once.
 */
function mergeLiveWebviews(
  liveTabs: readonly DesktopLiveBrowserTab[],
  elements: readonly BrowserWebviewElementInfo[],
): DesktopLiveBrowserTab[] {
  const browserIdByWebContentsId = new Map<number, string>();
  for (const element of elements) {
    if (element.webContentsId !== null) {
      browserIdByWebContentsId.set(element.webContentsId, element.browserId);
    }
  }
  const merged: DesktopLiveBrowserTab[] = [];
  const seenBrowserIds = new Set<string>();
  const seenWebContentsIds = new Set<number>();
  for (const tab of liveTabs) {
    const browserId = tab.browserId ?? browserIdByWebContentsId.get(tab.webContentsId) ?? null;
    if (browserId !== null && seenBrowserIds.has(browserId)) continue;
    if (browserId !== null) seenBrowserIds.add(browserId);
    seenWebContentsIds.add(tab.webContentsId);
    merged.push({ ...tab, browserId });
  }
  for (const element of elements) {
    if (seenBrowserIds.has(element.browserId)) continue;
    if (element.webContentsId !== null && seenWebContentsIds.has(element.webContentsId)) continue;
    seenBrowserIds.add(element.browserId);
    merged.push({
      webContentsId: element.webContentsId ?? -1,
      browserId: element.browserId,
      workspaceId: null,
      url: "",
      title: "",
      faviconUrl: null,
      status: "loading",
    });
  }
  return merged;
}

function resolveHomeWorkspace(
  opener: BrowserTabOpener | null,
  registeredWorkspaceId: string | null,
): BrowserTabRow["homeWorkspace"] {
  if (opener) return { serverId: opener.serverId, workspaceId: opener.workspaceId };
  if (registeredWorkspaceId) return { serverId: null, workspaceId: registeredWorkspaceId };
  return null;
}

function openerAgent(opener: BrowserTabOpener | null): BrowserTabRow["opener"] {
  return opener ? { serverId: opener.serverId, agentId: opener.agentId } : null;
}

function buildBrowserTabRow(
  tab: DesktopLiveBrowserTab,
  input: BuildBrowserTabRowsInput,
): BrowserTabRow {
  const record = tab.browserId ? (input.browsersById[tab.browserId] ?? null) : null;
  const url = tab.url || record?.url || "";
  const placement = tab.browserId
    ? findBrowserTabPlacement(tab.browserId, input.layouts, input.serverIds)
    : null;
  const opener = record?.openedBy ?? null;
  const workspaceName = placement
    ? (input.resolveWorkspaceName(placement.serverId, placement.workspaceId) ??
      placement.workspaceId)
    : null;
  return {
    key: tab.browserId ?? `webContents:${tab.webContentsId}`,
    browserId: tab.browserId,
    webContentsId: tab.webContentsId >= 0 ? tab.webContentsId : null,
    title: tab.title || record?.title || url,
    url,
    host: hostOf(url),
    faviconUrl: tab.faviconUrl ?? record?.faviconUrl ?? null,
    status: tab.status,
    placement,
    workspaceName,
    agentName: opener ? input.resolveAgentName(opener.serverId, opener.agentId) : null,
    opener: openerAgent(opener),
    homeWorkspace: resolveHomeWorkspace(opener, tab.workspaceId),
  };
}

export function buildBrowserTabRows(input: BuildBrowserTabRowsInput): BrowserTabRow[] {
  return mergeLiveWebviews(input.liveTabs, input.elements).map((tab) =>
    buildBrowserTabRow(tab, input),
  );
}

/** The tabs one agent opened, for its composer pill (spec 04 §27d.1). */
export function filterBrowserTabRowsForAgent(
  rows: readonly BrowserTabRow[],
  serverId: string,
  agentId: string,
): BrowserTabRow[] {
  return rows.filter((row) => row.opener?.serverId === serverId && row.opener.agentId === agentId);
}

export type BrowserTabsTone = "muted" | "warning" | "danger";

export interface BrowserTabsSummary {
  count: number;
  /** The badge text: the count, capped at "99+". */
  badgeText: string;
  /** Crashed wins over Not responding; otherwise muted. */
  tone: BrowserTabsTone;
  notResponding: number;
  crashed: number;
}

const BADGE_MAX = 99;

export function summarizeBrowserTabRows(rows: readonly BrowserTabRow[]): BrowserTabsSummary {
  let notResponding = 0;
  let crashed = 0;
  for (const row of rows) {
    if (row.status === "notResponding") notResponding += 1;
    else if (row.status === "crashed") crashed += 1;
  }
  let tone: BrowserTabsTone = "muted";
  if (crashed > 0) tone = "danger";
  else if (notResponding > 0) tone = "warning";
  return {
    count: rows.length,
    badgeText: rows.length > BADGE_MAX ? `${BADGE_MAX}+` : String(rows.length),
    tone,
    notResponding,
    crashed,
  };
}

export interface BrowserTabsPillSegment {
  bucket: SidebarStateBucket | null;
  text: string;
}

/**
 * The composer pill's segments: the count, then one segment per abnormal state like the subagents
 * pill. Not responding takes the amber dot (`needs_input`; `attention` is green), Crashed the red.
 */
export function buildBrowserTabsPillSegments(
  summary: BrowserTabsSummary,
  labels: { notResponding(count: number): string; crashed(count: number): string },
): BrowserTabsPillSegment[] {
  const segments: BrowserTabsPillSegment[] = [{ bucket: null, text: String(summary.count) }];
  if (summary.notResponding > 0) {
    segments.push({ bucket: "needs_input", text: labels.notResponding(summary.notResponding) });
  }
  if (summary.crashed > 0) {
    segments.push({ bucket: "failed", text: labels.crashed(summary.crashed) });
  }
  return segments;
}

/** Row line 2: host · workspace · agent; the agent part is left out where the list is one agent's. */
export function browserTabRowDetailParts(
  row: BrowserTabRow,
  options: { includeAgent: boolean; notInWorkspace: string },
): string[] {
  const parts = [row.host, row.workspaceName ?? options.notInWorkspace];
  if (options.includeAgent && row.agentName) parts.push(row.agentName);
  return parts.filter((part) => part.length > 0);
}
