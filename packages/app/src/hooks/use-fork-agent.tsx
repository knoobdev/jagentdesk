import type { ComponentProps } from "react";
import { useRouter } from "expo-router";
import { randomUUID } from "expo-crypto";
import { ForkFailedNotice } from "@/components/fork-failed-notice";
import { useTranslation } from "react-i18next";
import {
  type AgentForkContextOptions,
  type DaemonClient,
} from "@jagentdesk/client/internal/daemon-client";
import { type WorkspaceComposerAttachment } from "@/attachments/types";
import { type AssistantForkTarget } from "@/components/assistant-fork-menu";
import { type ToastApi } from "@/components/toast-host";
import { type AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostFeature } from "@/runtime/host-features";
import { generateDraftId } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { toErrorMessage } from "@/utils/error-messages";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { type WorkspaceDraftTabSetup, type WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * The subset of an agent record that a fork needs in order to seed the new
 * draft. Kept structural so both `AgentScreenAgent` (the agent-stream view's
 * live context) and the session store's `Agent` record satisfy it without a
 * projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  | "provider"
  | "cwd"
  | "currentModeId"
  | "model"
  | "thinkingOptionId"
  | "runtimeInfo"
  | "options"
  | "projectPlacement"
>;

/**
 * Boundary marking where the forked context should stop. Omit it entirely to
 * fork the whole timeline *up to now* — including a partially streamed
 * in-flight turn. `selectForkContextRows` projects the full timeline when
 * neither field is present, which is what makes mid-run forking work.
 */
export type ForkAgentBoundary = Pick<
  AgentForkContextOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkAgentRequest {
  agentId: string;
  agent: ForkAgentSource;
  workspaceId?: string;
  target: AssistantForkTarget;
  boundary?: ForkAgentBoundary;
}

export interface UseForkAgentInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

function buildChatHistoryAttachment(input: {
  draftId: string;
  serverId: string;
  agentId: string;
  payload: Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
  missingAttachmentMessage: string;
}): WorkspaceComposerAttachment {
  if (!input.payload.attachment) {
    throw new Error(input.missingAttachmentMessage);
  }
  return {
    kind: "chat_history",
    id: `chat_history:${input.draftId}`,
    attachment: input.payload.attachment,
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.payload.boundaryMessageId,
      boundaryCursor: input.payload.boundaryCursor,
      itemCount: input.payload.itemCount,
    },
  };
}

function renderForkFailedNotice(props: ComponentProps<typeof ForkFailedNotice>) {
  return <ForkFailedNotice {...props} />;
}

function buildForkDraftSetup(agent: ForkAgentSource): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) {
    return undefined;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    providerOptions: { ...agent.options },
  };
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

/**
 * Shared fork driver behind both turn-footer fork affordances: the completed
 * turn's footer (which supplies a boundary pinned to that turn) and the
 * in-flight turn's footer next to the progress loader (which omits the boundary
 * so the fork captures the still-streaming response).
 */
export function useForkAgent(
  input: UseForkAgentInput,
): (request: ForkAgentRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext") && !readOnly;
  const supportsNativeFork = useHostFeature(serverId, "agentNativeFork") && !readOnly;

  /**
   * Fast fork (spec 41 §6): the daemon forks the provider conversation natively and the new
   * agent opens as a tab. "Preparing fork…" stays up until it lands; a failure keeps its reason
   * and offers Retry with the same fork id. Resolves false when the provider has no native fork.
   */
  const forkNatively = async (request: {
    agentId: string;
    workspaceId: string;
    boundary?: ForkAgentBoundary;
    forkAgentId: string;
  }): Promise<boolean> => {
    if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
    const dismissPreparing = toast?.show(t("message.actions.forkPreparing"), {
      durationMs: null,
      testID: "fork-preparing-toast",
    });
    let result: Awaited<ReturnType<DaemonClient["forkAgent"]>>;
    try {
      result = await client.forkAgent(request.agentId, {
        ...request.boundary,
        forkAgentId: request.forkAgentId,
      });
    } catch (error) {
      result = {
        requestId: "",
        agentId: request.agentId,
        agent: null,
        error: toErrorMessage(error) || t("message.actions.forkFailed"),
        code: null,
      };
    } finally {
      dismissPreparing?.();
    }
    if (result.code === "native_fork_unavailable") return false;
    if (!result.agent) {
      const retry = () => {
        void forkNatively(request).catch((error: unknown) =>
          toast?.error(toErrorMessage(error) || t("message.actions.forkFailed")),
        );
      };
      toast?.show(
        renderForkFailedNotice({
          message: result.error ?? t("message.actions.forkFailed"),
          retryLabel: t("message.actions.forkRetry"),
          onRetry: retry,
        }),
        { variant: "error", durationMs: null, testID: "fork-failed-toast" },
      );
      return true;
    }
    navigateToWorkspace({
      serverId,
      workspaceId: request.workspaceId,
      target: { kind: "agent", agentId: result.agent.id },
    });
    return true;
  };

  const canFork = supportsAgentForkContext || supportsNativeFork;
  // A fork into another workspace runs in another checkout, which a provider session cannot move
  // to, so it keeps the seeded draft.
  const tryNativeFork = async (request: {
    agentId: string;
    workspaceId?: string;
    target: AssistantForkTarget;
    boundary?: ForkAgentBoundary;
  }): Promise<boolean> => {
    if (!supportsNativeFork || request.target !== "tab" || !request.workspaceId) return false;
    return forkNatively({
      agentId: request.agentId,
      workspaceId: request.workspaceId,
      boundary: request.boundary,
      forkAgentId: randomUUID(),
    });
  };

  return useStableEvent(async ({ agentId, agent, workspaceId, target, boundary }) => {
    try {
      if (!canFork) {
        toast?.error(t("message.actions.forkUnavailable"));
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (await tryNativeFork({ agentId, workspaceId, target, boundary })) return;
      // TODO(spec 40 §3): providers without a native fork are seeded with the curated chat
      // history below until the session ledger handoff (plat/xp) replaces it.
      if (!supportsAgentForkContext) {
        toast?.error(t("message.actions.forkUnavailable"));
        return;
      }
      const draftSetup = buildForkDraftSetup(agent);
      const prepareForkDraft = async () => {
        const draftId = generateDraftId();
        const payload = await client.buildAgentForkContext(agentId, boundary);
        const attachment = buildChatHistoryAttachment({
          draftId,
          serverId,
          agentId,
          payload,
          missingAttachmentMessage: t("message.actions.forkFailed"),
        });
        useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
          scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
          attachments: [attachment],
        });
        return draftId;
      };

      if (target === "tab") {
        if (!workspaceId) {
          throw new Error(t("message.actions.forkMissingWorkspace"));
        }
        const draftId = await prepareForkDraft();
        navigateToWorkspace({
          serverId,
          workspaceId,
          target: buildForkDraftTabTarget(draftSetup, draftId),
        });
        return;
      }

      const draftId = await prepareForkDraft();
      const sourceDirectory =
        agent.projectPlacement?.checkout?.cwd?.trim() || agent.cwd.trim() || undefined;
      if (draftSetup) {
        useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
          draftId,
          setup: draftSetup,
          sourceDirectory,
        });
      }
      router.push(
        buildNewWorkspaceRoute({
          serverId,
          sourceDirectory,
          displayName: agent.projectPlacement?.projectName,
          projectId: agent.projectPlacement?.projectKey,
          draftId,
        }),
      );
    } catch (error) {
      toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    }
  });
}
