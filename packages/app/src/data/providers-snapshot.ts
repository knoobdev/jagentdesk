import { type AgentProvider } from "@jagentdesk/protocol/agent-types";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export const PROVIDERS_SNAPSHOT_QUERY_ROOT = "providersSnapshot";

export function normalizeProvidersSnapshotCwd(cwd?: string | null): string | null {
  return normalizeWorkspacePath(cwd);
}

export function providersSnapshotQueryRoot(serverId: string | null) {
  return [PROVIDERS_SNAPSHOT_QUERY_ROOT, serverId] as const;
}

export function providersSnapshotQueryKey(serverId: string | null, cwd?: string | null) {
  const normalizedCwd = normalizeProvidersSnapshotCwd(cwd);
  return normalizedCwd
    ? ([PROVIDERS_SNAPSHOT_QUERY_ROOT, serverId, "cwd", normalizedCwd] as const)
    : ([PROVIDERS_SNAPSHOT_QUERY_ROOT, serverId, "home"] as const);
}

export function providersSnapshotRequestOptions(input: {
  cwd?: string | null;
  providers?: AgentProvider[];
}) {
  const normalizedCwd = normalizeProvidersSnapshotCwd(input.cwd);
  return {
    ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
    ...(input.providers ? { providers: input.providers } : {}),
  };
}

export function isProvidersSnapshotHomeScope(cwd?: string | null): boolean {
  return normalizeProvidersSnapshotCwd(cwd) === null;
}

/**
 * The providers snapshot as a replica query: its key and its fetch together, so the model picker
 * and anything else that needs the catalog read the same cache entry. `client` is asked when the
 * fetch runs.
 */
export function providersSnapshotQuery(input: {
  serverId: string;
  cwd?: string | null;
  client: () => SnapshotClient;
  queryClient?: QueryClient;
  cache?: ProviderSnapshotCache;
}) {
  const cwd = normalizeProvidersSnapshotCwd(input.cwd);
  return {
    queryKey: providersSnapshotQueryKey(input.serverId, cwd),
    // The content-hash cache already owns catalog and model identity.
    structuralSharing: false as const,
    pushEvent: "providers_snapshot_update",
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchProvidersSnapshot({
        client: input.client(),
        serverId: input.serverId,
        cwd,
        queryClient: input.queryClient,
        cache: input.cache,
        signal,
      }),
  };
}
