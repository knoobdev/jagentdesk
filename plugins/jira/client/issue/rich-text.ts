import { JIRA_ATTACHMENT_SCHEME } from "@jagentdesk/protocol/jira/rpc-schemas";

// Pure helpers of Jira rich text in the app (see jira-markdown.tsx).

/** `jira-attachment:<id>` → the attachment id, or null for any other URL. */
export function attachmentIdOf(url: string): string | null {
  if (!url.startsWith(JIRA_ATTACHMENT_SCHEME)) return null;
  try {
    const id = decodeURIComponent(url.slice(JIRA_ATTACHMENT_SCHEME.length));
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
