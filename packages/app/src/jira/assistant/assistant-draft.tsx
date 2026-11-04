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
import type { AgentSnapshotPayload } from "@jagentdesk/protocol/messages";
import type { CreateAgentRequestOptions } from "@jagentdesk/client/internal/daemon-client";
import {
  buildJiraAssistantSystemPrompt,
  JIRA_ASSISTANT_LABEL,
  JIRA_ASSISTANT_SCOPE_LABEL,
  jiraAssistantScope,
  jiraAssistantTitle,
  type JiraAssistantContext,
} from "./context";

// The Jira assistant before its agent exists: the real agent composer; the agent is created on
// the first message with the Jira system prompt and labels (same flow as the Forge assistant).

type ComposerState = ReturnType<typeof useAgentInputDraft>["composerState"];

/** Model, mode, thinking and feature choices from the composer, as createAgent options. */
function composerOverrides(state: ComposerState): Partial<CreateAgentRequestOptions> {
  if (!state) return {};
  const modeIds = state.modeOptions.map((mode) => mode.id);
  const overrides: Partial<CreateAgentRequestOptions> = {};
  if (modeIds.length > 0) {
    overrides.modeId = modeIds.includes(state.selectedMode) ? state.selectedMode : modeIds[0];
  }
  if (state.effectiveModelId) overrides.model = state.effectiveModelId;
  if (state.effectiveThinkingOptionId) overrides.thinkingOptionId = state.effectiveThinkingOptionId;
  if (state.featureValues) overrides.featureValues = state.featureValues;
  return overrides;
}

export function JiraAssistantDraft({
  serverId,
  context,
  cwd,
  onCreated,
}: {
  serverId: string;
  context: JiraAssistantContext;
  cwd: string;
  onCreated: (input: { agentId: string; workspaceId: string | null }) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const draftId = useMemo(() => generateDraftId(), []);
  const tabId = "jira-assistant-draft";
  const onlineServerIds = useMemo(() => (isConnected ? [serverId] : []), [isConnected, serverId]);
  const draftStoreKey = useMemo(
    () => buildDraftStoreKey({ serverId, agentId: tabId, draftId }),
    [serverId, draftId],
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
      if (isWeb) (document.activeElement as HTMLElement | null)?.blur?.();
      Keyboard.dismiss();
    },
    buildDraftAgent: () => null,
    createRequest: async ({ attempt, text, images, attachments, cwd: submitCwd }) => {
      if (!client) throw new Error("Host disconnected");
      const provider = composerState?.selectedProvider;
      if (!provider) throw new Error("Select a model first");
      const options: CreateAgentRequestOptions = {
        provider,
        cwd: submitCwd,
        systemPrompt: buildJiraAssistantSystemPrompt(context),
        labels: {
          [JIRA_ASSISTANT_LABEL]: "true",
          [JIRA_ASSISTANT_SCOPE_LABEL]: jiraAssistantScope(context),
        },
        clientMessageId: attempt.clientMessageId,
        title: jiraAssistantTitle(context, text),
        ...(text ? { initialPrompt: text } : {}),
        ...composerOverrides(composerState),
      };
      const imagesData = await encodeImages(images);
      if (imagesData && imagesData.length > 0) options.images = imagesData;
      if (Array.isArray(attachments) && attachments.length > 0) options.attachments = attachments;
      const result = await client.createAgent(options);
      return { agentId: result.id, result };
    },
    onCreateSuccess: ({ result }) => {
      draftInput.clear("sent");
      const workspaceId =
        typeof (result as { workspaceId?: unknown }).workspaceId === "string"
          ? (result as { workspaceId: string }).workspaceId
          : null;
      onCreated({ agentId: result.id, workspaceId });
    },
  });

  const agentControls = useMemo(
    () => (composerState ? { ...composerState.agentControls, disabled: isSubmitting } : undefined),
    [composerState, isSubmitting],
  );
  if (!composerState) return <View style={styles.container} />;
  return (
    <View style={styles.container} testID="jira-assistant-draft">
      <Composer
        agentId={tabId}
        serverId={serverId}
        isPaneFocused
        onSubmitMessage={handleCreateFromInput}
        isSubmitLoading={isSubmitting}
        blurOnSubmit
        value={draftInput.text}
        onChangeText={draftInput.setText}
        attachments={draftInput.attachments}
        onChangeAttachments={draftInput.setAttachments}
        cwd={composerState.workingDir}
        clearDraft={draftInput.clear}
        autoFocus
        autoFocusKey={String(draftInput.attachmentFocusRequestId)}
        commandDraftConfig={composerState.commandDraftConfig}
        agentControls={agentControls}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  container: { flex: 1, justifyContent: "flex-end" },
}));
