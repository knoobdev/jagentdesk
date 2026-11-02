import { useCallback, useEffect, useState } from "react";
import type {
  DaemonClient,
  SshGroup,
  SshIdentity,
  SshKey,
  SshKnownHost,
  SshConnectionStateEvent,
  SshServerInfo,
  SshSessionInfo,
} from "@jagentdesk/client/internal/daemon-client";

// Loads the Servers surface from the daemon (spec 25.12): servers + groups + identities +
// open SSH sessions in one call, plus keys and known hosts. The daemon owns sessions, so
// the `sessions` list is how a reopened app finds its terminals again (25.16 #4).

export interface ServersData {
  loading: boolean;
  error: string | null;
  servers: SshServerInfo[];
  groups: SshGroup[];
  identities: SshIdentity[];
  keys: SshKey[];
  knownHosts: SshKnownHost[];
  sessions: SshSessionInfo[];
}

const EMPTY: ServersData = {
  loading: true,
  error: null,
  servers: [],
  groups: [],
  identities: [],
  keys: [],
  knownHosts: [],
  sessions: [],
};

function withServerState(server: SshServerInfo, event: SshConnectionStateEvent): SshServerInfo {
  if (server.id !== event.serverId) return server;
  return {
    ...server,
    state: event.state,
    ...(event.error?.message ? { lastError: event.error.message } : {}),
  };
}

/** Fold one ssh.connection.state push into the loaded data. */
export function applyConnectionState(
  current: ServersData,
  event: SshConnectionStateEvent,
): ServersData {
  if (event.terminalId) {
    if (event.state !== "disconnected") return current;
    const sessions = current.sessions.filter((s) => s.terminalId !== event.terminalId);
    return sessions.length === current.sessions.length ? current : { ...current, sessions };
  }
  return { ...current, servers: current.servers.map((server) => withServerState(server, event)) };
}

export function useServersData(client: DaemonClient | null) {
  const [data, setData] = useState<ServersData>(EMPTY);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const [list, keys, hosts] = await Promise.all([
        client.sshServersList(),
        client.sshKeysList(),
        client.sshKnownhostsList(),
      ]);
      setData((current) => ({
        ...current,
        loading: false,
        error: list.error ?? keys.error ?? hosts.error,
        ...(list.error
          ? {}
          : {
              servers: list.servers,
              groups: list.groups,
              identities: list.identities,
              sessions: list.sessions,
            }),
        ...(keys.error ? {} : { keys: keys.keys }),
        ...(hosts.error ? {} : { knownHosts: hosts.knownHosts }),
      }));
    } catch (error) {
      setData((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Failed to load SSH servers",
      }));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live server state / session lifecycle without a refetch.
  useEffect(() => {
    if (!client) return undefined;
    return client.onSshConnectionState((event) => {
      setData((current) => applyConnectionState(current, event));
    });
  }, [client]);

  const setError = useCallback((error: string | null) => {
    setData((current) => ({ ...current, error }));
  }, []);

  const addSession = useCallback((session: SshSessionInfo) => {
    setData((current) => ({ ...current, sessions: [...current.sessions, session] }));
  }, []);

  const removeSession = useCallback((terminalId: string) => {
    setData((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.terminalId !== terminalId),
    }));
  }, []);

  return { data, refresh, setError, addSession, removeSession };
}
