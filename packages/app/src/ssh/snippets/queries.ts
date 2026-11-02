import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type {
  SshSnippetInput,
  SshSnippetPackageInput,
  SshSnippetRun,
  SshWorkspaceTemplateInput,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import type { SnippetRunRequest, SnippetsApi } from "./api";
import { applyRunEvent } from "./run-state";

// Library, history and templates change only through this client's own mutations or
// another device; a short stale time keeps a second device reasonably fresh.
const STALE_MS = 15_000;

function libraryKey(api: SnippetsApi) {
  return ["ssh", api.hostKey, "snippets"] as const;
}
function historyKey(api: SnippetsApi, serverId: string) {
  return ["ssh", api.hostKey, "history", serverId] as const;
}
function workspacesKey(api: SnippetsApi) {
  return ["ssh", api.hostKey, "workspaces"] as const;
}

export function useSnippetLibrary(api: SnippetsApi) {
  return useFetchQuery({
    queryKey: libraryKey(api),
    queryFn: () => api.listLibrary(),
    dataShape: "value",
    staleTimeMs: STALE_MS,
  });
}

export function useSaveSnippet(api: SnippetsApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snippet: SshSnippetInput) => api.saveSnippet(snippet),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKey(api) }),
  });
}

export function useDeleteSnippet(api: SnippetsApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSnippet(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKey(api) }),
  });
}

export function useSavePackage(api: SnippetsApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pkg: SshSnippetPackageInput) => api.savePackage(pkg),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKey(api) }),
  });
}

export function useDeletePackage(api: SnippetsApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deletePackage(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKey(api) }),
  });
}

export function useStartRun(api: SnippetsApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: SnippetRunRequest) => api.run(request),
    onSuccess: (_run, request) =>
      Promise.all(
        request.serverIds.map((serverId) =>
          queryClient.invalidateQueries({ queryKey: historyKey(api, serverId) }),
        ),
      ),
  });
}

export function useCancelRun(api: SnippetsApi) {
  return useMutation({
    mutationFn: (params: { runId: string; serverId?: string }) =>
      api.cancelRun(params.runId, params.serverId),
  });
}

/**
 * Keeps a run snapshot current: subscribes to live events first, then fetches the
 * daemon's snapshot so nothing streamed before the subscription is lost.
 */
export function useLiveRun(api: SnippetsApi, initial: SshSnippetRun): SshSnippetRun {
  const [run, setRun] = useState(initial);
  useEffect(() => {
    let active = true;
    const off = api.onRunEvent((event) => setRun((current) => applyRunEvent(current, event)));
    void api.getRun(initial.runId).then((snapshot) => {
      if (active && snapshot) setRun(snapshot);
      return undefined;
    });
    return () => {
      active = false;
      off();
    };
  }, [api, initial.runId]);
  return run;
}

export function useCommandHistory(api: SnippetsApi, serverId: string) {
  return useFetchQuery({
    queryKey: historyKey(api, serverId),
    queryFn: () => api.listHistory(serverId),
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useClearHistory(api: SnippetsApi, serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearHistory(serverId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: historyKey(api, serverId) }),
  });
}

export function useWorkspaceTemplates(api: SnippetsApi) {
  return useFetchQuery({
    queryKey: workspacesKey(api),
    queryFn: () => api.listWorkspaces(),
    dataShape: "list",
    staleTimeMs: STALE_MS,
  });
}

export function useSaveWorkspace(api: SnippetsApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (template: SshWorkspaceTemplateInput) => api.saveWorkspace(template),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspacesKey(api) }),
  });
}

export function useDeleteWorkspace(api: SnippetsApi) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspacesKey(api) }),
  });
}
