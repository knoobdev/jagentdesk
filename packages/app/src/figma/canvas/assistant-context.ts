// What "Ask AI" knows about where it was opened on the Figma canvas: the host connection, the
// file, and the page/node on screen. Baked into the assistant's system prompt and its labels,
// the same shape as the Jira assistant (spec 29.4 pattern, reused for 32.5).

export const FIGMA_ASSISTANT_LABEL = "jagentdesk.figma.assistant";
export const FIGMA_ASSISTANT_SCOPE_LABEL = "jagentdesk.figma.assistant.scope";

export interface FigmaAssistantContext {
  serverId: string;
  fileKey: string;
  fileName: string | null;
  pageId: string | null;
  nodeId: string | null;
}

export function figmaAssistantScope(context: FigmaAssistantContext): string {
  const focus = context.nodeId ?? context.pageId ?? "file";
  return `${context.serverId}/${context.fileKey}/${focus}`;
}

export function figmaAssistantTitle(context: FigmaAssistantContext, text: string): string {
  const scope = context.fileName ?? context.fileKey;
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return `${scope} · assistant`;
  return `${scope} · ${trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed}`;
}

export function buildFigmaAssistantSystemPrompt(context: FigmaAssistantContext): string {
  const lines = [
    "You are the Figma assistant inside JAgentDesk.",
    `Use the figma_* tools against fileKey "${context.fileKey}" on the connected host. Read tools (figma_get_file, figma_get_nodes, figma_get_comments, figma_list_versions, …) run directly; write tools (figma_apply_ops, figma_post_comment, …) ask the user to approve, so say what you are about to change before calling one.`,
    "Edits on an unlinked file queue as pending ops; mention the queue size when you apply changes so the user knows they land when Figma opens.",
    "When describing layers, name them and their node ids; sizes are in Figma pixels.",
  ];
  if (context.fileName) lines.push(`The file on screen is ${context.fileName}.`);
  if (context.pageId) lines.push(`The page on screen is ${context.pageId}.`);
  if (context.nodeId) {
    lines.push(
      `The selected node is ${context.nodeId}; start with figma_get_nodes on it when the question is about it.`,
    );
  }
  return lines.join("\n");
}
