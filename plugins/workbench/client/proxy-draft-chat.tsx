import {
  createDockWorkspace,
  PROXY_AGENT_LABEL,
  Composer,
  useAgentInputDraft,
  useDraftAgentCreateFlow,
  buildDraftStoreKey,
  generateDraftId,
  useHostRuntimeClient,
  encodeImages,
  isWeb,
} from "../../../packages/app/src/plugins/builtin/host-api";
import type { Theme } from "../../../packages/app/src/plugins/builtin/host-api";
import { useMemo } from "react";
import { Keyboard, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { buildProxySystemPrompt, proxyChatTitle } from "./proxy-ask-agent";
import { type AgentSnapshotPayload } from "@jagentdesk/protocol/messages";
import { type CreateAgentRequestOptions } from "@jagentdesk/client/internal/daemon-client";

export { PROXY_AGENT_LABEL } from "../../../packages/app/src/plugins/builtin/host-api";

function resolveModeId(modeOptionIds: readonly string[], selectedMode: string): string | undefined {
  if (modeOptionIds.length === 0) return undefined;
  return modeOptionIds.includes(selectedMode) ? selectedMode : modeOptionIds[0];
}

/** Assemble the flat createAgent options for a Workbench chat. */
function buildProxyCreateOptions(input: {
  provider: string;
  cwd: string;
  serverId: string;
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
    systemPrompt: buildProxySystemPrompt(),
    labels: { [PROXY_AGENT_LABEL]: input.serverId },
    clientMessageId: input.clientMessageId,
  };
  if (input.modeId) options.modeId = input.modeId;
  if (input.model) options.model = input.model;
  if (input.thinkingOptionId) options.thinkingOptionId = input.thinkingOptionId;
  if (input.featureValues) options.featureValues = input.featureValues;
  const title = proxyChatTitle(input.text);
  if (title) options.title = title;
  if (input.text) options.initialPrompt = input.text;
  if (input.images && input.images.length > 0) options.images = input.images;
  if (input.attachments && input.attachments.length > 0) options.attachments = input.attachments;
  return options;
}

/**
 * The pre-agent chat surface for the Workbench: the REAL agent composer with NO agent created yet.
 * The agent is created only when the user sends a message — seeded with the Workbench system prompt
 * + label and titled from that message. Mirrors SimDraftChat.
 */
export function ProxyDraftChat({
  serverId,
  cwd,
  isPaneFocused,
  onCreated,
}: {
  serverId: string;
  cwd: string;
  isPaneFocused: boolean;
  onCreated: (input: { serverId: string; agentId: string; workspaceId: string | null }) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const draftId = useMemo(() => generateDraftId(), []);
  const tabId = `workbench-draft-${serverId}`;
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
      const options = buildProxyCreateOptions({
        provider,
        cwd: submitCwd,
        serverId,
        text,
        clientMessageId: attempt.clientMessageId,
        modeId: resolveModeId(
          (composerState?.modeOptions ?? []).map((m) => m.id),
          composerState?.selectedMode ?? "",
        ),
        model: composerState?.effectiveModelId || undefined,
        thinkingOptionId: composerState?.effectiveThinkingOptionId || undefined,
        featureValues: composerState?.providerOptions,
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
        textSource={draftInput.textSource}
        textReplacement={draftInput.textReplacement}
        onChangeText={draftInput.editText}
        attachments={draftInput.attachments}
        onChangeAttachments={draftInput.setAttachments}
        cwd={composerState.workingDir}
        clearDraft={draftInput.clear}
        autoFocus={isPaneFocused}
        autoFocusKey={String(draftInput.attachmentFocusRequestId)}
        commandDraft={composerState.commandDraft}
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
