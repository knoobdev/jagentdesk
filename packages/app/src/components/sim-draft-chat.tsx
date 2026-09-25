import { createDockWorkspace } from "@/components/dock-workspace";
import { SIM_AGENT_LABEL } from "@/utils/dock-agents";
export { SIM_AGENT_LABEL } from "@/utils/dock-agents";
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
import { buildSimSystemPrompt, simChatTitle } from "@/components/sim-ask-agent";
import type { AgentSnapshotPayload } from "@jagentdesk/protocol/messages";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { CreateAgentRequestOptions } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";

function resolveModeId(modeOptionIds: readonly string[], selectedMode: string): string | undefined {
  if (modeOptionIds.length === 0) return undefined;
  return modeOptionIds.includes(selectedMode) ? selectedMode : modeOptionIds[0];
}

/** Assemble the flat createAgent options for a fleet chat. */
function buildSimCreateOptions(input: {
  provider: string;
  cwd: string;
  serverId: string;
  devices: readonly SimDevice[];
  selected: SimDevice | null;
  text: string;
  clientMessageId: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  images?: CreateAgentRequestOptions["images"];
  attachments?: CreateAgentRequestOptions["attachments"];
}): CreateAgentRequestOptions {
  const options: CreateAgentRequestOptions = {
    provider: input.provider,
    cwd: input.cwd,
    systemPrompt: buildSimSystemPrompt({ devices: input.devices, selected: input.selected }),
    labels: { [SIM_AGENT_LABEL]: input.serverId },
    clientMessageId: input.clientMessageId,
  };
  if (input.modeId) options.modeId = input.modeId;
  if (input.model) options.model = input.model;
  if (input.thinkingOptionId) options.thinkingOptionId = input.thinkingOptionId;
  if (input.featureValues) options.featureValues = input.featureValues;
  const title = simChatTitle(input.text);
  if (title) options.title = title;
  if (input.text) options.initialPrompt = input.text;
  if (input.images && input.images.length > 0) options.images = input.images;
  if (input.attachments && input.attachments.length > 0) options.attachments = input.attachments;
  return options;
}

/**
 * The pre-agent chat surface for the simulator fleet: the REAL agent composer with NO agent
 * created yet. The agent is created only when the user sends a message — seeded with the fleet
 * system prompt + label and titled from that message. Mirrors DatabaseDraftChat.
 */
export function SimDraftChat({
  serverId,
  devices,
  selected,
  cwd,
  isPaneFocused,
  onCreated,
}: {
  serverId: string;
  devices: readonly SimDevice[];
  selected: SimDevice | null;
  cwd: string;
  isPaneFocused: boolean;
  onCreated: (input: { serverId: string; agentId: string; workspaceId: string | null }) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const draftId = useMemo(() => generateDraftId(), []);
  const tabId = `simfleet-draft-${serverId}`;
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
      const options = buildSimCreateOptions({
        provider,
        cwd: submitCwd,
        serverId,
        devices,
        selected,
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
      // Its own workspace in the project, so the chat is listed under the project.
      const home = await createDockWorkspace({
        client,
        serverId,
        cwd: options.cwd ?? submitCwd,
        title: options.title ?? undefined,
      });
      options.workspaceId = home.workspaceId;
      options.cwd = home.cwd;
      const result = await client.createAgent(options);
      return { agentId: result.id, result };
    },
    onCreateSuccess: ({ result }) => {
      draftInput.clear("sent");
      const workspaceId =
        typeof (result as { workspaceId?: unknown }).workspaceId === "string"
          ? (result as { workspaceId: string }).workspaceId
          : null;
      onCreated({ serverId, agentId: result.id, workspaceId });
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
