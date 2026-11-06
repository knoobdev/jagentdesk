import { useCallback, useMemo } from "react";
import { router, useGlobalSearchParams, useLocalSearchParams } from "expo-router";

// Where the Figma surface is, kept in the route's search params so a file, page, layer or version
// can be linked and restored: /h/<serverId>/figma?fileKey=<key>&page=0:1&node=1:2&version=…
// The canvas (W10) and the layer tree read the same location — the URL is the single source.

export type FigmaHomeView = "files" | "connect" | "link";

export interface FigmaLocation {
  connectionId: string | null;
  fileKey: string | null;
  pageId: string | null;
  nodeId: string | null;
  version: string | null;
  /** Which home panel the right side shows when no file is open. */
  view: FigmaHomeView;
}

let focusRequestSequence = 0;

export interface FigmaLocationPatch {
  /** Explicit tree navigation can re-focus the same node after the user pans away. */
  focusCanvas?: boolean;
  connectionId?: string | null;
  fileKey?: string | null;
  pageId?: string | null;
  nodeId?: string | null;
  version?: string | null;
  view?: FigmaHomeView | null;
}

export interface FigmaNav {
  location: FigmaLocation;
  go: (patch: FigmaLocationPatch) => void;
}

function first(value: string | readonly (string | undefined)[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : null;
}

export function parseFigmaLocation(
  params: Record<string, string | readonly (string | undefined)[] | undefined>,
): FigmaLocation {
  const rawView = first(params.view);
  const view: FigmaHomeView = rawView === "connect" || rawView === "link" ? rawView : "files";
  return {
    connectionId: first(params.c),
    fileKey: first(params.fileKey),
    pageId: first(params.page),
    nodeId: first(params.node),
    version: first(params.version),
    view,
  };
}

function toParams(location: FigmaLocation): Record<string, string | undefined> {
  return {
    c: location.connectionId ?? undefined,
    fileKey: location.fileKey ?? undefined,
    page: location.pageId ?? undefined,
    node: location.nodeId ?? undefined,
    version: location.version ?? undefined,
    view: location.view === "files" ? undefined : location.view,
  };
}

function useNavFrom(
  params: Record<string, string | readonly (string | undefined)[] | undefined>,
): FigmaNav {
  const location = useMemo(() => parseFigmaLocation(params), [params]);
  const go = useCallback(
    (patch: FigmaLocationPatch) => {
      const { view: patchView, focusCanvas, ...rest } = patch;
      const next: FigmaLocation = { ...location, ...rest };
      if (patchView) next.view = patchView;
      else if (patchView === null) next.view = "files";
      router.setParams({
        ...toParams(next),
        ...(focusCanvas ? { focus: `${Date.now()}-${++focusRequestSequence}` } : {}),
      });
    },
    [location],
  );
  return { location, go };
}

/** For the Figma screen itself. */
export function useFigmaNav(): FigmaNav {
  return useNavFrom(useLocalSearchParams<Record<string, string | string[]>>());
}

/** For surfaces outside the Figma route's own tree (the sidebar column), same params. */
export function useFigmaGlobalNav(): FigmaNav {
  return useNavFrom(useGlobalSearchParams<Record<string, string | string[]>>());
}
