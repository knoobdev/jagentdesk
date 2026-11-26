import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryProject,
  MemoryRecordWire,
  MemorySettingsWire,
  MemoryUseWire,
} from "@jagentdesk/protocol/memory";
import type { MemoryScope } from "../shared/types";
import { useHostRuntimeClient } from "../../../packages/app/src/plugins/builtin/host-api";

type Client = ReturnType<typeof useHostRuntimeClient>;

export type MemoryLoad<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T };

/**
 * Reloads `load` now, whenever `key` changes, and on every `memory.changed` push from the host.
 * `key` names the query; `load` is read from a ref so callers may pass an inline function.
 */
function useMemoryQuery<T>(
  client: Client,
  load: (client: NonNullable<Client>) => Promise<T>,
  key: string,
): MemoryLoad<T> {
  const [state, setState] = useState<MemoryLoad<T>>({ status: "loading" });
  const generation = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = useCallback(() => {
    if (!client) return;
    const current = ++generation.current;
    loadRef.current(client).then(
      (data) => {
        if (current === generation.current) setState({ status: "ready", data });
        return undefined;
      },
      (error: unknown) => {
        if (current === generation.current)
          setState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
  }, [client]);
  useEffect(() => {
    run();
    if (!client) return undefined;
    return client.on("memory.changed", run);
  }, [client, run, key]);
  return state;
}

export interface MemoryListData {
  memories: MemoryRecordWire[];
  projects: MemoryProject[];
  projectId: string | null;
}

export function useMemoryList(
  serverId: string,
  input: { scope: MemoryScope; projectId: string | null; query: string },
): MemoryLoad<MemoryListData> {
  const client = useHostRuntimeClient(serverId);
  return useMemoryQuery(
    client,
    (daemon) =>
      daemon.listMemories({
        scope: input.scope,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.query.trim() ? { query: input.query.trim() } : {}),
      }),
    `list:${input.scope}:${input.projectId ?? ""}:${input.query}`,
  );
}

export function useAgentMemories(
  serverId: string,
  agentId: string,
): MemoryLoad<{ created: MemoryRecordWire[]; used: MemoryUseWire[] }> {
  const client = useHostRuntimeClient(serverId);
  return useMemoryQuery(client, (daemon) => daemon.getAgentMemories(agentId), `agent:${agentId}`);
}

export function useMemorySettings(serverId: string): MemoryLoad<MemorySettingsWire> {
  const client = useHostRuntimeClient(serverId);
  return useMemoryQuery(
    client,
    async (daemon) => (await daemon.getMemorySettings()).settings,
    "settings",
  );
}

/** Tags typed as "a, b, c". */
export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}
