import { isTabFaviconDataUrl } from "@/desktop/browser/favicon-source";

/** The agent whose `browser_new_tab` opened the tab (spec 04 §27d.1); absent for user tabs. */
export interface BrowserTabOpener {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

export interface BrowserRecord {
  browserId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastError: string | null;
  createdAt: number;
  openedBy?: BrowserTabOpener;
}

export type BrowserRecordPatch = Partial<
  Omit<BrowserRecord, "browserId" | "createdAt" | "openedBy">
>;

export interface BrowserIndexState {
  browsersById: Record<string, BrowserRecord>;
}

export function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeBrowserUrl(value: string | null | undefined): string {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    return "https://example.com";
  }
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:.]+])(?::\d+)?(?:[/?#]|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function createBrowserRecord(input: {
  browserId: string;
  initialUrl: string | null | undefined;
  now: number;
  openedBy?: BrowserTabOpener;
}): BrowserRecord {
  return {
    browserId: input.browserId,
    url: normalizeBrowserUrl(input.initialUrl),
    title: "",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastError: null,
    createdAt: input.now,
    ...(input.openedBy ? { openedBy: input.openedBy } : {}),
  };
}

export function applyBrowserPatch<S extends BrowserIndexState>(
  state: S,
  browserId: string,
  patch: BrowserRecordPatch,
): S {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return state;
  }
  const existing = state.browsersById[normalizedBrowserId];
  if (!existing) {
    return state;
  }

  const nextRecord: BrowserRecord = {
    ...existing,
    ...patch,
    url: normalizeBrowserUrl(patch.url ?? existing.url),
  };

  if (
    nextRecord.url === existing.url &&
    nextRecord.title === existing.title &&
    nextRecord.isLoading === existing.isLoading &&
    nextRecord.canGoBack === existing.canGoBack &&
    nextRecord.canGoForward === existing.canGoForward &&
    nextRecord.faviconUrl === existing.faviconUrl &&
    nextRecord.lastError === existing.lastError
  ) {
    return state;
  }

  return {
    ...state,
    browsersById: {
      ...state.browsersById,
      [normalizedBrowserId]: nextRecord,
    },
  };
}

export function removeBrowserFromIndex<S extends BrowserIndexState>(
  state: S,
  browserId: string,
): S {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return state;
  }
  if (!state.browsersById[normalizedBrowserId]) {
    return state;
  }
  const next = { ...state.browsersById };
  delete next[normalizedBrowserId];
  return { ...state, browsersById: next };
}

/** Small icons survive a restart; a large one comes back when the tab loads again. */
const MAX_PERSISTED_FAVICON_LENGTH = 16 * 1024;

function persistableFavicon(faviconUrl: string | null): string | null {
  // A site URL stored by an older build is dropped: the app never loads one (favicon-source.ts).
  return isTabFaviconDataUrl(faviconUrl) && faviconUrl.length <= MAX_PERSISTED_FAVICON_LENGTH
    ? faviconUrl
    : null;
}

export function sanitizeBrowsersForPersist(state: BrowserIndexState): {
  browsersById: Record<string, BrowserRecord>;
} {
  return {
    browsersById: Object.fromEntries(
      Object.entries(state.browsersById).map(([browserId, browser]) => [
        browserId,
        {
          ...browser,
          isLoading: false,
          lastError: null,
          faviconUrl: persistableFavicon(browser.faviconUrl),
        },
      ]),
    ),
  };
}
