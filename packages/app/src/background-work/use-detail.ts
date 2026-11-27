import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type {
  JAgentDeskAgentBackgroundWorkDetail,
  JAgentDeskAgentBackgroundWorkItem,
} from "@jagentdesk/client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  applyOutputChunk,
  EMPTY_OUTPUT_BUFFER,
  type BackgroundWorkOutputBuffer,
  type BackgroundWorkOutputWrite,
} from "./output-buffer";
import { getBackgroundWorkModel } from "./shared";

export type BackgroundWorkDetailState =
  | { status: "loading" }
  | { status: "ready"; detail: JAgentDeskAgentBackgroundWorkDetail }
  | { status: "error"; message: string }
  | { status: "update-host" };

/** Claude's end notice can trail the inventory change that drops the task. */
const ENDED_REFRESH_DELAY_MS = 1500;

/**
 * One background item's detail (ADR-0062). It is fetched again whenever the item joins or
 * leaves the live list, so status, exit code and run time follow the task.
 */
export function useBackgroundWorkDetail(input: {
  serverId: string;
  agentId: string;
  itemId: string;
}): {
  state: BackgroundWorkDetailState;
  /** The live list entry; it carries the stop token. Null once the task left the list. */
  liveItem: JAgentDeskAgentBackgroundWorkItem | null;
  model: ReturnType<typeof getBackgroundWorkModel>;
} {
  const { serverId, agentId, itemId } = input;
  const model = getBackgroundWorkModel(serverId, agentId);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const liveItem = snapshot.items?.find((item) => item.id === itemId) ?? null;
  const isLive = liveItem !== null;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [state, setState] = useState<BackgroundWorkDetailState>({ status: "loading" });

  useEffect(() => {
    if (!client || !connected) return undefined;
    // COMPAT(backgroundWorkOutput): added in v0.12.0, remove gate after 2027-05-27.
    if (client.getLastServerInfoMessage()?.features?.backgroundWorkOutput !== true) {
      setState({ status: "update-host" });
      return undefined;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await client.getAgentBackgroundWorkDetail(agentId, itemId);
        if (!cancelled) setState({ status: "ready", detail });
      } catch (error) {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
      }
    };
    void load();
    const timer = isLive ? null : setTimeout(() => void load(), ENDED_REFRESH_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, client, connected, isLive, itemId]);

  return { state, liveItem, model };
}

export type BackgroundWorkOutputStatus =
  | "connecting"
  | "live"
  | "unavailable"
  | "error"
  | "update-host"
  | "disconnected";

/**
 * Follows one background item's output. Each push is folded into a buffer (kept for Copy output
 * and for replaying into a terminal that mounts late) and handed to `onWrite`.
 */
export function useBackgroundWorkOutput(input: {
  serverId: string;
  agentId: string;
  itemId: string;
  enabled: boolean;
  onWrite: (write: BackgroundWorkOutputWrite) => void;
}): { status: BackgroundWorkOutputStatus; getBuffer: () => BackgroundWorkOutputBuffer } {
  const { serverId, agentId, itemId, enabled } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const [status, setStatus] = useState<BackgroundWorkOutputStatus>("connecting");
  const bufferRef = useRef<BackgroundWorkOutputBuffer>(EMPTY_OUTPUT_BUFFER);
  const onWriteRef = useRef(input.onWrite);
  onWriteRef.current = input.onWrite;
  const skippedLabel = t("message.backgroundWork.detail.outputSkipped");
  const skippedLabelRef = useRef(skippedLabel);
  skippedLabelRef.current = skippedLabel;

  useEffect(() => {
    if (!enabled) {
      setStatus("unavailable");
      return undefined;
    }
    if (!client || !connected) {
      setStatus("disconnected");
      return undefined;
    }
    // COMPAT(backgroundWorkOutput): added in v0.12.0, remove gate after 2027-05-27.
    if (client.getLastServerInfoMessage()?.features?.backgroundWorkOutput !== true) {
      setStatus("update-host");
      return undefined;
    }
    let cancelled = false;
    let release: (() => void) | null = null;
    setStatus("connecting");
    const subscribe = async () => {
      try {
        const unsubscribe = await client.subscribeAgentBackgroundWorkOutput({
          agentId,
          itemId,
          onOutput: (push) => {
            if (cancelled) return;
            if (push.error) {
              setStatus("error");
              return;
            }
            const next = applyOutputChunk(bufferRef.current, push, skippedLabelRef.current);
            bufferRef.current = next.buffer;
            onWriteRef.current(next.write);
            setStatus("live");
          },
        });
        if (cancelled) unsubscribe();
        else release = unsubscribe;
      } catch {
        if (!cancelled) setStatus("error");
      }
    };
    void subscribe();
    return () => {
      cancelled = true;
      release?.();
    };
  }, [agentId, client, connected, enabled, itemId]);

  const getBuffer = useCallback(() => bufferRef.current, []);
  return { status, getBuffer };
}
