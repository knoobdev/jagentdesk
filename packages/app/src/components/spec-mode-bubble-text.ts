import { specModeApprovalLine, type SpecModeMessage } from "@jagentdesk/protocol/spec-mode";

/** What the bubble says for a Spec mode phase message: the user's words, or the Approve line. */
export function specModeBubbleText(parsed: SpecModeMessage): string {
  if (parsed.userText === null) return "";
  return parsed.userText || specModeApprovalLine(parsed.phase);
}
