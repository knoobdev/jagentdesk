// A bot's permission card in the user's language (spec 37.3.2-37.3.3): starting a worker names the
// item, the project and its new worktree, and shows the task; reaching another bot names it and
// shows the message. The facts come from the request's `metadata.botCard`; a request without them
// keeps the daemon's own title and description.
import type { AgentPermissionRequest } from "@jagentdesk/protocol/agent-types";
import { readBotPermissionCard } from "@jagentdesk/protocol/bots/permission-cards";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface BotPermissionCardText {
  title: string;
  description: string;
  detail: { type: "plain_text"; label: string; text: string };
}

export function botPermissionCardText(
  request: Pick<AgentPermissionRequest, "metadata">,
  t: Translate,
): BotPermissionCardText | null {
  const card = readBotPermissionCard(request.metadata);
  if (!card) return null;
  if (card.kind === "worker_start") {
    const item =
      card.itemNumber === null ? card.itemTitle : `#${card.itemNumber} ${card.itemTitle}`;
    return {
      title: t("bots.jad.panels.approval.workerStart.title", { item }),
      description: t("bots.jad.panels.approval.workerStart.description", {
        bot: card.botName,
        project: card.projectName,
        path: card.projectPath,
      }),
      detail: {
        type: "plain_text",
        label: t("bots.jad.panels.approval.workerStart.task"),
        text: card.task,
      },
    };
  }
  return {
    title: t(`bots.jad.panels.approval.handoff.title.${card.type}`, { to: card.toBotName }),
    description: t("bots.jad.panels.approval.handoff.description", {
      bot: card.botName,
      to: card.toBotName,
    }),
    detail: {
      type: "plain_text",
      label: t("bots.jad.panels.approval.handoff.message"),
      text: card.text,
    },
  };
}
