import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { callFigma } from "./api";

// Server state for the Figma surface (spec 32). Keys start with ["figma", serverId] so one host's
// whole surface can be dropped at once. Lists refresh from the daemon pushes (figma.link.changed,
// figma.pending.changed), never from a timer; the outline/nodes queries keep a long staleTime
// because a version's tree never changes (32.8: zoom/pan must not re-request).

export const figmaKeys = {
  all: (serverId: string) => ["figma", serverId] as const,
  connections: (serverId: string) => ["figma", serverId, "connections"] as const,
  files: (serverId: string, connectionId: string | null) =>
    ["figma", serverId, "files", connectionId ?? "*"] as const,
  linkStatus: (serverId: string) => ["figma", serverId, "link", "status"] as const,
  pending: (serverId: string, fileKey: string) => ["figma", serverId, "pending", fileKey] as const,
  teams: (serverId: string, connectionId: string) =>
    ["figma", serverId, "teams", connectionId] as const,
  teamProjects: (serverId: string, connectionId: string, teamId: string) =>
    ["figma", serverId, "teams", connectionId, teamId, "projects"] as const,
  teamFiles: (serverId: string, connectionId: string, projectId: string) =>
    ["figma", serverId, "teams", connectionId, "project", projectId, "files"] as const,
  outline: (serverId: string, fileKey: string, version: string | null) =>
    ["figma", serverId, "outline", fileKey, version ?? "latest"] as const,
  nodes: (serverId: string, fileKey: string, ids: readonly string[], version: string | null) =>
    ["figma", serverId, "nodes", fileKey, version ?? "latest", [...ids].sort().join(",")] as const,
};

const STALE_MS = 10_000;

function useClient(serverId: string) {
  return useHostRuntimeClient(serverId);
}

export function useFigmaConnections(
  serverId: string,
  options: { refetchIntervalMs?: number } = {},
) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.connections(serverId),
    queryFn: async () =>
      (await callFigma(client, "figma.connections.list.request", {})).connections,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
    refetchInterval: options.refetchIntervalMs,
  });
}

export function useFigmaFiles(serverId: string, connectionId: string | null) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.files(serverId, connectionId),
    queryFn: async () =>
      (
        await callFigma(client, "figma.files.list.request", {
          connectionId: connectionId ?? undefined,
        })
      ).files,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useFigmaLinkStatus(serverId: string, enabled = true) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.linkStatus(serverId),
    queryFn: async () => (await callFigma(client, "figma.link.status.request", {})).status,
    enabled: client !== null && enabled,
    dataShape: "value",
    staleTimeMs: STALE_MS,
  });
}

export function useFigmaPending(serverId: string, fileKey: string | null, enabled = true) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.pending(serverId, fileKey ?? ""),
    queryFn: async () =>
      (await callFigma(client, "figma.pending.list.request", { fileKey: fileKey ?? "" })).ops,
    enabled: client !== null && fileKey !== null && enabled,
    dataShape: "list",
    staleTimeMs: 5_000,
  });
}

export function useFigmaOutline(serverId: string, fileKey: string | null, version: string | null) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.outline(serverId, fileKey ?? "", version),
    queryFn: async () => {
      const { outline } = await callFigma(client, "figma.file.outline.request", {
        fileKey: fileKey ?? "",
        ...(version ? { version } : {}),
      });
      if (!outline) throw new Error("This file is unavailable.");
      return outline;
    },
    enabled: client !== null && fileKey !== null,
    dataShape: "value",
    // A version's outline never changes; only a new version (figma.file.changed) invalidates it.
    staleTimeMs: 30 * 60_000,
  });
}

export function useFigmaNodes(
  serverId: string,
  fileKey: string | null,
  ids: readonly string[],
  version: string | null,
  enabled = true,
) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.nodes(serverId, fileKey ?? "", ids, version),
    queryFn: async () =>
      await callFigma(client, "figma.file.nodes.request", {
        fileKey: fileKey ?? "",
        ids: [...ids],
        ...(version ? { version } : {}),
      }),
    enabled: client !== null && fileKey !== null && ids.length > 0 && enabled,
    dataShape: "value",
    staleTimeMs: 30 * 60_000,
  });
}

export function useFigmaTeams(serverId: string, connectionId: string | null) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.teams(serverId, connectionId ?? ""),
    queryFn: async () =>
      (
        await callFigma(client, "figma.teams.list.request", {
          connectionId: connectionId ?? "",
        })
      ).teams,
    enabled: client !== null && connectionId !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
}

export function useFigmaTeamProjects(
  serverId: string,
  connectionId: string | null,
  teamId: string | null,
) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.teamProjects(serverId, connectionId ?? "", teamId ?? ""),
    queryFn: async () =>
      (
        await callFigma(client, "figma.teams.projects.request", {
          connectionId: connectionId ?? "",
          teamId: teamId ?? "",
        })
      ).projects,
    enabled: client !== null && connectionId !== null && teamId !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
}

export function useFigmaTeamFiles(
  serverId: string,
  connectionId: string | null,
  projectId: string | null,
) {
  const client = useClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.teamFiles(serverId, connectionId ?? "", projectId ?? ""),
    queryFn: async () =>
      (
        await callFigma(client, "figma.teams.files.request", {
          connectionId: connectionId ?? "",
          projectId: projectId ?? "",
        })
      ).files,
    enabled: client !== null && connectionId !== null && projectId !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
}

/** The Figma Link status revalidates when the daemon reports the bridge changed (32.4.3). */
export function useFigmaLinkPushInvalidator(serverId: string): void {
  const client = useClient(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client) return;
    return client.onFigmaPush("figma.link.changed", () => {
      void queryClient.invalidateQueries({ queryKey: figmaKeys.linkStatus(serverId) });
      void queryClient.invalidateQueries({ queryKey: figmaKeys.files(serverId, null) });
    });
  }, [client, queryClient, serverId]);
}

/** figma.pending.changed names the file and count; the list itself is refetched on the push. */
export function useFigmaPendingPushInvalidator(serverId: string, fileKey: string): void {
  const client = useClient(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client) return;
    return client.onFigmaPush("figma.pending.changed", (message) => {
      if (message.fileKey !== fileKey) return;
      void queryClient.invalidateQueries({ queryKey: figmaKeys.pending(serverId, fileKey) });
    });
  }, [client, queryClient, serverId, fileKey]);
}

/** After any write to the user's file list (add/remove/pin): refresh every view of it. */
export function invalidateFigmaFiles(
  queryClient: ReturnType<typeof useQueryClient>,
  serverId: string,
) {
  return queryClient.invalidateQueries({ queryKey: figmaKeys.all(serverId) });
}
