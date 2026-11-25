// Jira issue keys typed in a composer (spec 29.4): PROJECT-123, project keys being upper case.

const ISSUE_KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;

export function lastIssueKey(text: string): string | null {
  const matches = [...text.matchAll(ISSUE_KEY)];
  return matches.at(-1)?.[1] ?? null;
}
