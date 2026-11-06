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
  await Promise.all([
    queryClient.cancelQueries({ queryKey: connectionKey(serverId), exact: true }),
    queryClient.cancelQueries({ queryKey: ["figma", serverId, "files"] }),
    queryClient.cancelQueries({ queryKey: ["figma", serverId, "teams", connectionId] }),
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
}
