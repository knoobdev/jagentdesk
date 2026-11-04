import { useEffect, useReducer } from "react";
import type {
  ArgoCdAppDetail,
  ArgoCdAppRef,
  ArgoCdResourceTree,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// Live app detail + resource tree (spec 30.3): the daemon opens Argo CD's per-app watch only
// while someone is looking, so the screen subscribes on mount and unsubscribes on unmount.

export type ArgoCdAppSubscriptionState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "deleted" }
  | { status: "ready"; app: ArgoCdAppDetail; tree: ArgoCdResourceTree | null };

type Action =
  | { type: "reset" }
  | { type: "failed"; message: string }
  | { type: "snapshot"; app: ArgoCdAppDetail | null; tree: ArgoCdResourceTree | null }
  | { type: "app"; app: ArgoCdAppDetail | null }
  | { type: "tree"; tree: ArgoCdResourceTree };

function reduce(state: ArgoCdAppSubscriptionState, action: Action): ArgoCdAppSubscriptionState {
  switch (action.type) {
    case "reset":
      return { status: "loading" };
    case "failed":
      return { status: "error", message: action.message };
    case "snapshot":
      return action.app
        ? { status: "ready", app: action.app, tree: action.tree }
        : { status: "deleted" };
    case "app":
      if (!action.app) return { status: "deleted" };
      return {
        status: "ready",
        app: action.app,
        tree: state.status === "ready" ? state.tree : null,
      };
    case "tree":
      return state.status === "ready" ? { ...state, tree: action.tree } : state;
  }
}

let subscriptionCounter = 0;

function nextSubscriptionId(): string {
  subscriptionCounter += 1;
  return `argocd-app-${Date.now().toString(36)}-${subscriptionCounter}`;
}

export function useArgoCdAppSubscription(input: {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppRef;
}): ArgoCdAppSubscriptionState {
  const { serverId, instanceId } = input;
  const { name, appNamespace } = input.app;
  const client = useHostRuntimeClient(serverId);
  // A reconnected session has lost the daemon-side watch; subscribing again restores it.
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [state, dispatch] = useReducer(reduce, { status: "loading" });

  useEffect(() => {
    if (!client || !isConnected) return;
    const subscriptionId = nextSubscriptionId();
    let active = true;
    dispatch({ type: "reset" });

    const offApp = client.on("argocd.app.changed", (message) => {
      if (message.payload.subscriptionId !== subscriptionId) return;
      dispatch({ type: "app", app: message.payload.app });
    });
    const offTree = client.on("argocd.app.tree.changed", (message) => {
      if (message.payload.subscriptionId !== subscriptionId) return;
      dispatch({ type: "tree", tree: message.payload.tree });
    });

    client
      .argocd("argocd.app.tree.subscribe.request", {
        instanceId,
        app: { name, appNamespace },
        subscriptionId,
      })
      .then((payload) => {
        if (!active) return undefined;
        if (payload.error) dispatch({ type: "failed", message: payload.error });
        else dispatch({ type: "snapshot", app: payload.app, tree: payload.tree });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!active) return;
        dispatch({
          type: "failed",
          message: error instanceof Error ? error.message : "Unable to load the application",
        });
      });

    return () => {
      active = false;
      offApp();
      offTree();
      // Best effort: after a disconnect the daemon has already dropped the watch.
      void client
        .argocd("argocd.app.tree.unsubscribe.request", { subscriptionId })
        .catch(() => undefined);
    };
  }, [client, isConnected, instanceId, name, appNamespace]);

  return state;
}
