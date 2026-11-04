import { useCallback, useEffect, useReducer } from "react";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdInstance } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// The Argo CD instances of one host (spec 30.3 Instances): the list, kept current by the
// daemon's `argocd.instances.changed` pushes and by the instances RPC responses.

export type ArgoCdInstancesState =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; instances: ArgoCdInstance[] };

type Action =
  | { type: "loading" }
  | { type: "failed"; error: string }
  | { type: "loaded"; instances: ArgoCdInstance[] }
  | { type: "upsert"; instance: ArgoCdInstance }
  | { type: "remove"; id: string };

function reduce(state: ArgoCdInstancesState, action: Action): ArgoCdInstancesState {
  switch (action.type) {
    case "loading":
      // A reload keeps the rows on screen; only the first load shows the spinner.
      return state.status === "loaded" ? state : { status: "loading" };
    case "failed":
      return state.status === "loaded" ? state : { status: "error", error: action.error };
    case "loaded":
      return { status: "loaded", instances: action.instances };
    case "upsert": {
      if (state.status !== "loaded") return state;
      const exists = state.instances.some((entry) => entry.id === action.instance.id);
      const instances = exists
        ? state.instances.map((entry) =>
            entry.id === action.instance.id ? action.instance : entry,
          )
        : [...state.instances, action.instance];
      return { status: "loaded", instances };
    }
    case "remove":
      if (state.status !== "loaded") return state;
      return {
        status: "loaded",
        instances: state.instances.filter((entry) => entry.id !== action.id),
      };
  }
}

/** Signed in (or reconnecting): the instance's apps can be listed. */
export function isSignedIn(instance: ArgoCdInstance): boolean {
  return instance.state !== "logged_out" && instance.state !== "needs_reauth";
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export interface ArgoCdInstancesHandle {
  client: DaemonClient | null;
  state: ArgoCdInstancesState;
  reload: () => void;
  upsert: (instance: ArgoCdInstance) => void;
  remove: (id: string) => void;
}

export function useArgoCdInstances(serverId: string): ArgoCdInstancesHandle {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [state, dispatch] = useReducer(reduce, { status: "connecting" });

  const load = useCallback(async (daemon: DaemonClient) => {
    dispatch({ type: "loading" });
    try {
      const res = await daemon.argocd("argocd.instances.list.request", {});
      if (res.error) dispatch({ type: "failed", error: res.error });
      else dispatch({ type: "loaded", instances: res.instances });
    } catch (error) {
      dispatch({ type: "failed", error: errorMessage(error, "Unable to load Argo CD instances") });
    }
  }, []);

  useEffect(() => {
    if (!client || !isConnected) return;
    const off = client.on("argocd.instances.changed", (message) => {
      dispatch({ type: "upsert", instance: message.payload.instance });
    });
    void load(client);
    return off;
  }, [client, isConnected, load]);

  const reload = useCallback(() => {
    if (client) void load(client);
  }, [client, load]);
  const upsert = useCallback((instance: ArgoCdInstance) => {
    dispatch({ type: "upsert", instance });
  }, []);
  const remove = useCallback((id: string) => {
    dispatch({ type: "remove", id });
  }, []);

  return { client, state, reload, upsert, remove };
}
