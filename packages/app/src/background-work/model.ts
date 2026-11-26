import type { JAgentDeskAgentBackgroundWorkItem as AgentBackgroundWorkItem } from "@jagentdesk/client";

interface Port {
  list(): Promise<AgentBackgroundWorkItem[]>;
  stop?(item: AgentBackgroundWorkItem): Promise<void>;
  observe(callbacks: {
    snapshot(): void;
    disconnected(): void;
    failed(): void;
    update(items: AgentBackgroundWorkItem[]): void;
  }): () => void;
}

interface BackgroundWorkState {
  status: "loading" | "stale" | "ready" | "error";
  items: AgentBackgroundWorkItem[] | null;
  stops?: Record<string, { status: "pending" | "error"; item: AgentBackgroundWorkItem }>;
  /** Work that left the inventory while this model was watching, kept until dismissed. */
  finished?: Record<string, { item: AgentBackgroundWorkItem; finishedAt: number }>;
}

function withFinished(
  state: BackgroundWorkState,
  nextItems: AgentBackgroundWorkItem[],
  now: number,
): BackgroundWorkState["finished"] {
  if (state.items === null) return state.finished;
  const live = new Set(nextItems.map((item) => item.id));
  const gone = state.items.filter((item) => !live.has(item.id));
  if (gone.length === 0) return state.finished;
  const finished = { ...state.finished };
  for (const item of gone) finished[item.id] = { item, finishedAt: now };
  return finished;
}

export function createBackgroundWorkModel(port: Port) {
  let state: BackgroundWorkState = { status: "loading", items: null };
  let sequence = 0;
  let stopGeneration = 0;
  let stop: (() => void) | undefined;
  let observationFailed = false;
  const listeners = new Set<() => void>();
  const publish = (next: BackgroundWorkState) => {
    const stops = next.stops ?? state.stops;
    const finished = next.finished ?? state.finished;
    state = {
      ...next,
      ...(stops === undefined ? null : { stops }),
      ...(finished === undefined ? null : { finished }),
    };
    for (const listener of listeners) listener();
  };
  // Only a live update says a task ended; a resync after a reconnect can be a different view.
  const publishReady = (items: AgentBackgroundWorkItem[]) => {
    publish({ status: "ready", items, finished: withFinished(state, items, Date.now()) });
  };
  const refresh = async () => {
    const request = ++sequence;
    publish({ status: state.items === null ? "loading" : "stale", items: state.items });
    try {
      const items = await port.list();
      if (request === sequence) publish({ status: "ready", items });
    } catch {
      if (request === sequence) publish({ status: "error", items: state.items });
    }
  };
  const start = () => {
    observationFailed = false;
    stop = port.observe({
      snapshot: () => {
        void refresh();
      },
      disconnected: () => {
        sequence++;
        stopGeneration++;
        const stops =
          state.stops &&
          Object.fromEntries(
            Object.entries(state.stops).map(([id, entry]) => [
              id,
              { ...entry, status: "error" as const },
            ]),
          );
        publish({ status: state.items === null ? "loading" : "stale", items: state.items, stops });
      },
      failed: () => {
        observationFailed = true;
        sequence++;
        publish({ status: "error", items: state.items });
      },
      update: (items) => {
        sequence++;
        publishReady(items);
      },
    });
  };
  return {
    getSnapshot: () => state,
    dismissFinished: (id: string) => {
      const finished = { ...state.finished };
      delete finished[id];
      publish({ ...state, finished });
    },
    dismissStop: (token: string) => {
      const stops = { ...state.stops };
      delete stops[token];
      publish({ ...state, stops });
    },
    stopItem: async (item: AgentBackgroundWorkItem) => {
      const token = item.stopToken;
      if (!port.stop || !token || state.stops?.[token]?.status === "pending") return;
      if (!state.items?.some((entry) => entry.stopToken === token)) return;
      const generation = stopGeneration;
      publish({ ...state, stops: { ...state.stops, [token]: { status: "pending", item } } });
      try {
        await port.stop(item);
        if (generation !== stopGeneration) return;
        const stops = { ...state.stops };
        delete stops[token];
        publish({ ...state, stops });
      } catch {
        if (generation === stopGeneration)
          publish({ ...state, stops: { ...state.stops, [token]: { status: "error", item } } });
      }
    },
    retry: () => {
      if (observationFailed) {
        stop?.();
        stop = undefined;
        publish({ status: state.items === null ? "loading" : "stale", items: state.items });
        start();
      } else {
        void refresh();
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) start();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          sequence++;
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}
