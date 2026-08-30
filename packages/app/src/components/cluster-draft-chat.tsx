import { useMemo } from "react";
import { Keyboard, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import { useDraftAgentCreateFlow } from "@/composer/draft/create-flow";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { encodeImages } from "@/utils/encode-images";
import { isWeb } from "@/constants/platform";
import { buildClusterSystemPrompt } from "@/components/cluster-ask-agent";
import { clusterChatTitle } from "@/utils/cluster-chat-title";
import type { ClusterComposerResource } from "@/components/cluster-composer";
import type { AgentSnapshotPayload } from "@jagentdesk/protocol/messages";
import type { CreateAgentRequestOptions } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";

const CLUSTER_AGENT_LABEL = "jagentdesk.cluster.id";

function resolveModeId(modeOptionIds: readonly string[], selectedMode: string): string | undefined {
  if (modeOptionIds.length === 0) return undefined;
  return modeOptionIds.includes(selectedMode) ? selectedMode : modeOptionIds[0];
}

/** Assemble the flat createAgent options for a cluster chat (kept out of the
 *  create-flow callback so its cyclomatic complexity stays readable). */
function buildClusterCreateOptions(input: {
  provider: string;
  cwd: string;
  clusterId: string;
  clusterName: string;
  resource?: ClusterComposerResource;
  text: string;
  clientMessageId: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  images?: CreateAgentRequestOptions["images"];
  attachments?: CreateAgentRequestOptions["attachments"];
}): CreateAgentRequestOptions {
  const { provider, cwd, clusterId, clusterName, resource, text } = input;
  const options: CreateAgentRequestOptions = {
    provider,
    cwd,
    systemPrompt: buildClusterSystemPrompt({
      clusterId,
      kind: resource?.kind ?? "cluster",
      namespace: resource?.namespace,
      name: resource?.name,
      yaml: resource?.yaml ?? undefined,
      logs: resource?.logs ?? undefined,
    }),
    labels: { [CLUSTER_AGENT_LABEL]: clusterId },
    clientMessageId: input.clientMessageId,
  };
  if (input.modeId) options.modeId = input.modeId;
  if (input.model) options.model = input.model;
  if (input.thinkingOptionId) options.thinkingOptionId = input.thinkingOptionId;
  if (input.featureValues) options.featureValues = input.featureValues;
  const title = clusterChatTitle(clusterName, text);
  if (title) options.title = title;
  if (text) options.initialPrompt = text;
  if (input.images && input.images.length > 0) options.images = input.images;
  if (input.attachments && input.attachments.length > 0) options.attachments = input.attachments;
  return options;
}

/**
 * The pre-agent chat surface for a cluster: the REAL agent composer (model /
 * thinking / permission / @files / commands / subagents) with NO agent created
 * yet. The cluster agent is created only when the user actually sends a message —
 * seeded with the cluster's system prompt + labels and titled from that message
 * (like a normal chat agent, but prefixed with the cluster to stay distinct).
 * Shared by desktop + mobile.
 */
export function ClusterDraftChat({
  serverId,
  clusterId,
  clusterName,
  resource,
  cwd,
  isPaneFocused,
  onCreated,
}: {
  serverId: string;
  clusterId: string;
  clusterName: string;
  resource?: ClusterComposerResource;
  cwd: string;
  isPaneFocused: boolean;
  onCreated: (input: { clusterId: string; agentId: string; workspaceId: string | null }) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const draftId = useMemo(() => generateDraftId(), []);
  const tabId = `cluster-draft-${clusterId}`;
  const onlineServerIds = useMemo(() => (isConnected ? [serverId] : []), [isConnected, serverId]);
  const draftStoreKey = useMemo(
    () => buildDraftStoreKey({ serverId, agentId: tabId, draftId }),
    [serverId, tabId, draftId],
  );
  const draftInput = useAgentInputDraft({
    draftKey: draftStoreKey,
    composer: {
      initialServerId: serverId,
      initialValues: { workingDir: cwd },
      isVisible: true,
      onlineServerIds,
      lockedWorkingDir: cwd,
    },
  });
  const composerState = draftInput.composerState;

  const { isSubmitting, handleCreateFromInput } = useDraftAgentCreateFlow<
    null,
    AgentSnapshotPayload
  >({
    draftId,
    getPendingServerId: () => serverId,
    onBeforeSubmit: async () => {
      await composerState?.persistFormPreferences?.();
      if (isWeb) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      Keyboard.dismiss();
    },
    buildDraftAgent: () => null,
    createRequest: async ({ attempt, text, images, attachments, cwd: submitCwd }) => {
      if (!client) throw new Error("Host disconnected");
      const provider = composerState?.selectedProvider;
      if (!provider) throw new Error("Select a model first");
      const imagesData = await encodeImages(images);
      const options = buildClusterCreateOptions({
        provider,
        cwd: submitCwd,
        clusterId,
        clusterName,
        resource,
        text,
        clientMessageId: attempt.clientMessageId,
        modeId: resolveModeId(
          (composerState?.modeOptions ?? []).map((m) => m.id),
          composerState?.selectedMode ?? "",
        ),
        model: composerState?.effectiveModelId || undefined,
        thinkingOptionId: composerState?.effectiveThinkingOptionId || undefined,
        featureValues: composerState?.featureValues,
        images: imagesData,
        attachments: Array.isArray(attachments) ? attachments : undefined,
      });
      const result = await client.createAgent(options);
      return { agentId: result.id, result };
    },
    onCreateSuccess: ({ result }) => {
      draftInput.clear("sent");
      const workspaceId =
        typeof (result as { workspaceId?: unknown }).workspaceId === "string"
          ? (result as { workspaceId: string }).workspaceId
          : null;
      onCreated({ clusterId, agentId: result.id, workspaceId });
    },
  });

  const agentControls = useMemo(
    () => (composerState ? { ...composerState.agentControls, disabled: isSubmitting } : undefined),
    [composerState, isSubmitting],
  );

  if (!composerState) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <Composer
        agentId={tabId}
        serverId={serverId}
        isPaneFocused={isPaneFocused}
        onSubmitMessage={handleCreateFromInput}
        isSubmitLoading={isSubmitting}
        blurOnSubmit
        value={draftInput.text}
        onChangeText={draftInput.setText}
        attachments={draftInput.attachments}
        onChangeAttachments={draftInput.setAttachments}
        cwd={composerState.workingDir}
        clearDraft={draftInput.clear}
        autoFocus={isPaneFocused}
        autoFocusKey={String(draftInput.attachmentFocusRequestId)}
        commandDraftConfig={composerState.commandDraftConfig}
        agentControls={agentControls}
      />
    </View>
  );
}

const styles = StyleSheet.create((_theme: Theme) => ({
  container: {
    flex: 1,
    justifyContent: "flex-end",
  },
}));
