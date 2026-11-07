import type { QueryClient } from "@tanstack/react-query";
import type { FigmaConnection, FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";

// OAuth and Remove are committed on the daemon before reaching this boundary. Publish their
// authoritative result to the shared cache before navigation, and retire reads started before
// that commit so they cannot bring back a removed account or hide a completed sign-in.
function connectionKey(serverId: string) {
  return ["figma", serverId, "connections"] as const;
}

export async function commitFigmaConnection(
  queryClient: QueryClient,
  serverId: string,
  complete: () => Promise<{ connection: FigmaConnection | null }>,
): Promise<{ connection: FigmaConnection | null }> {
  const response = await complete();
  if (!response.connection) return response;
  const connection = response.connection;
  const key = connectionKey(serverId);
  await queryClient.cancelQueries({ queryKey: key, exact: true });
  queryClient.setQueryData<FigmaConnection[]>(key, (previous = []) => {
    const found = previous.some((item) => item.id === connection.id);
    return found
      ? previous.map((item) => (item.id === connection.id ? connection : item))
      : [...previous, connection];
  });
  return response;
}

export async function removeFigmaConnection(
  queryClient: QueryClient,
  serverId: string,
  connectionId: string,
  remove: () => Promise<unknown>,
): Promise<void> {
  await remove(); // Failed removal leaves all current account/file state intact.
  // The removed account's per-file reads must not survive: outline and page-snapshot queries —
  // cached or still in flight — would keep serving a disconnected account's data. Collect the
  // account's file keys BEFORE dropping the file rows, then retire every read scoped to them.
  const fileKeys = new Set<string>();
  for (const [, files] of queryClient.getQueriesData<FigmaFile[]>({
    queryKey: ["figma", serverId, "files"],
  })) {
    for (const file of files ?? []) {
      if (file.connectionId === connectionId) fileKeys.add(file.fileKey);
    }
  }
  await Promise.all([
    queryClient.cancelQueries({ queryKey: connectionKey(serverId), exact: true }),
    queryClient.cancelQueries({ queryKey: ["figma", serverId, "files"] }),
    queryClient.cancelQueries({ queryKey: ["figma", serverId, "teams", connectionId] }),
    ...[...fileKeys].map((fileKey) =>
      Promise.all([
        queryClient.cancelQueries({ queryKey: ["figma", serverId, fileKey] }),
        queryClient.cancelQueries({ queryKey: ["figma", serverId, "outline", fileKey] }),
        queryClient.cancelQueries({ queryKey: ["figma", serverId, "nodes", fileKey] }),
        queryClient.cancelQueries({ queryKey: ["figma", serverId, "nodes", "depth-1", fileKey] }),
      ]),
    ),
  ]);
  queryClient.setQueryData<FigmaConnection[]>(connectionKey(serverId), (previous = []) =>
    previous.filter((item) => item.id !== connectionId),
  );
  // The daemon cascades removal to stored files and teams. The all-account list and the
  // per-account list are both observed in the app, so neither may retain the removed rows.
  queryClient.setQueriesData<FigmaFile[]>({ queryKey: ["figma", serverId, "files"] }, (previous) =>
    previous?.filter((file) => file.connectionId !== connectionId),
  );
  queryClient.removeQueries({ queryKey: ["figma", serverId, "teams", connectionId] });
  // Per-file reads (legacy outline/nodes and ADR-0043 page snapshots) are dead once their
  // account is gone: remove them so no stale cache can resurrect the removed account, while
  // other accounts' file reads stay untouched.
  for (const fileKey of fileKeys) {
    queryClient.removeQueries({ queryKey: ["figma", serverId, fileKey] });
    queryClient.removeQueries({ queryKey: ["figma", serverId, "outline", fileKey] });
    queryClient.removeQueries({ queryKey: ["figma", serverId, "nodes", fileKey] });
    queryClient.removeQueries({ queryKey: ["figma", serverId, "nodes", "depth-1", fileKey] });
  }
}
