import type { JiraComment, JiraFieldValue, JiraIssueCard, JiraIssueDetail } from "./rpc-schemas.js";

// Jira issues as compact Markdown for agents (spec 29.4: tool results are Markdown, never raw ADF)
// and for the `jira_issue` prompt attachment / "Work on this issue" prompt. Shared by the daemon
// (agent tools) and the app (attachments) so both describe an issue the same way.

export function jiraCardLine(card: JiraIssueCard): string {
  const parts = [
    card.status.name,
    card.assignee ? card.assignee.displayName : "Unassigned",
    card.priority?.name ?? null,
    card.estimate !== null ? `${card.estimate} pts` : null,
  ].filter((part): part is string => part !== null);
  return `- ${card.key} [${card.type.name}] ${card.summary} — ${parts.join(" · ")}`;
}

function fieldText(value: JiraFieldValue): string | null {
  switch (value.kind) {
    case "text":
      return value.text;
    case "number":
      return value.number === null ? null : String(value.number);
    case "date":
      return value.date;
    case "user":
      return value.user ? `${value.user.displayName} (${value.user.ref})` : null;
    case "labels":
      return value.labels.length > 0 ? value.labels.join(", ") : null;
    case "option":
      return value.option?.name ?? null;
    case "options":
      return value.options.length > 0 ? value.options.map((o) => o.name).join(", ") : null;
  }
}

export interface JiraIssueMarkdownOptions {
  comments?: JiraComment[];
  textAttachments?: Array<{ filename: string; text: string }>;
}

function headerLines(issue: JiraIssueDetail): string[] {
  const lines: string[] = [
    `# ${issue.key}: ${issue.summary}`,
    "",
    `- Type: ${issue.type.name}`,
    `- Status: ${issue.status.name}`,
    `- Assignee: ${issue.assignee ? `${issue.assignee.displayName} (${issue.assignee.ref})` : "Unassigned"}`,
    `- Reporter: ${issue.reporter?.displayName ?? "—"}`,
  ];
  if (issue.priority) lines.push(`- Priority: ${issue.priority.name}`);
  if (issue.parent) lines.push(`- Parent: ${issue.parent.key} ${issue.parent.summary}`);
  if (issue.labels.length > 0) lines.push(`- Labels: ${issue.labels.join(", ")}`);
  for (const field of issue.fields) {
    if (["assignee", "reporter", "labels", "priority"].includes(field.fieldId)) continue;
    const text = fieldText(field.value);
    if (text) lines.push(`- ${field.name}: ${text}`);
  }
  return lines;
}

export function jiraIssueMarkdown(
  issue: JiraIssueDetail,
  options: JiraIssueMarkdownOptions = {},
): string {
  const lines = headerLines(issue);
  lines.push(`- URL: ${issue.webUrl}`, "", "## Description", "");
  lines.push(issue.description.markdown.trim() || "(empty)");
  if (!issue.description.editable) {
    lines.push(
      "",
      `_Contains content shown approximately: ${issue.description.unsupported.join(", ")}._`,
    );
  }
  if (issue.subtasks.length > 0) {
    lines.push("", "## Subtasks", "", ...issue.subtasks.map(jiraCardLine));
  }
  if (issue.links.length > 0) {
    lines.push(
      "",
      "## Linked issues",
      "",
      ...issue.links.map(
        (link) =>
          `- ${link.relation} ${link.issue.key} ${link.issue.summary} (${link.issue.status.name})`,
      ),
    );
  }
  if (issue.remoteLinks.length > 0) {
    lines.push("", "## Web links", "", ...issue.remoteLinks.map((l) => `- [${l.title}](${l.url})`));
  }
  if (issue.attachments.length > 0) {
    lines.push(
      "",
      "## Attachments",
      "",
      ...issue.attachments.map(
        (a) => `- ${a.filename} (${a.mimeType}, ${a.size} bytes, id ${a.id})`,
      ),
    );
  }
  for (const attachment of options.textAttachments ?? []) {
    lines.push("", `## Attachment ${attachment.filename}`, "", "```", attachment.text, "```");
  }
  if (options.comments && options.comments.length > 0) {
    lines.push("", "## Recent comments", "");
    for (const comment of options.comments) {
      const at = new Date(comment.created_ms).toISOString().slice(0, 16).replace("T", " ");
      lines.push(
        `**${comment.author?.displayName ?? "Unknown"}** · ${at} UTC`,
        "",
        comment.body.markdown,
        "",
      );
    }
  }
  return lines.join("\n").trimEnd();
}

/** The visible prompt "Work on this issue" sends to a new agent (spec 29.4). */
export function jiraWorkOnIssuePrompt(input: {
  connectionId: string;
  issueKey: string;
  issueMarkdown: string;
}): string {
  return [
    `Work on Jira issue ${input.issueKey} (Jira connection ${input.connectionId}).`,
    "",
    "1. Read the issue below; use jira_get_issue / jira_get_comments for more context.",
    `2. Create a git branch whose name contains ${input.issueKey}, implement the change, commit and push.`,
    `3. Open a pull request with forge_create_change_request, with ${input.issueKey} in the title.`,
    `4. Add the pull request to the issue with jira_add_remote_link and a short summary with the link via jira_add_comment; move the issue with jira_transition_issue when it fits the team's workflow.`,
    "",
    input.issueMarkdown,
  ].join("\n");
}
