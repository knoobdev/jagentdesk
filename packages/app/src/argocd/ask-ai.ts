import { useCallback } from "react";
import {
  ARGOCD_INSTANCE_AGENT_LABEL,
  buildArgoCdChatSystemPrompt,
} from "@jagentdesk/protocol/argocd/chat-prompt";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { createDockWorkspace } from "@/components/dock-workspace";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

// "Ask AI" on an instance, an app or a resource node (spec 30.4): a chat agent bound to the
// instance by label, with the instance, app, resource and linked cluster in a hidden system
// prompt. It runs in a fresh workspace of the host's first project, like a cluster chat.

export interface ArgoCdAskAiContext {
  instanceId: string;
  app: { name: string; appNamespace: string | null; project: string } | null;
  resource: { kind: string; namespace: string; name: string } | null;
}

/** The project directory the chat runs in: the host's first project, as cluster chats default to. */
function firstProjectRoot(serverId: string): string | null {
  const projects = useSessionStore.getState().sessions[serverId]?.projects;
  for (const project of projects?.values() ?? []) {
    if (project.projectRootPath) return project.projectRootPath;
  }
  return null;
}

async function resolveLinkedClusterId(
  client: DaemonClient,
  context: ArgoCdAskAiContext,
): Promise<string | null> {
  if (!context.app) return null;
  const payload = await client.argocd("argocd.cluster_links.resolve.request", {
    instanceId: context.instanceId,
    app: { name: context.app.name, appNamespace: context.app.appNamespace },
  });
  return payload.link?.clusterId ?? null;
}

function chatTitle(displayName: string, context: ArgoCdAskAiContext): string {
  if (context.resource) return `Argo CD: ${context.resource.kind} ${context.resource.name}`;
  if (context.app) return `Argo CD: ${context.app.name}`;
  return `Argo CD: ${displayName}`;
}

async function createArgoCdChat(input: {
  client: DaemonClient;
  serverId: string;
  provider: string;
  context: ArgoCdAskAiContext;
}): Promise<string> {
  const { client, serverId, provider, context } = input;
  const cwd = firstProjectRoot(serverId);
  if (!cwd) throw new Error("Add a project to this host first — the chat runs in it.");

  const instances = await client.argocd("argocd.instances.list.request", {});
  if (instances.error) throw new Error(instances.error);
  const instance = instances.instances.find((entry) => entry.id === context.instanceId);
  if (!instance) throw new Error("This Argo CD instance no longer exists.");

  const clusterId = await resolveLinkedClusterId(client, context);
  const systemPrompt = buildArgoCdChatSystemPrompt({
    instanceId: instance.id,
    displayName: instance.displayName,
    url: instance.url,
    app: context.app,
    resource: context.resource,
    clusterId,
  });
  const title = chatTitle(instance.displayName, context);
  const home = await createDockWorkspace({ client, serverId, cwd, title });
  const agent = await client.createAgent({
    provider,
    cwd: home.cwd,
    workspaceId: home.workspaceId,
    systemPrompt,
    labels: { [ARGOCD_INSTANCE_AGENT_LABEL]: instance.id },
    title,
  });
  return agent.id;
}

export function useArgoCdAskAi(serverId: string): (context: ArgoCdAskAiContext) => void {
  const client = useHostRuntimeClient(serverId);
  const { entries } = useProvidersSnapshot(serverId);
  const provider = entries?.find((entry) => entry.enabled)?.provider ?? null;
  const toast = useToast();

  return useCallback(
    (context: ArgoCdAskAiContext) => {
      if (!client) {
        toast.error("The host is not connected.");
        return;
      }
      if (!provider) {
        toast.error("Enable an AI provider in Host settings to start a chat.");
        return;
      }
      toast.show("Opening Argo CD chat...");
      createArgoCdChat({ client, serverId, provider, context })
        .then((agentId) => {
          navigateToAgent({ serverId, agentId });
          return undefined;
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Unable to open the chat");
        });
    },
    [client, provider, serverId, toast],
  );
}
