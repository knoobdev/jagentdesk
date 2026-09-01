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
import { buildDatabaseSystemPrompt } from "@/components/database-ask-agent";
import { databaseChatTitle } from "@/utils/database-chat-title";
import type { AgentSnapshotPayload } from "@jagentdesk/protocol/messages";
import type { CreateAgentRequestOptions } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";

const DATABASE_AGENT_LABEL = "jagentdesk.database.id";

export interface DatabaseComposerContext {
  engine: string;
  schema?: string;
  table?: string;
}

function resolveModeId(modeOptionIds: readonly string[], selectedMode: string): string | undefined {
  if (modeOptionIds.length === 0) return undefined;
  return modeOptionIds.includes(selectedMode) ? selectedMode : modeOptionIds[0];
}

/** Assemble the flat createAgent options for a database chat (kept out of the
 *  create-flow callback so its cyclomatic complexity stays readable). */
function buildDatabaseCreateOptions(input: {
  provider: string;
  cwd: string;
  databaseId: string;
  databaseName: string;
  context: DatabaseComposerContext;
  text: string;
  clientMessageId: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  images?: CreateAgentRequestOptions["images"];
  attachments?: CreateAgentRequestOptions["attachments"];
}): CreateAgentRequestOptions {
  const { provider, cwd, databaseId, databaseName, context, text } = input;
  const options: CreateAgentRequestOptions = {
    provider,
    cwd,
    systemPrompt: buildDatabaseSystemPrompt({
      databaseId,
      engine: context.engine,
      databaseName,
      schema: context.schema,
      table: context.table,
    }),
    labels: { [DATABASE_AGENT_LABEL]: databaseId },
    clientMessageId: input.clientMessageId,
  };
  if (input.modeId) options.modeId = input.modeId;
  if (input.model) options.model = input.model;
  if (input.thinkingOptionId) options.thinkingOptionId = input.thinkingOptionId;
  if (input.featureValues) options.featureValues = input.featureValues;
  const title = databaseChatTitle(databaseName, text);
  if (title) options.title = title;
  if (text) options.initialPrompt = text;
  if (input.images && input.images.length > 0) options.images = input.images;
  if (input.attachments && input.attachments.length > 0) options.attachments = input.attachments;
  return options;
}

/**
 * The pre-agent chat surface for a database: the REAL agent composer with NO
 * agent created yet. The database agent is created only when the user actually
 * sends a message — seeded with the database system prompt + label and titled
 * from that message. Mirrors ClusterDraftChat. Shared desktop + mobile.
 */
export function DatabaseDraftChat({
  serverId,
  databaseId,
  databaseName,
  context,
  cwd,
  isPaneFocused,
  onCreated,
}: {
  serverId: string;
  databaseId: string;
  databaseName: string;
  context: DatabaseComposerContext;
  cwd: string;
  isPaneFocused: boolean;
  onCreated: (input: { databaseId: string; agentId: string; workspaceId: string | null }) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const draftId = useMemo(() => generateDraftId(), []);
  const tabId = `database-draft-${databaseId}`;
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
      const options = buildDatabaseCreateOptions({
        provider,
        cwd: submitCwd,
        databaseId,
        databaseName,
        context,
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
      onCreated({ databaseId, agentId: result.id, workspaceId });
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
