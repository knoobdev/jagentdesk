// What "Ask AI" knows about where it was opened (spec 29.4): the Jira connection, and the
// project / board / issue on screen. Baked into the assistant's system prompt and its labels.

export const JIRA_ASSISTANT_LABEL = "jagentdesk.jira.assistant";
export const JIRA_ASSISTANT_SCOPE_LABEL = "jagentdesk.jira.assistant.scope";

export interface JiraAssistantContext {
  connectionId: string;
  siteLabel: string;
  projectKey: string | null;
  boardId: number | null;
  issueKey: string | null;
}

export function jiraAssistantScope(context: JiraAssistantContext): string {
  const focus =
    context.issueKey ??
    context.projectKey ??
    (context.boardId !== null ? `board-${context.boardId}` : "all");
  return `${context.connectionId}/${focus}`;
}

export function jiraAssistantTitle(context: JiraAssistantContext, text: string): string {
  const scope = context.issueKey ?? context.projectKey ?? "Jira";
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return `${scope} · assistant`;
  return `${scope} · ${trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed}`;
}

export function buildJiraAssistantSystemPrompt(context: JiraAssistantContext): string {
  const lines = [
    "You are the Jira assistant inside JAgentDesk.",
    `Use the jira_* tools with connectionId "${context.connectionId}" (${context.siteLabel}). Read tools (jira_search, jira_get_issue, jira_get_comments, jira_get_transitions, jira_get_board, jira_get_backlog, jira_list_sprints, …) run directly; write tools (jira_create_issue, jira_update_issue, jira_transition_issue, jira_assign_issue, jira_add_comment, jira_add_worklog, jira_link_issues, jira_add_remote_link, jira_move_to_sprint, …) ask the user to approve, so say what you are about to change before calling one.`,
    "Write descriptions and comments in Markdown; mention people as [@Name](jira-mention:<ref>) using refs from jira_find_users.",
    "For code work, use git in the workspace and the forge_* tools to open pull requests, then link them to the issue with jira_add_remote_link.",
  ];
  if (context.projectKey) lines.push(`The project on screen is ${context.projectKey}.`);
  if (context.boardId !== null) lines.push(`The board on screen is board ${context.boardId}.`);
  if (context.issueKey) {
    lines.push(
      `The issue on screen is ${context.issueKey}; start with jira_get_issue on it when the question is about it.`,
    );
  }
  return lines.join("\n");
}
