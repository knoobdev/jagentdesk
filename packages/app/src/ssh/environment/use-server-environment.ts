import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";
import { useFetchQuery } from "@/data/query";

// The daemon answers from its cache unless forced, so refetching on mount costs no exec channel.
const ENVIRONMENT_STALE_MS = 5 * 60_000;

export interface DetectEnvironmentInput {
  serverId: string;
  force: boolean;
}

/**
 * Sends `ssh.environment.detect.request` and resolves with its environment, rejecting with the
 * response's `error` text. The owner binds it to the host's DaemonClient.
 */
export type DetectServerEnvironment = (input: DetectEnvironmentInput) => Promise<ServerEnvironment>;

export type ServerEnvironmentView =
  | { kind: "detecting"; previous: ServerEnvironment | null }
  | { kind: "ready"; environment: ServerEnvironment }
  | { kind: "failed"; message: string; previous: ServerEnvironment | null };

export interface ServerEnvironmentState {
  view: ServerEnvironmentView;
  redetect: () => void;
}

function environmentQueryKey(hostId: string, serverId: string) {
  return ["ssh", "environment", hostId, serverId] as const;
}

function messageOf(error: Error): string {
  return error.message;
}

/** Cached environment of one SSH server on one host, plus the "Re-detect" action. */
export function useServerEnvironment(input: {
  hostId: string;
  serverId: string;
  detect: DetectServerEnvironment;
}): ServerEnvironmentState {
  const { hostId, serverId, detect } = input;
  const queryClient = useQueryClient();
  const queryKey = environmentQueryKey(hostId, serverId);
  const query = useFetchQuery({
    queryKey,
    queryFn: () => detect({ serverId, force: false }),
    dataShape: "value",
    staleTimeMs: ENVIRONMENT_STALE_MS,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () => detect({ serverId, force: true }),
    onSuccess: (environment) => queryClient.setQueryData(queryKey, environment),
  });
  const { mutate } = mutation;
  const redetect = useCallback(() => mutate(), [mutate]);

  const previous = mutation.data ?? query.data ?? null;
  const isDetecting = mutation.isPending || query.isPending;
  const failure = mutation.error ?? (mutation.isIdle ? query.error : null);
  if (isDetecting) return { view: { kind: "detecting", previous }, redetect };
  if (failure) return { view: { kind: "failed", message: messageOf(failure), previous }, redetect };
  if (previous) return { view: { kind: "ready", environment: previous }, redetect };
  return { view: { kind: "detecting", previous: null }, redetect };
}
