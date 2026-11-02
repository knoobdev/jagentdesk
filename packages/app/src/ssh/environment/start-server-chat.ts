import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@jagentdesk/protocol/agent-title-limits";
import {
  SSH_SERVER_AGENT_LABEL,
  buildServerChatSystemPrompt,
  type ServerChatContext,
} from "@jagentdesk/protocol/ssh/server-chat-prompt";
import { createDockWorkspace } from "@/components/dock-workspace";

const MAX_MESSAGE_PART_CHARS = 60;

export interface StartServerChatInput {
  client: DaemonClient;
  /** The JAgentDesk host (daemon) the chat runs on. */
  hostId: string;
  /** Server, environment, open tabs and forwards the agent is told about (no secrets). */
  context: ServerChatContext;
  provider: string;
  /** Project directory the chat's workspace is created in (dock chats live in a project). */
  cwd: string;
  /** First message typed by the user; empty opens a chat waiting for the question. */
  message: string;
}

export interface StartedServerChat {
  agentId: string;
  workspaceId: string;
}

/** "<server>: <first line of the question>", or no explicit title when there is no question. */
export function serverChatTitle(serverLabel: string, message: string): string | null {
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  const title = `${serverLabel.trim()}: ${firstLine.slice(0, MAX_MESSAGE_PART_CHARS).trim()}`;
  return title.slice(0, MAX_EXPLICIT_AGENT_TITLE_CHARS);
}

/**
 * "Chat about this server" (spec 25.11): a new agent in its own project workspace, labelled with
 * the server id so the daemon defaults every `ssh_*`/`docker_*` call to it, and grounded by a
 * hidden system prompt describing the server. Throws when the workspace or agent cannot be made.
 */
export async function startServerChat(input: StartServerChatInput): Promise<StartedServerChat> {
  const { client, hostId, context, provider, cwd } = input;
  const message = input.message.trim();
  const title = serverChatTitle(context.server.label, message);
  const home = await createDockWorkspace({
    client,
    serverId: hostId,
    cwd,
    ...(title ? { title } : {}),
  });
  const agent = await client.createAgent({
    provider,
    cwd: home.cwd,
    workspaceId: home.workspaceId,
    systemPrompt: buildServerChatSystemPrompt(context),
    labels: { [SSH_SERVER_AGENT_LABEL]: context.server.id },
    ...(title ? { title } : {}),
    ...(message ? { initialPrompt: message } : {}),
  });
  return { agentId: agent.id, workspaceId: home.workspaceId };
}
