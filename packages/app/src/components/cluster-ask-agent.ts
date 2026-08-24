import { Alert } from "react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export interface AskAgentAboutResourceInput {
  client: DaemonClient;
  serverId: string;
  clusterId: string;
  kind: string;
  namespace?: string;
  name?: string;
  yaml?: string;
  provider: string;
  cwd: string;
}

export async function askAgentAboutResource(input: AskAgentAboutResourceInput): Promise<void> {
  const { client, serverId, clusterId, kind, namespace, name, yaml, provider, cwd } = input;

  const hasName = Boolean(name);

  let prompt: string;
  if (hasName) {
    const nsPart = namespace ? ` in namespace "${namespace}"` : "";
    prompt = [
      `You are operating Kubernetes cluster "${clusterId}".`,
      `Diagnose ${kind} "${name}"${nsPart}.`,
      `Use kubectl_get (action get/describe/logs/list) and kubectl_apply with clusterId="${clusterId}".`,
      "Inspect the resource, recent events and logs, then report the likely cause and a safe fix.",
    ].join("\n");
  } else {
    prompt = [
      `You are operating Kubernetes cluster "${clusterId}".`,
      `Help manage cluster "${clusterId}".`,
      `Use kubectl_get (action get/describe/logs/list) and kubectl_apply with clusterId="${clusterId}".`,
      "Inspect the resource, recent events and logs, then report the likely cause and a safe fix.",
    ].join("\n");
  }

  try {
    const agent = await client.createAgent({
      provider,
      cwd,
      initialPrompt: prompt,
      labels: { "jagentdesk.cluster.id": clusterId },
      ...(yaml && hasName
        ? {
            attachments: [
              {
                type: "text" as const,
                mimeType: "text/plain" as const,
                title: `${kind}/${name}.yaml`,
                text: yaml,
              },
            ],
          }
        : {}),
    });

    navigateToAgent({ serverId, agentId: agent.id });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create agent";
    Alert.alert("Agent Error", message);
  }
}
