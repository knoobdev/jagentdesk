import { createDockWorkspace } from "../../../packages/app/src/plugins/builtin/host-api";
import { DATABASE_AGENT_LABEL } from "../../../packages/app/src/plugins/builtin/host-api";
import { useMemo } from "react";
import { Keyboard, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Composer } from "../../../packages/app/src/plugins/builtin/host-api";
import { useAgentInputDraft } from "../../../packages/app/src/plugins/builtin/host-api";
import { useDraftAgentCreateFlow } from "../../../packages/app/src/plugins/builtin/host-api";
import {
  buildDraftStoreKey,
  generateDraftId,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { useHostRuntimeClient } from "../../../packages/app/src/plugins/builtin/host-api";
import { encodeImages } from "../../../packages/app/src/plugins/builtin/host-api";
import { isWeb } from "../../../packages/app/src/plugins/builtin/host-api";
import { buildDatabaseSystemPrompt } from "./database-ask-agent";
import { databaseChatTitle } from "./database-chat-title";
import { type AgentSnapshotPayload } from "@jagentdesk/protocol/messages";
import { type CreateAgentRequestOptions } from "@jagentdesk/client/internal/daemon-client";
import { type Theme } from "../../../packages/app/src/plugins/builtin/host-api";

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
  const draftId = useMemo(() => generateDraftId(), []);
  const tabId = `database-draft-${databaseId}`;
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
