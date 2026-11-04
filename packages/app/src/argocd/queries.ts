import { useFetchQuery } from "@/data/query";
import type {
  ArgoCdAppRef,
  ArgoCdResourceKey,
  ArgoCdResourceRef,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

// Read-only Argo CD requests behind the app detail screen. Failures come back as
// `{ error }` on the payload; they become query errors so the views render them.

export class ArgoCdRequestError extends Error {}

interface AppScope {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppRef;
}

function appKey(scope: AppScope): readonly string[] {
  return [scope.serverId, scope.instanceId, scope.app.name, scope.app.appNamespace ?? ""];
}

function unwrap<T extends { error: string | null }>(payload: T): T {
  if (payload.error) throw new ArgoCdRequestError(payload.error);
  return payload;
}

export function argoCdDiffQueryKey(scope: AppScope): readonly string[] {
  return ["argocd-diff", ...appKey(scope)];
}

export function useArgoCdAppDiff(scope: AppScope, enabled: boolean) {
  const client = useHostRuntimeClient(scope.serverId);
  return useFetchQuery({
    dataShape: "list",
    staleTimeMs: 10_000,
    queryKey: argoCdDiffQueryKey(scope),
    enabled: enabled && client !== null,
    queryFn: async () => {
      if (!client) throw new ArgoCdRequestError("The host is not connected.");
      const payload = unwrap(
        await client.argocd("argocd.app.diff.request", {
          instanceId: scope.instanceId,
          app: scope.app,
        }),
      );
      return payload.items;
    },
  });
}

export function useArgoCdLiveManifest(
  scope: AppScope,
  resource: ArgoCdResourceRef,
  enabled: boolean,
) {
  const client = useHostRuntimeClient(scope.serverId);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: [
      "argocd-manifest",
      ...appKey(scope),
      resource.group,
      resource.kind,
      resource.namespace,
      resource.name,
    ],
    enabled: enabled && client !== null,
    queryFn: async () => {
      if (!client) throw new ArgoCdRequestError("The host is not connected.");
      const payload = unwrap(
        await client.argocd("argocd.app.manifests.request", {
          instanceId: scope.instanceId,
          app: scope.app,
          resource,
        }),
      );
      return payload.manifests.join("\n---\n");
    },
  });
}

export function useArgoCdEvents(
  scope: AppScope,
  resource: (ArgoCdResourceKey & { uid: string }) | null,
  enabled: boolean,
) {
  const client = useHostRuntimeClient(scope.serverId);
  return useFetchQuery({
    dataShape: "list",
    staleTimeMs: 0,
    queryKey: ["argocd-events", ...appKey(scope), resource?.uid ?? "app"],
    enabled: enabled && client !== null,
    queryFn: async () => {
      if (!client) throw new ArgoCdRequestError("The host is not connected.");
      const payload = unwrap(
        await client.argocd("argocd.app.events.request", {
          instanceId: scope.instanceId,
          app: scope.app,
          ...(resource ? { resource } : {}),
        }),
      );
      return payload.events;
    },
  });
}

export function useArgoCdResourceActions(
  scope: AppScope,
  resource: ArgoCdResourceRef,
  enabled: boolean,
) {
  const client = useHostRuntimeClient(scope.serverId);
  return useFetchQuery({
    dataShape: "list",
    staleTimeMs: 0,
    queryKey: [
      "argocd-resource-actions",
      ...appKey(scope),
      resource.group,
      resource.kind,
      resource.namespace,
      resource.name,
    ],
    enabled: enabled && client !== null,
    queryFn: async () => {
      if (!client) throw new ArgoCdRequestError("The host is not connected.");
      const payload = unwrap(
        await client.argocd("argocd.app.resource_actions.list.request", {
          instanceId: scope.instanceId,
          app: scope.app,
          resource,
        }),
      );
      return payload.actions;
    },
  });
}

/** The JAgentDesk cluster the app's destination is linked to (30.3 "Open in Clusters"). */
export function useArgoCdClusterLink(scope: AppScope) {
  const client = useHostRuntimeClient(scope.serverId);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: ["argocd-cluster-link", ...appKey(scope)],
    enabled: client !== null,
    queryFn: async () => {
      if (!client) throw new ArgoCdRequestError("The host is not connected.");
      const payload = unwrap(
        await client.argocd("argocd.cluster_links.resolve.request", {
          instanceId: scope.instanceId,
          app: scope.app,
        }),
      );
      return { link: payload.link, clusterConnected: payload.clusterConnected };
    },
  });
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
