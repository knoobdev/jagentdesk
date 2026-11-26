// Jira issue keys and links in a composer (spec 29.4): PROJECT-123, project keys being upper case.

const ISSUE_KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;
const EXACT_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;
// A bare key is not part of a longer token: "UTF-8" inside "x-UTF-8" or a path stays text.
const BARE_KEY = /(?<![\w/.-])#?([A-Z][A-Z0-9_]+-\d+)(?![\w-])/g;

export function lastIssueKey(text: string): string | null {
  const matches = [...text.matchAll(ISSUE_KEY)];
  return matches.at(-1)?.[1] ?? null;
}

/** An issue named in the text: a pasted link carries the site's host, a typed key does not. */
export interface JiraIssueRef {
  key: string;
  host: string | null;
}

/** What a connection can resolve: its site host and its project keys. */
export interface JiraConnectionKeys {
  connectionId: string;
  host: string;
  projectKeys: ReadonlySet<string>;
}

export interface JiraIssueMatch {
  connectionId: string;
  key: string;
}

function keyFromUrl(url: URL): string | null {
  const browse = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)\/?$/);
  if (browse?.[1]) return browse[1];
  for (const name of ["selectedIssue", "issueKey"]) {
    const value = url.searchParams.get(name);
    if (value && EXACT_KEY.test(value)) return value;
  }
  const issues = url.pathname.match(/\/issues\/([A-Z][A-Z0-9_]+-\d+)\/?$/);
  return issues?.[1] ?? null;
}

export function extractJiraIssueRefs(text: string): JiraIssueRef[] {
  const refs: JiraIssueRef[] = [];
  const withoutUrls = text.replace(URL_PATTERN, (raw) => {
    try {
      const url = new URL(raw.replace(/[.,;:!?'"]+$/, ""));
      const key = keyFromUrl(url);
      if (key) refs.push({ key, host: url.host.toLowerCase() });
    } catch {
      // Not a URL after all; it stays text.
    }
    return " ";
  });
  for (const match of withoutUrls.matchAll(BARE_KEY)) {
    if (match[1]) refs.push({ key: match[1], host: null });
  }
  return refs;
}

export function siteHost(siteUrl: string): string | null {
  try {
    return new URL(siteUrl).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refs that belong to a connection, deduplicated by key. A link must point at the connection's
 * site; a typed key must start with one of its project keys. Anything else stays plain text.
 */
export function matchJiraIssueRefs(
  refs: readonly JiraIssueRef[],
  connections: readonly JiraConnectionKeys[],
): JiraIssueMatch[] {
  const matches = new Map<string, JiraIssueMatch>();
  for (const ref of refs) {
    if (matches.has(ref.key)) continue;
    const project = ref.key.slice(0, ref.key.lastIndexOf("-"));
    const connection = connections.find((candidate) =>
      ref.host ? candidate.host === ref.host : candidate.projectKeys.has(project),
    );
    if (connection) matches.set(ref.key, { connectionId: connection.connectionId, key: ref.key });
  }
  return [...matches.values()];
}
