import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { JiraBoardFilter } from "@jagentdesk/protocol/jira/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { callJira } from "./api";

// Server state for the Jira surface. Keys start with ["jira", serverId, connectionId] so a
// connection's data can be dropped at once. Nothing here refetches on a timer: live updates come
// from the view watches (use-view-watch.ts), as spec 29.3 requires.

export const jiraKeys = {
  all: (serverId: string) => ["jira", serverId] as const,
  connections: (serverId: string) => ["jira", serverId, "connections"] as const,
  connection: (serverId: string, connectionId: string) => ["jira", serverId, connectionId] as const,
  projects: (s: string, c: string) => ["jira", s, c, "projects"] as const,
  boards: (s: string, c: string, projectKey: string | null) =>
    ["jira", s, c, "boards", projectKey] as const,
  boardConfig: (s: string, c: string, boardId: number) =>
    ["jira", s, c, "board", boardId, "config"] as const,
  boardIssues: (s: string, c: string, boardId: number, filter?: JiraBoardFilter) =>
    ["jira", s, c, "board", boardId, "issues", filter ?? {}] as const,
  boardAny: (s: string, c: string, boardId: number) => ["jira", s, c, "board", boardId] as const,
  backlog: (s: string, c: string, boardId: number) =>
    ["jira", s, c, "board", boardId, "backlog"] as const,
  sprints: (s: string, c: string, boardId: number) =>
    ["jira", s, c, "board", boardId, "sprints"] as const,
  issue: (s: string, c: string, key: string) => ["jira", s, c, "issue", key] as const,
  issuePart: (s: string, c: string, key: string, part: string) =>
    ["jira", s, c, "issue", key, part] as const,
  search: (s: string, c: string, jql: string) => ["jira", s, c, "search", jql] as const,
  filters: (s: string, c: string) => ["jira", s, c, "filters"] as const,
};

const STALE_MS = 10_000;

function useClient(serverId: string) {
  return useHostRuntimeClient(serverId);
}

export function useJiraConnections(serverId: string) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.connections(serverId),
    queryFn: async () => (await callJira(client, "jira.connections.list.request", {})).connections,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraProjects(serverId: string, connectionId: string) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.projects(serverId, connectionId),
    queryFn: async () =>
      (await callJira(client, "jira.projects.list.request", { connectionId })).projects,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
}

export function useJiraBoards(serverId: string, connectionId: string, projectKey: string | null) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.boards(serverId, connectionId, projectKey),
    queryFn: async () =>
      (
        await callJira(client, "jira.boards.list.request", {
          connectionId,
          ...(projectKey ? { projectKey } : {}),
        })
      ).boards,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
}

export function useJiraBoardConfig(serverId: string, connectionId: string, boardId: number) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.boardConfig(serverId, connectionId, boardId),
    queryFn: async () => {
      const { configuration } = await callJira(client, "jira.boards.configuration.request", {
        connectionId,
        boardId,
      });
      if (!configuration) throw new Error("Board configuration is unavailable.");
      return configuration;
    },
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: 60_000,
  });
}

export function useJiraBoardIssues(
  serverId: string,
  connectionId: string,
  boardId: number,
  filter: JiraBoardFilter,
) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.boardIssues(serverId, connectionId, boardId, filter),
    queryFn: () => callJira(client, "jira.board.issues.request", { connectionId, boardId, filter }),
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraBacklog(serverId: string, connectionId: string, boardId: number) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.backlog(serverId, connectionId, boardId),
    queryFn: () => callJira(client, "jira.backlog.get.request", { connectionId, boardId }),
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraSprints(serverId: string, connectionId: string, boardId: number) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.sprints(serverId, connectionId, boardId),
    queryFn: async () =>
      (await callJira(client, "jira.sprints.list.request", { connectionId, boardId })).sprints,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraIssue(serverId: string, connectionId: string, issueKey: string) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.issue(serverId, connectionId, issueKey),
    queryFn: async () => {
      const { issue } = await callJira(client, "jira.issue.get.request", {
        connectionId,
        issueKey,
      });
      if (!issue) throw new Error(`${issueKey} is unavailable.`);
      return issue;
    },
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraComments(serverId: string, connectionId: string, issueKey: string) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.issuePart(serverId, connectionId, issueKey, "comments"),
    queryFn: () => callJira(client, "jira.issue.comments.list.request", { connectionId, issueKey }),
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraWorklogs(serverId: string, connectionId: string, issueKey: string) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.issuePart(serverId, connectionId, issueKey, "worklogs"),
    queryFn: () => callJira(client, "jira.issue.worklog.list.request", { connectionId, issueKey }),
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraChangelog(serverId: string, connectionId: string, issueKey: string) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.issuePart(serverId, connectionId, issueKey, "changelog"),
    queryFn: () =>
      callJira(client, "jira.issue.changelog.list.request", { connectionId, issueKey }),
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraTransitions(
  serverId: string,
  connectionId: string,
  issueKey: string | null,
) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.issuePart(serverId, connectionId, issueKey ?? "", "transitions"),
    queryFn: async () =>
      (
        await callJira(client, "jira.issue.transitions.request", {
          connectionId,
          issueKey: issueKey ?? "",
        })
      ).transitions,
    enabled: client !== null && issueKey !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraSearch(serverId: string, connectionId: string, jql: string | null) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.search(serverId, connectionId, jql ?? ""),
    queryFn: () =>
      callJira(client, "jira.search.request", { connectionId, jql: jql ?? "", maxResults: 50 }),
    enabled: client !== null && jql !== null && jql.trim().length > 0,
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useJiraFilters(serverId: string, connectionId: string) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: jiraKeys.filters(serverId, connectionId),
    queryFn: async () =>
      (await callJira(client, "jira.filters.list.request", { connectionId })).filters,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
}

/** After a write: refresh what shows the issue (board, backlog, search, the issue itself). */
export function invalidateAfterIssueWrite(
  queryClient: QueryClient,
  serverId: string,
  connectionId: string,
): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: jiraKeys.connection(serverId, connectionId) });
}

export function useJiraInvalidate(serverId: string, connectionId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => invalidateAfterIssueWrite(queryClient, serverId, connectionId);
}
