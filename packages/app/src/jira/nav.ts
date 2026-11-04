import { useCallback, useMemo } from "react";
import { router, useGlobalSearchParams, useLocalSearchParams } from "expo-router";

// Where the Jira surface is, kept in the route's search params so a board, backlog or issue can
// be linked and restored: /h/<serverId>/jira?c=<connectionId>&view=board&board=1&issue=ABC-2

export type JiraView =
  | "projects"
  | "work"
  | "search"
  | "filters"
  | "board"
  | "backlog"
  | "connections";

const VIEWS: readonly JiraView[] = [
  "projects",
  "work",
  "search",
  "filters",
  "board",
  "backlog",
  "connections",
];

export interface JiraLocation {
  connectionId: string | null;
  view: JiraView;
  boardId: number | null;
  projectKey: string | null;
  issueKey: string | null;
  jql: string | null;
}

export interface JiraLocationPatch {
  connectionId?: string | null;
  view?: JiraView;
  boardId?: number | null;
  projectKey?: string | null;
  issueKey?: string | null;
  jql?: string | null;
}

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : null;
}

export function parseJiraLocation(
  params: Record<string, string | string[] | undefined>,
): JiraLocation {
  const view = first(params.view);
  const board = Number(first(params.board));
  return {
    connectionId: first(params.c),
    view: VIEWS.find((candidate) => candidate === view) ?? "projects",
    boardId: Number.isFinite(board) && board > 0 ? board : null,
    projectKey: first(params.project),
    issueKey: first(params.issue),
    jql: first(params.jql),
  };
}

function toParams(location: JiraLocation): Record<string, string | undefined> {
  return {
    c: location.connectionId ?? undefined,
    view: location.view,
    board: location.boardId !== null ? String(location.boardId) : undefined,
    project: location.projectKey ?? undefined,
    issue: location.issueKey ?? undefined,
    jql: location.jql ?? undefined,
  };
}

export interface JiraNav {
  location: JiraLocation;
  go: (patch: JiraLocationPatch) => void;
}

function useNavFrom(params: Record<string, string | string[] | undefined>): JiraNav {
  const location = useMemo(() => parseJiraLocation(params), [params]);
  const go = useCallback(
    (patch: JiraLocationPatch) => {
      const next: JiraLocation = { ...location, ...patch };
      router.setParams(toParams(next));
    },
    [location],
  );
  return { location, go };
}

/** For the Jira screen itself. */
export function useJiraNav(): JiraNav {
  return useNavFrom(useLocalSearchParams<Record<string, string | string[]>>());
}

/** For surfaces outside the Jira route's own tree (the sidebar column), same params. */
export function useJiraGlobalNav(): JiraNav {
  return useNavFrom(useGlobalSearchParams<Record<string, string | string[]>>());
}
