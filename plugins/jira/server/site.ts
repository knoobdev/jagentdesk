import type { JiraIssueCard, JiraStatus } from "@jagentdesk/protocol/jira/rpc-schemas";
import { flavorFor, type JiraFlavor } from "./flavor.js";
import type { JiraBytes, JiraHttp, JiraRequest } from "./http.js";
import { arr, num, obj, objs, str, type Json } from "./json.js";
import { cardFields, mapCard, mapStatus, type CardContext, type FieldCatalog } from "./mapping.js";
import type { StoredJiraConnection } from "./storage.js";

// One connection's view of its Jira site: typed request helpers, the field catalog (custom field
// ids differ per site), and issue-list paging over both Cloud token pages and DC offset pages.

const CATALOG_TTL_MS = 10 * 60_000;
const PAGE_SIZE = 100;
// Offset pages (Data Center) after the first are fetched this many at a time.
const PARALLEL_PAGES = 4;
/** Default cap of a list (agent tools, sprint lists); views pass their own `limit`. */
export const MAX_LIST_ISSUES = 500;

interface CachedCatalog {
  catalog: FieldCatalog;
  at: number;
}

/** Caches shared by every JiraSite of a connection (one instance per daemon). */
export class JiraSiteCache {
  readonly catalogs = new Map<string, CachedCatalog>();
  readonly statuses = new Map<string, { statuses: JiraStatus[]; at: number }>();
  // Ids written by JAgentDesk recently: Cloud search is eventually consistent, so reads pass
  // them as `reconcileIssues` (spec 29.3).
  readonly recentWrites = new Map<string, Map<string, number>>();

  forget(connectionId: string): void {
    this.catalogs.delete(connectionId);
    this.statuses.delete(connectionId);
    this.recentWrites.delete(connectionId);
  }
}

const RECONCILE_WINDOW_MS = 60_000;
const RECONCILE_MAX = 50;

export interface IssuePage {
  issues: JiraIssueCard[];
  truncated: boolean;
}

export class JiraSite {
  readonly flavor: JiraFlavor;

  constructor(
    readonly connection: StoredJiraConnection,
    private readonly http: JiraHttp,
    private readonly cache: JiraSiteCache,
    private readonly now: () => number,
  ) {
    this.flavor = flavorFor(connection.deployment);
  }

  get id(): string {
    return this.connection.id;
  }

  get myRef(): string {
    return this.connection.account.ref;
  }

  get<T = Json>(path: string, query?: JiraRequest["query"]): Promise<T> {
    return this.http.json<T>(this.connection, { path, query });
  }

  post<T = Json>(path: string, body?: unknown, query?: JiraRequest["query"]): Promise<T> {
    return this.http.json<T>(this.connection, { method: "POST", path, body, query });
  }

  put<T = Json>(path: string, body?: unknown, query?: JiraRequest["query"]): Promise<T> {
    return this.http.json<T>(this.connection, { method: "PUT", path, body, query });
  }

  delete(path: string, query?: JiraRequest["query"]): Promise<unknown> {
    return this.http.json(this.connection, { method: "DELETE", path, query });
  }

  upload<T = Json>(path: string, form: FormData): Promise<T> {
    return this.http.json<T>(this.connection, { method: "POST", path, form });
  }

  bytes(path: string, maxBytes: number): Promise<JiraBytes> {
    return this.http.bytes(this.connection, { path }, maxBytes);
  }

  api(path: string): string {
    return `${this.flavor.api}${path}`;
  }

  noteWrite(issueId: string): void {
    if (!issueId) return;
    const writes = this.cache.recentWrites.get(this.id) ?? new Map<string, number>();
    writes.set(issueId, this.now());
    this.cache.recentWrites.set(this.id, writes);
  }

  reconcileIds(): string[] {
    const writes = this.cache.recentWrites.get(this.id);
    if (!writes) return [];
    const cutoff = this.now() - RECONCILE_WINDOW_MS;
    for (const [id, at] of writes) if (at < cutoff) writes.delete(id);
    return [...writes.keys()].filter((id) => /^\d+$/.test(id)).slice(-RECONCILE_MAX);
  }

  async catalog(): Promise<FieldCatalog> {
    const cached = this.cache.catalogs.get(this.id);
    if (cached && this.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
    const fields = objs(await this.get<unknown>(this.api("/field")));
    const names = new Map<string, string>();
    let sprintFieldId: string | null = null;
    let epicLinkFieldId: string | null = null;
    let flaggedFieldId: string | null = null;
    let storyPointsFieldId: string | null = null;
    for (const field of fields) {
      const id = str(field.id);
      const name = str(field.name);
      if (!id || !name) continue;
      names.set(id, name);
      const custom = str(obj(field.schema)?.custom);
      if (custom === "com.pyxis.greenhopper.jira:gh-sprint") sprintFieldId = id;
      if (custom === "com.pyxis.greenhopper.jira:gh-epic-link") epicLinkFieldId = id;
      if (name === "Flagged") flaggedFieldId = id;
      const isPoints = name === "Story Points" || name === "Story point estimate";
      if (isPoints && storyPointsFieldId === null) storyPointsFieldId = id;
    }
    const catalog = { names, sprintFieldId, epicLinkFieldId, flaggedFieldId, storyPointsFieldId };
    this.cache.catalogs.set(this.id, { catalog, at: this.now() });
    return catalog;
  }

  async statuses(): Promise<JiraStatus[]> {
    const cached = this.cache.statuses.get(this.id);
    if (cached && this.now() - cached.at < CATALOG_TTL_MS) return cached.statuses;
    const statuses = arr(await this.get<unknown>(this.api("/status"))).map(mapStatus);
    this.cache.statuses.set(this.id, { statuses, at: this.now() });
    return statuses;
  }

  async cardContext(estimationFieldId: string | null): Promise<CardContext> {
    return { flavor: this.flavor, catalog: await this.catalog(), estimationFieldId };
  }

  /**
   * Pages through an issue list endpoint — Cloud `/search/jql` and `/rest/software/1.0` (token
   * pages, sequential) or DC `/search` and `/rest/agile/1.0` (offset pages; once the first page
   * reports `total`, the rest are fetched a few at a time) — up to `limit` issues.
   */
  async issues(input: IssueListInput): Promise<IssuePage> {
    const limit = input.limit ?? MAX_LIST_ISSUES;
    const fields = [...cardFields(input.context), ...(input.extraFields ?? [])].join(",");
    const reconcile = this.flavor.deployment === "cloud" ? this.reconcileIds() : [];
    const cards: JiraIssueCard[] = [];
    const list: IssueLister = {
      limit,
      cards,
      fetch: (cursor, size) =>
        this.get<Json>(input.path, {
          jql: input.jql,
          fields,
          maxResults: size,
          ...("token" in cursor
            ? {
                nextPageToken: cursor.token ?? undefined,
                reconcileIssues: reconcile.length > 0 ? reconcile : undefined,
              }
            : { startAt: cursor.startAt }),
        }),
      take: (page) => {
        const issues = objs(page.issues);
        cards.push(...issues.map((issue) => mapCard(issue, input.context)));
        return issues.length;
      },
    };
    const truncated =
      this.flavor.deployment === "cloud" ? await tokenPages(list) : await offsetPages(list);
    return { issues: cards.slice(0, limit), truncated };
  }
}

interface IssueListInput {
  path: string;
  jql?: string;
  context: CardContext;
  limit?: number;
  extraFields?: string[];
}

interface IssueLister {
  limit: number;
  cards: JiraIssueCard[];
  fetch(cursor: { token: string | null } | { startAt: number }, size: number): Promise<Json>;
  /** Adds a page's issues; returns how many it had. */
  take(page: Json): number;
}

/** Cloud token pages, one after another. Returns whether issues were left at the limit. */
async function tokenPages(list: IssueLister): Promise<boolean> {
  let token: string | null = null;
  for (;;) {
    const page = await list.fetch({ token }, Math.min(PAGE_SIZE, list.limit - list.cards.length));
    const count = list.take(page);
    token = str(page.nextPageToken);
    if (token === null || count === 0) return false;
    if (list.cards.length >= list.limit) return true;
  }
}

/** Data Center offset pages. Returns whether issues were left at the limit. */
async function offsetPages(list: IssueLister): Promise<boolean> {
  const first = await list.fetch({ startAt: 0 }, Math.min(PAGE_SIZE, list.limit));
  const startAt = list.take(first);
  const total = num(first.total);
  if (total !== null && startAt > 0 && !first.isLast) {
    await parallelOffsetPages(list, startAt, Math.min(total, list.limit));
    return total > list.limit;
  }
  // No total (older endpoints): sequential pages until an empty or last page.
  let at = startAt;
  let last = first;
  while (at > 0 && !last.isLast && list.cards.length < list.limit) {
    last = await list.fetch({ startAt: at }, Math.min(PAGE_SIZE, list.limit - list.cards.length));
    const count = list.take(last);
    if (count === 0) break;
    at += count;
  }
  return at > 0 && last.isLast === false && list.cards.length >= list.limit;
}

// Jira may serve fewer issues per page than asked (maxResults is an upper bound), so the page size
// is what the first page held. Pages are kept in order up to the first short one; the ones after
// it are fetched again from there, so nothing is skipped or doubled.
async function parallelOffsetPages(list: IssueLister, from: number, end: number): Promise<void> {
  const pageSize = Math.max(1, from);
  let startAt = from;
  while (startAt < end) {
    const offsets: number[] = [];
    for (let at = startAt; at < end && offsets.length < PARALLEL_PAGES; at += pageSize) {
      offsets.push(at);
    }
    const sizes = offsets.map((at) => Math.min(pageSize, end - at));
    const pages = await Promise.all(
      offsets.map((at, index) => list.fetch({ startAt: at }, sizes[index] ?? pageSize)),
    );
    const before = startAt;
    for (const [index, page] of pages.entries()) {
      const count = list.take(page);
      startAt = (offsets[index] ?? startAt) + count;
      if (count < (sizes[index] ?? 0)) break;
    }
    if (startAt === before) break;
  }
}
