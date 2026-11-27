import { prefetchProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { generateMessageId } from "@/types/stream";
import { useRef, ReactNode, useCallback, useEffect } from "react";
import { Buffer } from "buffer";
import { AppState } from "react-native";
import { isNative } from "@/constants/platform";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useClientActivity } from "@/hooks/use-client-activity";
import { useAppVisible } from "@/hooks/use-app-visible";
import { startPushNotifications } from "@/push-notifications";
import {
  createSetAgentInitializing,
  refreshAgentInitializationTimeout,
} from "@/hooks/use-agent-initialization";
import { deriveAgentStreamTurnLiveness } from "@/timeline/session-stream-reducers";
import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import {
  type TimelineDeliveryMode,
  type TimelineResponsePayload,
  type ViewedTimelineOwner,
} from "@/timeline/viewed-timeline-sync";
import {
  type SessionOutboundMessage,
  parseServerInfoStatusPayload,
} from "@jagentdesk/protocol/messages";
import type { AgentAttentionNotificationPayload } from "@jagentdesk/protocol/agent-attention-notification";
import {
  deliverAgentAttentionOsNotification,
  deliverPluginOsNotification,
  deliverTerminalAttentionOsNotification,
  getCurrentNotificationPreferences,
} from "./session-notifications";
import { type DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { type AgentPermissionResponse } from "@jagentdesk/protocol/agent-types";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useVoiceAudioEngineOptional, useVoiceRuntimeOptional } from "@/contexts/voice-context";
import { type AudioPlaybackSource } from "@/voice/audio-engine-types";
import {
  selectAgentTimelineState,
  toDaemonServerInfo,
  useSessionStore,
  type MessageEntry,
} from "@/stores/session-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { sendOsNotification } from "@/utils/os-notifications";
import { getIsAppVisible } from "@/utils/app-visibility";
import {
  getInitKey,
  getInitDeferred,
  createInitDeferred,
  rejectInitDeferred,
} from "@/utils/agent-initialization";
import { derivePendingPermissionKey } from "@/utils/agent-snapshots";

import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import { applyCheckoutStatusUpdateFromEvent } from "@/git/checkout-status-cache";
import { resyncProviderSubagents, useProviderSubagentStore } from "@/subagents/provider-store";
import { useNotificationFeedSync } from "@/notification-feed/store";
import { revalidateSessionAfterResume } from "@/contexts/session-resume-revalidation";

function applyToolResultToMessages(
  toolCallId: string,
  result: unknown,
): (prev: MessageEntry[]) => MessageEntry[] {
  return (prev) =>
    prev.map((msg) =>
      msg.type === "tool_call" && msg.id === toolCallId
        ? { ...msg, result, status: "completed" as const }
        : msg,
    );
}

function applyToolErrorToMessages(
  toolCallId: string,
  error: unknown,
): (prev: MessageEntry[]) => MessageEntry[] {
  return (prev) =>
    prev.map((msg) =>
      msg.type === "tool_call" && msg.id === toolCallId
        ? { ...msg, error, status: "failed" as const }
        : msg,
    );
}

function consumeForcedTimelineTailReplacement(
  payload: TimelineResponsePayload,
  replacements: Set<string>,
): TimelineResponsePayload {
  if (payload.direction !== "tail") return payload;
  if (!replacements.delete(payload.agentId)) return payload;
  return { ...payload, reset: true };
}

// Re-export types from session-store and draft-store for backward compatibility
export type { DraftInput } from "@/stores/draft-store";

export type {
  MessageEntry,
  Agent,
  ExplorerEntry,
  ExplorerFile,
  ExplorerEntryKind,
  ExplorerFileKind,
  ExplorerEncoding,
  AgentFileExplorerState,
} from "@/stores/session-store";

type AudioOutputPayload = Extract<SessionOutboundMessage, { type: "audio_output" }>["payload"];

interface BufferedAudioChunk {
  chunkIndex: number;
  audio: string;
  format: string;
  id: string;
}

// COMPAT(selectiveAgentTimeline): added in v0.1.106, remove after 2027-01-12.
function getTimelineDeliveryMode(selectiveAgentTimeline?: boolean): TimelineDeliveryMode {
  return selectiveAgentTimeline ? "selective" : "legacy";
}

function decodeBase64Chunk(base64: string): Uint8Array {
  return Buffer.from(base64, "base64");
}

function buildAudioPlaybackSource(chunks: BufferedAudioChunk[]): AudioPlaybackSource {
  const decodedChunks = chunks.map((chunk) => decodeBase64Chunk(chunk.audio));
  const totalSize = decodedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of decodedChunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  const format = chunks[0]?.format ?? "pcm";
  let mimeType: string;
  if (format === "pcm") mimeType = "audio/pcm;rate=24000;bits=16";
  else if (format === "mp3") mimeType = "audio/mpeg";
  else mimeType = `audio/${format}`;

  const bytes = output.slice();
  return {
    size: bytes.byteLength,
    type: mimeType,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

type WorkspaceSetupProgressPayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_progress" }
>["payload"];

function notifyVoiceAbortFailure(
  data: Extract<SessionOutboundMessage, { type: "activity_log" }>["payload"],
  notifyError: (message: string) => void,
): void {
  if (data.type === "error" && data.metadata?.voiceAbortFailed === true) {
    notifyError(data.content);
  }
}

interface SessionProviderSharedProps {
  children: ReactNode;
  serverId: string;
}

interface SessionProviderClientProps extends SessionProviderSharedProps {
  client: DaemonClient;
}

export type SessionProviderProps = SessionProviderClientProps;

function SessionProviderWithClient({ children, serverId, client }: SessionProviderClientProps) {
  return (
    <SessionProviderInternal serverId={serverId} client={client}>
      {children}
    </SessionProviderInternal>
  );
}

// SessionProvider: Daemon client message handler that updates Zustand store
export function SessionProvider(props: SessionProviderProps) {
  return <SessionProviderWithClient {...props} />;
}

function SessionProviderInternal({ children, serverId, client }: SessionProviderClientProps) {
  const { t } = useTranslation();
  const voiceRuntime = useVoiceRuntimeOptional();
  const voiceAudioEngine = useVoiceAudioEngineOptional();
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  // COMPAT(pluginNotifications): added in v0.12.2, remove gate after 2027-06-01.
  const supportsPluginNotifications =
    useHostFeature(serverId, "pluginNotifications") ||
    client.getLastServerInfoMessage()?.features?.pluginNotifications === true;
  // COMPAT(notificationFeed): added in v0.12.3, remove gate after 2027-06-01.
  const supportsNotificationFeed =
    useHostFeature(serverId, "notificationFeed") ||
    client.getLastServerInfoMessage()?.features?.notificationFeed === true;
  useNotificationFeedSync({
    client,
    serverId,
    supported: supportsNotificationFeed,
    connected: isConnected,
  });
  const toast = useToast();

  // Zustand store actions
  const setIsPlayingAudio = useSessionStore((state) => state.setIsPlayingAudio);
  const setMessages = useSessionStore((state) => state.setMessages);
  const setCurrentAssistantMessage = useSessionStore((state) => state.setCurrentAssistantMessage);
  const setAgentStreamTail = useSessionStore((state) => state.setAgentStreamTail);
  const setAgentStreamHead = useSessionStore((state) => state.setAgentStreamHead);
  const applyAgentTurnLiveness = useSessionStore((state) => state.applyAgentTurnLiveness);
  const clearAgentTurnLiveness = useSessionStore((state) => state.clearAgentTurnLiveness);
  const clearAgentStreamHead = useSessionStore((state) => state.clearAgentStreamHead);
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const bumpHistorySyncGeneration = useSessionStore((state) => state.bumpHistorySyncGeneration);
  const setAgents = useSessionStore((state) => state.setAgents);
  const flushAgentLastActivity = useSessionStore((state) => state.flushAgentLastActivity);
  const setPendingPermissions = useSessionStore((state) => state.setPendingPermissions);
  const updateSessionServerInfo = useSessionStore((state) => state.updateSessionServerInfo);
  const setViewedTimelineSync = useSessionStore((state) => state.setViewedTimelineSync);
  const upsertWorkspaceSetupProgress = useWorkspaceSetupStore((state) => state.upsertProgress);

  // Track focused agent for heartbeat
  const focusedAgentId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedAgentId ?? null,
  );
  const focusedTerminalId = useSessionStore(
    (state) => state.sessions[serverId]?.focusedTerminalId ?? null,
  );
  const _sessionStateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attentionNotifiedRef = useRef<Map<string, number>>(new Map());
  const appStateRef = useRef(AppState.currentState);
  const forcedTimelineTailReplacements = useRef(new Set<string>());
  const viewedTimelineSyncRef = useRef<ViewedTimelineOwner | null>(null);
  const audioOutputBuffersRef = useRef<Map<string, BufferedAudioChunk[]>>(new Map());
  const activeAudioGroupsRef = useRef<Set<string>>(new Set());
  const isAppVisible = useAppVisible();

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    viewedTimelineSyncRef.current?.setActive(isAppVisible);
  }, [isAppVisible]);

  const handleAppResumed = useCallback(
    (awayMs: number) => {
      void revalidateSessionAfterResume({
        awayMs,
        serverId,
        bumpHistorySyncGeneration,
      });
    },
    [bumpHistorySyncGeneration, serverId],
  );

  // Client activity tracking (heartbeat, push token registration)
  useClientActivity({ client, focusedAgentId, focusedTerminalId, onAppResumed: handleAppResumed });
  useEffect(
    () => startPushNotifications({ client, serverId, queryClient }),
    [client, queryClient, serverId],
  );

  const notifyAgentAttention = useCallback(
    (params: {
      agentId: string;
      reason: "finished" | "error" | "permission";
      timestamp: string;
      notification?: AgentAttentionNotificationPayload;
    }) => {
      deliverAgentAttentionOsNotification({
        serverId,
        params,
        appState: appStateRef.current,
        session: useSessionStore.getState().sessions[serverId],
        attentionNotified: attentionNotifiedRef.current,
        preferences: getCurrentNotificationPreferences(queryClient),
        sendNotification: sendOsNotification,
      });
    },
    [queryClient, serverId],
  );

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    const serverInfo = client.getLastServerInfoMessage();
    if (!serverInfo?.features?.providersSnapshot) {
      return;
    }

    prefetchProvidersSnapshot(serverId, client);
  }, [client, isConnected, serverId]);

  useEffect(() => {
    const unregister = voiceRuntime?.registerSession({
      serverId,
      setVoiceMode: async (enabled, agentId) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.setVoiceMode(enabled, agentId);
      },
      sendVoiceAudioChunk: async (audioData, mimeType) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.sendVoiceAudioChunk(audioData, mimeType);
      },
      audioPlayed: async (chunkId) => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.audioPlayed(chunkId);
      },
      abortRequest: async () => {
        if (!client) {
          throw new Error(t("common.errors.daemonUnavailable"));
        }
        await client.abortRequest();
      },
      setAssistantAudioPlaying: (isPlaying) => {
        setIsPlayingAudio(serverId, isPlaying);
      },
    });
    return () => unregister?.();
  }, [client, serverId, setIsPlayingAudio, t, voiceRuntime]);

  useEffect(() => {
    voiceRuntime?.updateSessionConnection(serverId, isConnected);
  }, [isConnected, serverId, voiceRuntime]);

  // If the client drops mid-initialization, clear pending flags
  useEffect(() => {
    if (!isConnected) {
      flushAgentLastActivity();
      setInitializingAgents(serverId, new Map());
    }
  }, [flushAgentLastActivity, serverId, isConnected, setInitializingAgents]);

  useEffect(
    () =>
      client.subscribeConnectionStatus((connection) => {
        if (connection.status !== "connected") {
          clearAgentTurnLiveness(serverId);
          return;
        }
        // Subagent updates are not replayed across a reconnect, so catch every
        // tracked parent up once the feed is live again. (Upstream wires this to
        // a feed-snapshot callback; the fork has no feed manager, so the
        // connection-status listener is the resubscribe hook.)
        void resyncProviderSubagents(client, serverId);
      }),
    [clearAgentTurnLiveness, client, serverId],
  );

  const applyWorkspaceSetupProgress = useCallback(
    (payload: WorkspaceSetupProgressPayload) => {
      upsertWorkspaceSetupProgress({ serverId, payload });
    },
    [serverId, upsertWorkspaceSetupProgress],
  );

  const applyTimelineResponse = useCallback((receivedPayload: TimelineResponsePayload) => {
    const payload = consumeForcedTimelineTailReplacement(
      receivedPayload,
      forcedTimelineTailReplacements.current,
    );
    const owner = viewedTimelineSyncRef.current;
    if (!owner) throw new Error("Viewed timeline owner is unavailable");
    owner.applyTimelineResponse(payload);
  }, []);

  useEffect(() => {
    const setAgentInitializing = createSetAgentInitializing(serverId, setInitializingAgents);
    const initialDeliveryMode = getTimelineDeliveryMode(
      client.getLastServerInfoMessage()?.features?.selectiveAgentTimeline,
    );
    const sync = getHostRuntimeStore().createViewedTimelineOwner(serverId, {
      initialDeliveryMode,
      canCheckFreshness: () =>
        client.getLastServerInfoMessage()?.features?.timelineFreshnessCheck === true,
      readCursor: (agentId) => {
        const timeline = selectAgentTimelineState(
          useSessionStore.getState().sessions[serverId],
          agentId,
        );
        return timeline.status === "synced" ? (timeline.range ?? undefined) : undefined;
      },
      setSubscription: (agentIds, cursors) =>
        client.setAgentTimelineSubscription(agentIds, cursors),
      fetchPage: async (agentId, request) => {
        const session = useSessionStore.getState().sessions[serverId];
        const initKey = getInitKey(serverId, agentId);
        const shouldInitialize = selectAgentTimelineState(session, agentId).status !== "synced";
        if (shouldInitialize) {
          if (!getInitDeferred(initKey)) {
            const deferred = createInitDeferred(initKey, request.direction ?? "tail");
            void deferred.promise.catch(() => undefined);
          }
          refreshAgentInitializationTimeout({
            key: initKey,
            agentId,
            setAgentInitializing,
          });
          setAgentInitializing(agentId, true);
        }
        try {
          const page = await getHostRuntimeStore().fetchAgentTimeline(serverId, agentId, request);
          if (shouldInitialize && getInitDeferred(initKey)) {
            refreshAgentInitializationTimeout({ key: initKey, agentId, setAgentInitializing });
          }
          return page;
        } catch (error) {
          if (shouldInitialize) {
            setAgentInitializing(agentId, false);
            rejectInitDeferred(initKey, error instanceof Error ? error : new Error(String(error)));
          }
          throw error;
        }
      },
      fetchLatestTail: async (agentId) => {
        // The tail replaces the chat's history: applyTimelineResponse reads it as a reset.
        forcedTimelineTailReplacements.current.add(agentId);
        try {
          return await getHostRuntimeStore().fetchAgentTimeline(
            serverId,
            agentId,
            planTimelineTailFetch(),
          );
        } finally {
          forcedTimelineTailReplacements.current.delete(agentId);
        }
      },
      reportError: (error) => {
        console.warn("[Session] viewed timeline synchronization failed", { serverId, error });
      },
      schedule: (task, delayMs) => {
        const timeout = setTimeout(task, delayMs);
        return () => clearTimeout(timeout);
      },
    });
    viewedTimelineSyncRef.current = sync;
    setViewedTimelineSync(serverId, sync);
    sync.setActive(getIsAppVisible(appStateRef.current));

    return () => {
      if (viewedTimelineSyncRef.current === sync) {
        viewedTimelineSyncRef.current = null;
      }
      setViewedTimelineSync(serverId, null);
      sync.dispose();
    };
  }, [client, serverId, setInitializingAgents, setViewedTimelineSync]);

  useEffect(() => {
    viewedTimelineSyncRef.current?.setConnected(isConnected);
  }, [isConnected]);

  useEffect(
    () =>
      getHostRuntimeStore().subscribeAgentStoppedRunning(serverId, (agentId) => {
        const session = useSessionStore.getState().sessions[serverId];
        const timeline = selectAgentTimelineState(session, agentId);
        if (timeline.status === "synced" && timeline.newer === "available") {
          return;
        }
        viewedTimelineSyncRef.current?.reconcileAgent(agentId);
      }),
    [serverId],
  );

  // Daemon message handlers - directly update Zustand store
  useEffect(() => {
    const owner = viewedTimelineSyncRef.current;
    if (!owner) throw new Error("Viewed timeline owner is unavailable");

    const unsubAgentStream = client.on("agent_stream", (message) => {
      if (message.type !== "agent_stream") return;
      const { agentId, event, timestamp, seq, epoch } = message.payload;
      const parsedTimestamp = new Date(timestamp);
      const streamEvent = event;
      if (
        event.type === "turn_started" ||
        event.type === "turn_completed" ||
        event.type === "turn_failed" ||
        event.type === "turn_canceled"
      ) {
        voiceRuntime?.onTurnEvent(serverId, agentId, event.type);
      }
      const turnLiveness = deriveAgentStreamTurnLiveness([
        { event: streamEvent, seq, epoch, timestamp: parsedTimestamp },
      ]);
      if (turnLiveness.length > 0) {
        applyAgentTurnLiveness(serverId, agentId, turnLiveness);
      }
      owner.enqueueStreamEvent(agentId, {
        event: streamEvent,
        seq,
        epoch,
        timestamp: parsedTimestamp,
      });

      // NOTE: We don't update lastActivityAt on every stream event to prevent
      // cascading rerenders. The agent_update handler updates agent.lastActivityAt
      // on status changes, which is sufficient for sorting and display purposes.
    });

    const unsubAgentAttention = client.onAgentAttentionRequired((notification) => {
      if (notification.shouldNotify) {
        notifyAgentAttention(notification);
      }
    });

    const unsubAgentTimeline = client.on("fetch_agent_timeline_response", (message) => {
      if (message.type !== "fetch_agent_timeline_response") return;
      owner.flushStreamAgent(message.payload.agentId);
      applyTimelineResponse(message.payload);
    });

    const unsubProviderSubagentUpdate = client.on("agent.provider_subagents.update", (message) => {
      if (message.type !== "agent.provider_subagents.update") return;
      useProviderSubagentStore.getState().applyUpdate(serverId, message.payload);
    });

    const unsubCheckoutStatusUpdate = client.on("checkout_status_update", (message) => {
      if (message.type !== "checkout_status_update") return;
      applyCheckoutStatusUpdateFromEvent({ queryClient, serverId, message });
    });

    const unsubWorkspaceSetupProgress = client.on("workspace_setup_progress", (message) => {
      if (message.type !== "workspace_setup_progress") return;
      applyWorkspaceSetupProgress(message.payload);
    });

    const unsubWorkspaceSetupStatusResponse = client.on(
      "workspace_setup_status_response",
      (message) => {
        if (message.type !== "workspace_setup_status_response") return;
        const { workspaceId, snapshot } = message.payload;
        if (snapshot) {
          applyWorkspaceSetupProgress({ workspaceId, ...snapshot });
        }
      },
    );

    const unsubStatus = client.on("status", (message) => {
      if (message.type !== "status") return;
      const serverInfo = parseServerInfoStatusPayload(message.payload);
      if (serverInfo) {
        viewedTimelineSyncRef.current?.setDeliveryMode(
          getTimelineDeliveryMode(serverInfo.features?.selectiveAgentTimeline),
        );
        updateSessionServerInfo(serverId, toDaemonServerInfo(serverInfo));
        return;
      }
    });

    const unsubPermissionRequest = client.on("agent_permission_request", (message) => {
      if (message.type !== "agent_permission_request") return;
      const { agentId, request } = message.payload;

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        const key = derivePendingPermissionKey(agentId, request);
        next.set(key, { key, agentId, request });
        return next;
      });
    });

    const unsubPermissionResolved = client.on("agent_permission_resolved", (message) => {
      if (message.type !== "agent_permission_resolved") return;
      const { requestId, agentId } = message.payload;

      setPendingPermissions(serverId, (prev) => {
        const next = new Map(prev);
        const derivedKey = `${agentId}:${requestId}`;
        if (!next.delete(derivedKey)) {
          for (const [key, pending] of next.entries()) {
            if (pending.agentId === agentId && pending.request.id === requestId) {
              next.delete(key);
              break;
            }
          }
        }
        return next;
      });
    });

    const unsubAudioOutput = client.on("audio_output", async (message) => {
      if (message.type !== "audio_output") return;
      if (!voiceAudioEngine) {
        return;
      }

      const payload: AudioOutputPayload = message.payload;
      if (payload.isVoiceMode && voiceRuntime) {
        voiceRuntime.handleAudioOutput(serverId, payload);
        return;
      }

      const playbackGroupId = payload.groupId ?? payload.id;
      const chunkIndex = payload.chunkIndex ?? 0;
      const isFinalChunk = payload.isLastChunk ?? true;

      if (!audioOutputBuffersRef.current.has(playbackGroupId)) {
        audioOutputBuffersRef.current.set(playbackGroupId, []);
      }

      const bufferedChunks = audioOutputBuffersRef.current.get(playbackGroupId)!;
      bufferedChunks.push({
        chunkIndex,
        audio: payload.audio,
        format: payload.format,
        id: payload.id,
      });

      activeAudioGroupsRef.current.add(playbackGroupId);
      setIsPlayingAudio(serverId, true);

      if (!isFinalChunk) {
        return;
      }

      bufferedChunks.sort((left, right) => left.chunkIndex - right.chunkIndex);
      const chunkIds = bufferedChunks.map((chunk) => chunk.id);
      const shouldPlay =
        !payload.isVoiceMode || (voiceRuntime?.shouldPlayVoiceAudio(serverId) ?? false);
      const audioBlob = buildAudioPlaybackSource(bufferedChunks);
      function logAudioPlayedError(error: unknown): void {
        console.warn("[Session] Failed to confirm audio playback:", error);
      }
      const confirmAudioPlayed = async () => {
        await Promise.all(
          chunkIds.map((chunkId) => client.audioPlayed(chunkId).catch(logAudioPlayedError)),
        );
      };

      let startedVoicePlayback = false;
      try {
        if (shouldPlay) {
          if (payload.isVoiceMode) {
            startedVoicePlayback = true;
            voiceRuntime?.onAssistantAudioStarted(serverId);
          }
          await voiceAudioEngine.play(audioBlob);
        }
        await confirmAudioPlayed();
      } catch (error) {
        console.error("[Session] Audio playback error:", error);
        await confirmAudioPlayed();
      } finally {
        audioOutputBuffersRef.current.delete(playbackGroupId);
        activeAudioGroupsRef.current.delete(playbackGroupId);
        setIsPlayingAudio(serverId, activeAudioGroupsRef.current.size > 0);

        if (startedVoicePlayback) {
          voiceRuntime?.onAssistantAudioFinished(serverId);
        }
      }
    });

    const unsubActivity = client.on("activity_log", (message) => {
      if (message.type !== "activity_log") return;
      const data = message.payload;
      if (data.type === "system" && data.content.includes("Transcribing")) {
        return;
      }

      if (data.type === "tool_call" && data.metadata) {
        const toolCallId =
          typeof data.metadata.toolCallId === "string" ? data.metadata.toolCallId : "";
        const toolName = typeof data.metadata.toolName === "string" ? data.metadata.toolName : "";
        const args = data.metadata.arguments;

        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "tool_call",
            id: toolCallId,
            timestamp: Date.now(),
            toolName,
            args,
            status: "executing",
          },
        ]);
        return;
      }

      if (data.type === "tool_result" && data.metadata) {
        const toolCallId =
          typeof data.metadata.toolCallId === "string" ? data.metadata.toolCallId : "";
        const result = data.metadata.result;

        const applyToolResult = applyToolResultToMessages(toolCallId, result);
        setMessages(serverId, applyToolResult);
        return;
      }

      if (data.type === "error" && data.metadata && "toolCallId" in data.metadata) {
        const toolCallId =
          typeof data.metadata.toolCallId === "string" ? data.metadata.toolCallId : "";
        const error = data.metadata.error;

        const applyToolError = applyToolErrorToMessages(toolCallId, error);
        setMessages(serverId, applyToolError);
      }

      notifyVoiceAbortFailure(data, toast.error);

      let activityType: "system" | "info" | "success" | "error" = "info";
      if (data.type === "error") activityType = "error";

      if (data.type === "transcript") {
        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "user",
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        return;
      }

      if (data.type === "assistant") {
        setMessages(serverId, (prev) => [
          ...prev,
          {
            type: "assistant",
            id: generateMessageId(),
            timestamp: Date.now(),
            message: data.content,
          },
        ]);
        setCurrentAssistantMessage(serverId, "");
        return;
      }

      setMessages(serverId, (prev) => [
        ...prev,
        {
          type: "activity",
          id: generateMessageId(),
          timestamp: Date.now(),
          activityType,
          message: data.content,
          metadata: data.metadata,
        },
      ]);
    });

    const unsubChunk = client.on("assistant_chunk", (message) => {
      if (message.type !== "assistant_chunk") return;
      setCurrentAssistantMessage(serverId, (prev) => prev + message.payload.chunk);
    });

    const unsubTranscription = client.on("transcription_result", (message) => {
      if (message.type !== "transcription_result") return;

      const transcriptText = message.payload.text.trim();
      voiceRuntime?.onTranscriptionResult(serverId, transcriptText);
      if (!transcriptText) {
        return;
      }

      setCurrentAssistantMessage(serverId, "");
    });

    const unsubVoiceInputState = client.on("voice_input_state", (message) => {
      if (message.type !== "voice_input_state") return;
      voiceRuntime?.onServerSpeechStateChanged(serverId, message.payload.isSpeaking);
    });

    const unsubTerminalAttention = client.on("terminal_attention_required", (message) => {
      if (message.type !== "terminal_attention_required") {
        return;
      }
      deliverTerminalAttentionOsNotification({
        serverId,
        payload: message.payload,
        preferences: getCurrentNotificationPreferences(queryClient),
        sendNotification: sendOsNotification,
      });
    });

    return () => {
      unsubAgentStream();
      unsubAgentTimeline();
      unsubProviderSubagentUpdate();
      unsubAgentAttention();
      unsubCheckoutStatusUpdate();
      unsubWorkspaceSetupProgress();
      unsubWorkspaceSetupStatusResponse();
      unsubStatus();
      unsubPermissionRequest();
      unsubPermissionResolved();
      unsubAudioOutput();
      unsubActivity();
      unsubChunk();
      unsubTranscription();
      unsubVoiceInputState();
      unsubTerminalAttention();
    };
  }, [
    client,
    queryClient,
    serverId,
    setIsPlayingAudio,
    setMessages,
    setCurrentAssistantMessage,
    setAgentStreamTail,
    setAgentStreamHead,
    applyAgentTurnLiveness,
    clearAgentStreamHead,
    setInitializingAgents,
    setAgents,
    setPendingPermissions,
    notifyAgentAttention,
    applyWorkspaceSetupProgress,
    applyTimelineResponse,
    updateSessionServerInfo,
    toast,
    voiceRuntime,
    voiceAudioEngine,
  ]);

  useEffect(() => {
    // Native apps receive plugin alerts via remote push only (`sendOsNotification` is a no-op
    // on native). Subscribing on native would mark the phone as the active in-app recipient and
    // suppress its own Expo push without rendering anything in-app.
    // COMPAT(pluginNotifications): added in v0.12.2, remove gate after 2027-06-01.
    if (isNative || !supportsPluginNotifications) {
      return;
    }
    const pluginNotificationsFeed = client.observeEvents(["plugin.notification"], {
      notifications: true,
    });
    const unsubPluginNotification = pluginNotificationsFeed.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "plugin.notification") {
          return;
        }
        deliverPluginOsNotification({
          serverId,
          payload: message.payload,
          preferences: getCurrentNotificationPreferences(queryClient),
          sendNotification: sendOsNotification,
        });
      },
    });
    return () => {
      unsubPluginNotification();
      void pluginNotificationsFeed
        .release()
        .catch((error) =>
          console.warn("[Session] Failed to release plugin notifications feed", error),
        );
    };
  }, [client, queryClient, serverId, supportsPluginNotifications]);

  const _cancelAgentRun = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] cancelAgent skipped: daemon unavailable");
        return;
      }
      void client.cancelAgent(agentId).catch((error) => {
        console.error("[Session] Failed to cancel agent:", error);
      });
    },
    [client],
  );

  const _deleteAgent = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] deleteAgent skipped: daemon unavailable");
        return;
      }
      void client.deleteAgent(agentId).catch((error) => {
        console.error("[Session] Failed to delete agent:", error);
      });
    },
    [client],
  );

  const _archiveAgent = useCallback(
    (agentId: string) => {
      if (!client) {
        console.warn("[Session] archiveAgent skipped: daemon unavailable");
        return;
      }
      void client.archiveAgent(agentId).catch((error) => {
        console.error("[Session] Failed to archive agent:", error);
      });
    },
    [client],
  );

  const _restartServer = useCallback(
    (reason?: string) => {
      if (!client) {
        console.warn("[Session] restartServer skipped: daemon unavailable");
        return;
      }
      void client.restartServer(reason).catch((error) => {
        console.error("[Session] Failed to restart server:", error);
      });
    },
    [client],
  );

  const _setAgentMode = useCallback(
    (agentId: string, modeId: string) => {
      if (!client) {
        console.warn("[Session] setAgentMode skipped: daemon unavailable");
        return;
      }
      void client
        .setAgentMode(agentId, modeId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.error("[Session] Failed to set agent mode:", error);
          toast.error(toErrorMessage(error));
        });
    },
    [client, toast],
  );

  const _setAgentModel = useCallback(
    (agentId: string, modelId: string | null) => {
      if (!client) {
        console.warn("[Session] setAgentModel skipped: daemon unavailable");
        return;
      }
      void client.setAgentModel(agentId, modelId).catch((error) => {
        console.error("[Session] Failed to set agent model:", error);
        toast.error(toErrorMessage(error));
      });
    },
    [client, toast],
  );

  const _setAgentThinkingOption = useCallback(
    (agentId: string, thinkingOptionId: string | null) => {
      if (!client) {
        console.warn("[Session] setAgentThinkingOption skipped: daemon unavailable");
        return;
      }
      void client
        .setAgentThinkingOption(agentId, thinkingOptionId)
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.error("[Session] Failed to set agent thinking option:", error);
          toast.error(toErrorMessage(error));
        });
    },
    [client, toast],
  );

  const _respondToPermission = useCallback(
    (agentId: string, requestId: string, response: AgentPermissionResponse) => {
      if (!client) {
        console.warn("[Session] respondToPermission skipped: daemon unavailable");
        return;
      }
      void client.respondToPermission(agentId, requestId, response).catch((error) => {
        console.error("[Session] Failed to respond to permission:", error);
      });
    },
    [client],
  );

  return children;
}
