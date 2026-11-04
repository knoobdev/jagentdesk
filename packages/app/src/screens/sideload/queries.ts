import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  DaemonClient,
  SideloadAuthPrompt,
  SideloadInstallProgress,
  SideloadNotice,
} from "@jagentdesk/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";

// Sideload server state (spec 26): accounts, installed apps and devices are fetched; jobs,
// 2FA prompts and notices arrive as pushes. A finished job refreshes the lists.

const STALE_MS = 10_000;

export function sideloadKey(serverId: string, what: string) {
  return ["sideload", serverId, what] as const;
}

/** Throws the daemon's message so React Query and mutations surface it in the UI. */
export function unwrap<T extends { error: string | null }>(payload: T): T {
  if (payload.error) throw new Error(payload.error);
  return payload;
}

export function useSideloadAccounts(client: DaemonClient | null, serverId: string) {
  return useFetchQuery({
    queryKey: sideloadKey(serverId, "accounts"),
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
    queryFn: async () =>
      unwrap(await client!.sideloadCall("sideload.accounts.list.request", {})).accounts,
  });
}

export function useSideloadApps(client: DaemonClient | null, serverId: string) {
  return useFetchQuery({
    queryKey: sideloadKey(serverId, "apps"),
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: STALE_MS,
    queryFn: async () => unwrap(await client!.sideloadCall("sideload.apps.list.request", {})).apps,
  });
}

export function useSideloadDevices(client: DaemonClient | null, serverId: string) {
  return useFetchQuery({
    queryKey: sideloadKey(serverId, "devices"),
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: 5_000,
    refetchInterval: 8_000,
    queryFn: async () => unwrap(await client!.sideloadCall("sideload.devices.list.request", {})),
  });
}

export interface JobEvent extends SideloadInstallProgress {
  /** Arrival order, the stable key of the log line. */
  seq: number;
}

let nextSeq = 0;

/** Every progress event per job, and list refresh when a job ends. */
export function useSideloadJobs(client: DaemonClient | null, serverId: string) {
  const queryClient = useQueryClient();
  const [jobs, setJobs] = useState<Record<string, JobEvent[]>>({});
  useEffect(() => {
    if (!client) return;
    return client.onSideloadInstallProgress((progress) => {
      setJobs((previous) => ({
        ...previous,
        [progress.jobId]: [
          ...(previous[progress.jobId] ?? []),
          { ...progress, seq: (nextSeq += 1) },
        ],
      }));
      if (progress.state !== "running") {
        void queryClient.invalidateQueries({ queryKey: ["sideload", serverId] });
      }
    });
  }, [client, queryClient, serverId]);
  return jobs;
}

/** The open 2FA prompt, if any (answered or expired prompts drop out). */
export function useSideloadPrompt(client: DaemonClient | null) {
  const [prompt, setPrompt] = useState<SideloadAuthPrompt | null>(null);
  useEffect(() => {
    if (!client) return;
    const offPrompt = client.onSideloadAuthPrompt(setPrompt);
    const offResolved = client.onSideloadAuthResolved((promptId) =>
      setPrompt((current) => (current?.promptId === promptId ? null : current)),
    );
    return () => {
      offPrompt();
      offResolved();
    };
  }, [client]);
  return prompt;
}

export function useSideloadNotices(client: DaemonClient | null, serverId: string) {
  const queryClient = useQueryClient();
  const [notices, setNotices] = useState<SideloadNotice[]>([]);
  useEffect(() => {
    if (!client) return;
    return client.onSideloadNotice((notice) => {
      setNotices((previous) => [notice, ...previous].slice(0, 5));
      void queryClient.invalidateQueries({ queryKey: ["sideload", serverId] });
    });
  }, [client, queryClient, serverId]);
  const dismiss = useCallback(
    (at: number) => setNotices((list) => list.filter((notice) => notice.at_ms !== at)),
    [],
  );
  return { notices, dismiss };
}
