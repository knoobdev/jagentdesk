import { Buffer } from "buffer";
import type { JiraIssueDetail } from "@jagentdesk/protocol/jira/rpc-schemas";
import { jiraIssueMarkdown } from "@jagentdesk/protocol/jira/issue-markdown";
import type { AgentAttachment } from "@jagentdesk/protocol/messages";
import type { JiraCall } from "../api";

// The `jira_issue` prompt attachment (spec 29.4): the issue as Markdown, with its latest comments
// and the text of small text attachments, built from the daemon's DTOs (never raw ADF).

export type JiraIssueAttachment = Extract<AgentAttachment, { type: "jira_issue" }>;

const TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;
const TEXT_ATTACHMENT_MAX_COUNT = 3;

function isText(mimeType: string): boolean {
  return /^text\/|json|xml|yaml|csv/.test(mimeType);
}

export async function issueMarkdownWithContext(
  call: JiraCall,
  connectionId: string,
  issue: JiraIssueDetail,
): Promise<string> {
  const comments = await call("jira.issue.comments.list.request", {
    connectionId,
    issueKey: issue.key,
  });
  const candidates = issue.attachments
    .filter(
      (attachment) => isText(attachment.mimeType) && attachment.size <= TEXT_ATTACHMENT_MAX_BYTES,
    )
    .slice(0, TEXT_ATTACHMENT_MAX_COUNT);
  const textAttachments = await Promise.all(
    candidates.map(async (attachment) => {
      const file = await call("jira.issue.attachments.download.request", {
        connectionId,
        attachmentId: attachment.id,
        variant: "content",
      });
      return {
        filename: file.fileName,
        text: Buffer.from(file.dataBase64, "base64").toString("utf8"),
      };
    }),
  );
  return jiraIssueMarkdown(issue, { comments: comments.comments.slice(0, 5), textAttachments });
}

export async function buildJiraIssueAttachment(
  call: JiraCall,
  connectionId: string,
  issueKey: string,
): Promise<JiraIssueAttachment> {
  const { issue } = await call("jira.issue.get.request", { connectionId, issueKey });
  if (!issue) throw new Error(`${issueKey} is unavailable.`);
  return {
    type: "jira_issue",
    mimeType: "application/jagentdesk-jira-issue",
    connectionId,
    key: issue.key,
    summary: issue.summary,
    url: issue.webUrl,
    body: await issueMarkdownWithContext(call, connectionId, issue),
  };
}
