import { buildAgentMessageDisplay as buildSenderEnvelopeDisplay } from "../agent-message-display.js";
import type { AgentMessage } from "../agent-message.js";
import type { ToolCallDetail } from "../agent-types.js";
import { toSummaryText } from "./summary-text.js";

export interface AgentMessageDisplay {
  displayName: string;
  summary?: string;
  detail: ToolCallDetail;
}

/** Presentation shared by clients; never used to encode provider prompts. */
export function buildAgentMessageDisplay(message: AgentMessage): AgentMessageDisplay {
  const summary = toSummaryText(message.sender.title ?? message.sender.id);
  return {
    // ADR-0029 §1 / spec 04.15.1 retains sender headings for envelope rows.
    displayName: buildSenderEnvelopeDisplay(message).displayName,
    ...(summary ? { summary } : {}),
    detail: {
      type: "plain_text",
      text: `From agent: ${message.sender.id}\n\n${message.text}`,
    },
  };
}
