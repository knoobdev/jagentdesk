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
import type { AgentSnapshotPayload, ForgeRepoRef } from "@jagentdesk/protocol/messages";
import type { CreateAgentRequestOptions } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";

// A single dedicated Forge assistant per host; reused across opens (see
// forge-assistant-panel.tsx). The value is constant — repo focus is expressed
// through the system prompt at creation, not the label.
export const FORGE_ASSISTANT_LABEL = "jagentdesk.forge.assistant";

/**
 * The Forge assistant's provider-agnostic instructions. It drives the shared
 * `forge_*` MCP tools (injected into every agent) to manage the user's
 * GitHub / GitLab / Bitbucket from afar. Product strings stay in English.
 */
export function buildForgeAssistantSystemPrompt(repo: ForgeRepoRef | null): string {
  const lines = [
    "You are the Forge assistant inside JAgentDesk.",
    "You manage the user's GitHub, GitLab, and Bitbucket repositories from afar using the forge_* tools: forge_list_repos, forge_list_change_requests, forge_get_change_request_files, forge_list_pipelines, forge_list_issues, forge_read_file, forge_list_commits, and the write tools forge_comment_issue, forge_create_issue, forge_rerun_pipeline, forge_merge_change_request, and forge_create_change_request.",
    "Prefer the forge_* tools over shell or git commands.",
    "Every write tool asks the user to approve through a permission prompt, so tell the user what you are about to do before you call one.",
  ];
  if (repo) {
    lines.push(
      `The repository currently in context is ${repo.forge}/${repo.owner}/${repo.name}. Operate on it by default unless the user names another repository.`,
    );
  } else {
    lines.push(
      "No repository is in context yet. Call forge_list_repos first to discover the user's repositories before acting.",
    );
  }
  return lines.join("\n");
}

function forgeChatTitle(repo: ForgeRepoRef | null, text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const scope = repo ? `${repo.owner}/${repo.name}` : "Forge";
  if (!trimmed) return `${scope} · assistant`;
  const snippet = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
  return `${scope} · ${snippet}`;
}

function resolveModeId(modeOptionIds: readonly string[], selectedMode: string): string | undefined {
  if (modeOptionIds.length === 0) return undefined;
  return modeOptionIds.includes(selectedMode) ? selectedMode : modeOptionIds[0];
}

/** Assemble the flat createAgent options for the Forge assistant (kept out of
 *  the create-flow callback so its cyclomatic complexity stays readable). */
function buildForgeCreateOptions(input: {
  provider: string;
  cwd: string;
  repo: ForgeRepoRef | null;
  text: string;
  clientMessageId: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  images?: CreateAgentRequestOptions["images"];
  attachments?: CreateAgentRequestOptions["attachments"];
}): CreateAgentRequestOptions {
  const { provider, cwd, repo, text } = input;
  const options: CreateAgentRequestOptions = {
    provider,
    cwd,
    systemPrompt: buildForgeAssistantSystemPrompt(repo),
    labels: { [FORGE_ASSISTANT_LABEL]: "true" },
    clientMessageId: input.clientMessageId,
  };
  if (input.modeId) options.modeId = input.modeId;
  if (input.model) options.model = input.model;
  if (input.thinkingOptionId) options.thinkingOptionId = input.thinkingOptionId;
  if (input.featureValues) options.featureValues = input.featureValues;
  const title = forgeChatTitle(repo, text);
  if (title) options.title = title;
  if (text) options.initialPrompt = text;
  if (input.images && input.images.length > 0) options.images = input.images;
  if (input.attachments && input.attachments.length > 0) options.attachments = input.attachments;
  return options;
}

/**
 * The pre-agent chat surface for the Forge assistant: the REAL agent composer
 * (model / thinking / permission / @files / commands) with NO agent created
 * yet. The assistant agent is created only when the user actually sends a
 * message — seeded with the Forge system prompt + label and titled from that
 * message. Mirrors ClusterDraftChat / DatabaseDraftChat. Shared desktop +
 * mobile.
 */
export function ForgeAssistantDraft({
  serverId,
  repo,
  cwd,
  isPaneFocused,
  onCreated,
}: {
  serverId: string;
  repo: ForgeRepoRef | null;
  cwd: string;
  isPaneFocused: boolean;
  onCreated: (input: { agentId: string; workspaceId: string | null }) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const draftId = useMemo(() => generateDraftId(), []);
  const tabId = "forge-assistant-draft";
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
      const options = buildForgeCreateOptions({
        provider,
        cwd: submitCwd,
        repo,
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
      onCreated({ agentId: result.id, workspaceId });
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
    <View style={styles.container} testID="forge-assistant-draft">
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
