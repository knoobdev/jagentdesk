import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ApiProviderRecord, EnvProviderSummary } from "./types";

/** The four daemon-client methods the custom-providers UI calls; tests inject a fake. */
export type CustomProvidersClient = Pick<
  DaemonClient,
  "customProvidersList" | "customProvidersSave" | "customProvidersDelete" | "customProvidersTest"
>;

export type CustomProvidersLoadState =
  | { status: "connecting" } // an answer may still be pending (no client or host not connected)
  | { status: "loading" }
  | { status: "loaded"; providers: ApiProviderRecord[]; envProviders: EnvProviderSummary[] }
  | { status: "error"; message: string };

export interface UseCustomProvidersListResult {
  state: CustomProvidersLoadState;
  refresh: () => Promise<void>;
  /** Deletes a daemon-managed provider, then reloads the list. Throws on RPC error. */
  remove: (id: string) => Promise<void>;
}

export function useCustomProvidersList(
  client: CustomProvidersClient | null,
  isConnected: boolean,
): UseCustomProvidersListResult {
  const [state, setState] = useState<CustomProvidersLoadState>({ status: "connecting" });
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    if (!client || !isConnected) {
      setState({ status: "connecting" });
      return;
    }
    const requestId = ++requestIdRef.current;
    setState({ status: "loading" });
    try {
      const result = await client.customProvidersList();
      if (requestIdRef.current !== requestId) {
        return;
      }
      setState({
        status: "loaded",
        providers: result.providers,
        envProviders: result.envProviders,
      });
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, isConnected]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const remove = useCallback(
    async (id: string) => {
      if (!client) {
        return;
      }
      await client.customProvidersDelete({ id });
      await load();
    },
    [client, load],
  );

  return { state, refresh, remove };
}
