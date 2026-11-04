import type { JiraDeployment, JiraRichText } from "@jagentdesk/protocol/jira/rpc-schemas";
import { adfToRichText, markdownToAdf } from "./adf.js";
import { str, type Json } from "./json.js";
import { markdownToWiki, wikiToRichText } from "./wiki.js";

// The four places where Jira Cloud and Data Center differ for the same operation (reference §3):
// API version, rich text format, user identity, and the issue-list endpoints (Cloud's
// token-paginated `/rest/software/1.0` and `/search/jql`, DC's offset-paginated agile + search).

export interface JiraFlavor {
  deployment: JiraDeployment;
  /** Platform REST prefix. */
  api: "/rest/api/3" | "/rest/api/2";
  /** Prefix for board/sprint/backlog issue lists. */
  boardIssues: "/rest/software/1.0" | "/rest/agile/1.0";
  /** JQL search endpoint. */
  search: "/rest/api/3/search/jql" | "/rest/api/2/search";
  /** Data Center has no quick filter endpoint (DC-AGILE 9.12). */
  hasQuickFilters: boolean;
  readText(value: unknown): JiraRichText;
  writeText(markdown: string): unknown;
  userRef(user: Json): string | null;
  /** Body identifying a user: `{ accountId }` on Cloud, `{ name }` on DC. */
  userBody(ref: string | null): Json;
  /** Query parameter naming a user. */
  userParam: "accountId" | "username";
  /** Free-text user search parameter. */
  userSearchParam: "query" | "username";
}

export const CLOUD: JiraFlavor = {
  deployment: "cloud",
  api: "/rest/api/3",
  boardIssues: "/rest/software/1.0",
  search: "/rest/api/3/search/jql",
  hasQuickFilters: true,
  readText: adfToRichText,
  writeText: markdownToAdf,
  userRef: (user) => str(user.accountId),
  userBody: (ref) => ({ accountId: ref }),
  userParam: "accountId",
  userSearchParam: "query",
};

export const DATA_CENTER: JiraFlavor = {
  deployment: "datacenter",
  api: "/rest/api/2",
  boardIssues: "/rest/agile/1.0",
  search: "/rest/api/2/search",
  hasQuickFilters: false,
  readText: wikiToRichText,
  writeText: markdownToWiki,
  userRef: (user) => str(user.name) ?? str(user.key),
  userBody: (ref) => ({ name: ref }),
  userParam: "username",
  userSearchParam: "username",
};

export function flavorFor(deployment: JiraDeployment): JiraFlavor {
  return deployment === "cloud" ? CLOUD : DATA_CENTER;
}
