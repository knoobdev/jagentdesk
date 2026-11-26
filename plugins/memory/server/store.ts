import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  MemoryCitation,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  MemoryUse,
  MemoryUseKind,
  ScoredMemory,
} from "../shared/types.js";
import { isGraduationReady, MEMORY_TEXT_MAX_CHARS } from "../shared/types.js";
import { extractQueryTerms, type QueryTerm } from "./query-terms.js";
import { findSecret } from "./secrets.js";

export class MemoryInputError extends Error {
  constructor(
    message: string,
    readonly code:
      | "empty"
      | "too_long"
      | "secret"
      | "not_found"
      | "no_project"
      | "disabled"
      | "citation"
      | "conflict",
  ) {
    super(message);
    this.name = "MemoryInputError";
  }
}

const MAX_TAGS = 10;
const MAX_TAG_CHARS = 40;
/** Search tool ceiling (spec 41 §3.2). */
export const MAX_SEARCH_LIMIT = 10;

interface MemoryRow {
  rowid: number;
  id: string;
  scope: MemoryScope;
  project_id: string | null;
  text: string;
  tags: string;
  pinned: number;
  source: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  kind: MemoryKind;
  status: MemoryStatus;
  citations: string;
  helpful: number;
  harmful: number;
  status_reason: string | null;
  last_validated_at: number | null;
  kept_at: number | null;
  graduated_path: string | null;
  agent_count?: number;
}

/** Spec 42 columns, added to databases created before them. */
const LESSON_COLUMNS: ReadonlyArray<[string, string]> = [
  ["kind", "TEXT NOT NULL DEFAULT 'memory'"],
  ["status", "TEXT NOT NULL DEFAULT 'active'"],
  ["citations", "TEXT NOT NULL DEFAULT '[]'"],
  ["helpful", "INTEGER NOT NULL DEFAULT 0"],
  ["harmful", "INTEGER NOT NULL DEFAULT 0"],
  ["status_reason", "TEXT"],
  ["last_validated_at", "INTEGER"],
  // When the lesson was last approved, created or rated helpful: the 28-day expiry counts from it.
  ["kept_at", "INTEGER"],
  ["graduated_path", "TEXT"],
];

const ROW_SELECT = `SELECT m.rowid, m.*,
  (SELECT count(DISTINCT u.agent_id) FROM memory_uses u WHERE u.memory_id = m.id) AS agent_count
  FROM memories m`;

export interface AddMemoryInput {
  scope: MemoryScope;
  projectId: string | null;
  text: string;
  tags?: readonly string[];
  pinned?: boolean;
  source: MemorySource;
  kind?: MemoryKind;
  /** Already normalized; required (non-empty) for a lesson. */
  citations?: readonly MemoryCitation[];
  /** "pending" for lessons from Capture lessons; "active" otherwise. */
  status?: "active" | "pending";
}

export interface UpdateMemoryInput {
  text?: string;
  tags?: readonly string[];
  pinned?: boolean;
  kind?: MemoryKind;
  citations?: readonly MemoryCitation[];
}

export interface ListMemoriesFilter {
  kind?: MemoryKind;
  status?: MemoryStatus;
  scope?: MemoryScope;
  /** Project memories of this project; with no scope, also every global memory. */
  projectId?: string | null;
  tag?: string;
  /** Substring filter for the Memory page's search box. */
  contains?: string;
  createdByAgentId?: string;
}

export interface SearchMemoriesInput {
  query: string;
  /** The caller's project; null searches global memories only. */
  projectId: string | null;
  scope?: MemoryScope;
  limit?: number;
}

/**
 * The FTS5 candidates for one query, scored as BM25 with k1 = 0 (binary term frequency, so no
 * length normalization) using the Lucene IDF `ln(1 + (N - n + 0.5) / (n + 0.5))`.
 *
 * FTS5's own `bm25()` clamps a term found in more than half of the rows to a near-zero IDF, so
 * with the handful of memories a project holds its scores cannot carry a threshold. It still
 * breaks ties, so a memory where the terms are dense ranks first.
 */
interface Candidate {
  row: MemoryRow;
  score: number;
  matched: number;
  identifierMatched: boolean;
  ftsRank: number;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanTags(tags: readonly string[] | undefined): string[] {
  const result: string[] = [];
  for (const tag of tags ?? []) {
    const value = tag.trim().toLowerCase().slice(0, MAX_TAG_CHARS);
    if (value && !result.includes(value)) result.push(value);
    if (result.length >= MAX_TAGS) break;
  }
  return result;
}

export function validateMemoryText(text: string): string {
  const value = text.trim();
  if (!value) throw new MemoryInputError("Memory text is empty.", "empty");
  if (value.length > MEMORY_TEXT_MAX_CHARS)
    throw new MemoryInputError(
      `Memory text is ${value.length} characters; the limit is ${MEMORY_TEXT_MAX_CHARS}.`,
      "too_long",
    );
  const secret = findSecret(value);
  if (secret)
    throw new MemoryInputError(
      `Not saved: the text looks like it contains a secret (${secret}). Never store tokens, passwords or keys in memory.`,
      "secret",
    );
  return value;
}

function generateMemoryId(): string {
  return `mem_${randomBytes(9).toString("base64url")}`;
}

/** Rough token count for the prompt budget: four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MemoryStore {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly db: Database.Database,
    options: { now?: () => number; newId?: () => string } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? generateMemoryId;
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL CHECK (scope IN ('project', 'global')),
        project_id TEXT,
        text TEXT NOT NULL,
        norm TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memories_dedup
        ON memories (scope, ifnull(project_id, ''), norm);
      CREATE INDEX IF NOT EXISTS memories_project ON memories (project_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, tags, content='memories', content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, text, tags)
          VALUES ('delete', old.rowid, old.text, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text, tags ON memories BEGIN
        INSERT INTO memories_fts (memories_fts, rowid, text, tags)
          VALUES ('delete', old.rowid, old.text, old.tags);
        INSERT INTO memories_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
      END;
      CREATE TABLE IF NOT EXISTS memory_uses (
        agent_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        score REAL,
        at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, turn_key, memory_id, kind)
      );
      CREATE INDEX IF NOT EXISTS memory_uses_memory ON memory_uses (memory_id);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const existing = new Set(
      db
        .prepare<[], { name: string }>("PRAGMA table_info(memories)")
        .all()
        .map((column) => column.name),
    );
    for (const [name, definition] of LESSON_COLUMNS) {
      if (!existing.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
  }

  add(input: AddMemoryInput): { memory: MemoryRecord; deduplicated: boolean } {
    const text = validateMemoryText(input.text);
    if (input.scope === "project" && !input.projectId)
      throw new MemoryInputError(
        "This agent is not in a project, so a project memory has nowhere to go. Use scope global.",
        "no_project",
      );
    const projectId = input.scope === "project" ? input.projectId : null;
    const norm = normalizeText(text);
    const now = this.now();
    const kind = input.kind ?? "memory";
    const citations = input.citations ?? [];
    if (kind === "lesson" && citations.length === 0)
      throw new MemoryInputError(
        "A lesson needs at least one citation: the file (and if you can, an exact excerpt) that shows it is true.",
        "citation",
      );
    const existing = this.db
      .prepare<[string, string, string], MemoryRow>(
        "SELECT rowid, * FROM memories WHERE scope = ? AND ifnull(project_id, '') = ? AND norm = ?",
      )
      .get(input.scope, projectId ?? "", norm);
    if (existing) {
      this.mergeInto(existing, { ...input, text, kind, citations });
      return { memory: this.require(existing.id), deduplicated: true };
    }
    const id = this.newId();
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, project_id, text, norm, tags, pinned, source, created_at, updated_at,
           kind, status, citations, kept_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.scope,
        projectId,
        text,
        norm,
        JSON.stringify(cleanTags(input.tags)),
        input.pinned ? 1 : 0,
        JSON.stringify(input.source),
        now,
        now,
        kind,
        input.status ?? "active",
        JSON.stringify(citations),
        now,
      );
    return { memory: this.require(id), deduplicated: false };
  }

  /**
   * Delta update (spec 42 §4): the matching entry is updated in place, nothing else is touched.
   * A captured (pending) copy never demotes an entry the user already approved; saving a stale
   * entry again brings it back (its citations are checked again before injection).
   */
  private mergeInto(
    existing: MemoryRow,
    input: {
      text: string;
      tags?: readonly string[];
      kind: MemoryKind;
      citations: readonly MemoryCitation[];
      status?: "active" | "pending";
    },
  ): void {
    const now = this.now();
    const tags = cleanTags([...JSON.parse(existing.tags), ...(input.tags ?? [])]);
    const mergedCitations = mergeCitations(JSON.parse(existing.citations), input.citations);
    const nextKind: MemoryKind =
      existing.kind === "lesson" || input.kind === "lesson" ? "lesson" : "memory";
    let nextStatus: MemoryStatus = existing.status;
    if (existing.status === "pending") nextStatus = input.status ?? "active";
    else if (existing.status === "stale" && input.status !== "pending") nextStatus = "active";
    const revived = nextStatus === "active" && existing.status !== "active";
    this.db
      .prepare(
        `UPDATE memories SET text = ?, tags = ?, kind = ?, citations = ?, status = ?, updated_at = ?,
           status_reason = CASE WHEN ? THEN NULL ELSE status_reason END,
           kept_at = CASE WHEN ? THEN ? ELSE kept_at END
         WHERE id = ?`,
      )
      .run(
        input.text,
        JSON.stringify(tags),
        nextKind,
        JSON.stringify(mergedCitations),
        nextStatus,
        now,
        revived ? 1 : 0,
        revived ? 1 : 0,
        now,
        existing.id,
      );
  }

  update(id: string, patch: UpdateMemoryInput): MemoryRecord {
    const row = this.row(id);
    if (!row) throw new MemoryInputError("Memory not found.", "not_found");
    const text = patch.text === undefined ? row.text : validateMemoryText(patch.text);
    const tags = patch.tags === undefined ? JSON.parse(row.tags) : cleanTags(patch.tags);
    const kind = patch.kind ?? row.kind;
    const citations = patch.citations ?? (JSON.parse(row.citations) as MemoryCitation[]);
    if (kind === "lesson" && citations.length === 0)
      throw new MemoryInputError("A lesson needs at least one citation.", "citation");
    let pinned = row.pinned;
    if (patch.pinned !== undefined) pinned = patch.pinned ? 1 : 0;
    const norm = normalizeText(text);
    const duplicate = this.db
      .prepare<[string, string, string, string], { id: string }>(
        "SELECT id FROM memories WHERE scope = ? AND ifnull(project_id, '') = ? AND norm = ? AND id != ?",
      )
      .get(row.scope, row.project_id ?? "", norm, id);
    const run = this.db.transaction(() => {
      // Editing a memory into the text of another one in the same scope merges the two.
      if (duplicate) this.db.prepare("DELETE FROM memories WHERE id = ?").run(duplicate.id);
      this.db
        .prepare(
          "UPDATE memories SET text = ?, norm = ?, tags = ?, pinned = ?, kind = ?, citations = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          text,
          norm,
          JSON.stringify(tags),
          pinned,
          kind,
          JSON.stringify(citations),
          this.now(),
          id,
        );
    });
    run();
    return this.require(id);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  get(id: string): MemoryRecord | null {
    const row = this.row(id);
    return row ? toRecord(row) : null;
  }

  list(filter: ListMemoriesFilter = {}): MemoryRecord[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.scope === "global") where.push("m.scope = 'global'");
    else if (filter.scope === "project") {
      where.push("scope = 'project' AND project_id = ?");
      params.push(filter.projectId ?? "");
    } else if (filter.projectId !== undefined) {
      where.push("(scope = 'global' OR (scope = 'project' AND project_id = ?))");
      params.push(filter.projectId ?? "");
    }
    if (filter.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(m.tags) WHERE value = ?)");
      params.push(filter.tag.trim().toLowerCase());
    }
    if (filter.contains?.trim()) {
      where.push("(instr(lower(text), ?) > 0 OR instr(lower(tags), ?) > 0)");
      const needle = filter.contains.trim().toLowerCase();
      params.push(needle, needle);
    }
    if (filter.createdByAgentId) {
      where.push("json_extract(source, '$.agentId') = ?");
      params.push(filter.createdByAgentId);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const sql = `${ROW_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY pinned DESC, updated_at DESC`;
    return this.db
      .prepare<(string | number)[], MemoryRow>(sql)
      .all(...params)
      .map(toRecord);
  }

  /** Ranked matches for the search tool: every memory that matches at least one term. */
  search(input: SearchMemoriesInput): ScoredMemory[] {
    const limit = Math.max(1, Math.min(input.limit ?? MAX_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
    return this.candidates(input.query, input.projectId, input.scope)
      .slice(0, limit)
      .map((candidate) => withScore(toRecord(candidate.row), round(candidate.score)));
  }

  /**
   * What the daemon puts in front of a user turn (spec 41 §3.1): at most `maxRelevant` memories
   * that pass the relevance threshold, plus every pinned memory up to `maxPinned`, together within
   * `tokenCap`. Pinned memories go first; a memory that does not fit is skipped, not cut. Only
   * active entries qualify; `accept` (the lesson citation check, spec 42 §4) can veto one.
   */
  selectForPrompt(input: {
    text: string;
    projectId: string | null;
    maxRelevant?: number;
    maxPinned?: number;
    tokenCap: number;
    accept?: (memory: MemoryRecord) => boolean;
  }): ScoredMemory[] {
    const maxRelevant = input.maxRelevant ?? 5;
    const maxPinned = input.maxPinned ?? 10;
    const accept = input.accept ?? (() => true);
    const pinned = this.list({ projectId: input.projectId, status: "active" })
      .filter((memory) => memory.pinned)
      .filter(accept)
      .slice(0, maxPinned);
    const terms = extractQueryTerms(input.text);
    const relevant = this.candidates(input.text, input.projectId)
      .filter((candidate) => qualifies(candidate, terms))
      .filter((candidate) => !pinned.some((memory) => memory.id === candidate.row.id))
      .filter((candidate) => accept(toRecord(candidate.row)))
      .slice(0, maxRelevant);
    const selected: ScoredMemory[] = [];
    let tokens = 0;
    const take = (memory: ScoredMemory) => {
      const cost = estimateTokens(memory.text) + 8;
      if (tokens + cost > input.tokenCap) return;
      tokens += cost;
      selected.push(memory);
    };
    for (const memory of pinned) take({ ...memory, score: null });
    for (const candidate of relevant)
      take({ ...toRecord(candidate.row), score: round(candidate.score) });
    return selected;
  }

  /** Marks memories used by one turn of one agent (the chip and the inspector read these). */
  recordUses(input: {
    agentId: string;
    turnKey: string;
    kind: MemoryUseKind;
    memories: readonly Pick<ScoredMemory, "id" | "score">[];
  }): void {
    if (input.memories.length === 0) return;
    const now = this.now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memory_uses (agent_id, turn_key, memory_id, kind, score, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const touch = this.db.prepare(
      "UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const memory of input.memories) {
        const inserted = insert.run(
          input.agentId,
          input.turnKey,
          memory.id,
          input.kind,
          memory.score,
          now,
        );
        if (inserted.changes > 0) touch.run(now, memory.id);
      }
    })();
  }

  /** Memories one agent used, newest first; deleted memories drop out. */
  usesForAgent(agentId: string): MemoryUse[] {
    const rows = this.db
      .prepare<
        [string],
        MemoryRow & {
          turn_key: string;
          use_kind: MemoryUseKind;
          use_score: number | null;
          at: number;
        }
      >(
        `SELECT m.rowid, m.*, u.turn_key, u.kind AS use_kind, u.score AS use_score, u.at,
           (SELECT count(DISTINCT x.agent_id) FROM memory_uses x WHERE x.memory_id = m.id) AS agent_count
         FROM memory_uses u JOIN memories m ON m.id = u.memory_id
         WHERE u.agent_id = ? ORDER BY u.at DESC`,
      )
      .all(agentId);
    return rows.map((row) => ({
      memory: toRecord(row),
      turnKey: row.turn_key,
      kind: row.use_kind,
      score: row.use_score,
      usedAtMs: row.at,
    }));
  }

  /** User approval / restore, or the daemon marking an entry stale, deprecated or graduated. */
  setStatus(
    id: string,
    status: MemoryStatus,
    options: { reason?: string | null; graduatedPath?: string } = {},
  ): MemoryRecord {
    const row = this.row(id);
    if (!row) throw new MemoryInputError("Memory not found.", "not_found");
    const now = this.now();
    // Approving or restoring restarts the expiry clock and forgets the old reason.
    const kept = status === "active" && row.status !== "active";
    this.db
      .prepare(
        `UPDATE memories SET status = ?, status_reason = ?, updated_at = ?,
           kept_at = CASE WHEN ? THEN ? ELSE kept_at END,
           graduated_path = coalesce(?, graduated_path)
         WHERE id = ?`,
      )
      .run(
        status,
        status === "active" ? null : (options.reason ?? row.status_reason),
        now,
        kept ? 1 : 0,
        now,
        options.graduatedPath ?? null,
        id,
      );
    return this.require(id);
  }

  /**
   * 👍/👎 and the `rate_memory` tool (spec 42 §4). Helpful keeps a lesson alive (restarts its
   * 28-day clock); harmful ≥ 2 and more harmful than helpful deprecates the entry.
   */
  rate(id: string, helpful: boolean): MemoryRecord {
    const row = this.row(id);
    if (!row) throw new MemoryInputError("Memory not found.", "not_found");
    const now = this.now();
    if (helpful) {
      this.db
        .prepare("UPDATE memories SET helpful = helpful + 1, kept_at = ? WHERE id = ?")
        .run(now, id);
    } else {
      this.db.prepare("UPDATE memories SET harmful = harmful + 1 WHERE id = ?").run(id);
    }
    const next = this.require(id);
    if (
      next.harmful >= 2 &&
      next.harmful > next.helpful &&
      next.status !== "deprecated" &&
      next.status !== "graduated"
    ) {
      return this.setStatus(id, "deprecated", {
        reason: `Rated unhelpful ${next.harmful} times (helpful ${next.helpful}).`,
      });
    }
    return next;
  }

  markValidated(id: string): void {
    this.db.prepare("UPDATE memories SET last_validated_at = ? WHERE id = ?").run(this.now(), id);
  }

  /**
   * Active lessons not kept (created, approved or rated helpful) within `maxAgeMs` go stale
   * (spec 42 §4). Returns the ids that changed.
   */
  expireLessons(maxAgeMs: number): string[] {
    const cutoff = this.now() - maxAgeMs;
    const rows = this.db
      .prepare<[number], { id: string }>(
        `SELECT id FROM memories WHERE kind = 'lesson' AND status = 'active'
           AND coalesce(kept_at, created_at) < ?`,
      )
      .all(cutoff);
    const days = Math.round(maxAgeMs / 86_400_000);
    for (const { id } of rows) {
      this.setStatus(id, "stale", { reason: `Not rated helpful for ${days} days.` });
    }
    return rows.map((row) => row.id);
  }

  getSetting(key: string): string | null {
    return (
      this.db
        .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
        .get(key)?.value ?? null
    );
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }

  private candidates(query: string, projectId: string | null, scope?: MemoryScope): Candidate[] {
    const terms = extractQueryTerms(query);
    if (terms.length === 0) return [];
    const scopeSql = `${scopeCondition(scope)} AND m.status = 'active'`;
    const scopeParams = scope === "global" ? [] : [projectId ?? ""];
    const total =
      this.db
        .prepare<string[], { n: number }>(`SELECT count(*) AS n FROM memories m WHERE ${scopeSql}`)
        .get(...scopeParams)?.n ?? 0;
    if (total === 0) return [];
    const byRow = new Map<number, Candidate>();
    const matchTerm = this.db.prepare<string[], MemoryRow>(
      `SELECT m.rowid, m.*,
         (SELECT count(DISTINCT u.agent_id) FROM memory_uses u WHERE u.memory_id = m.id) AS agent_count
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND ${scopeSql}`,
    );
    for (const term of terms) {
      const rows = matchTerm.all(`{text tags} : ${term.fts}`, ...scopeParams);
      if (rows.length === 0) continue;
      const idf = Math.log(1 + (total - rows.length + 0.5) / (rows.length + 0.5));
      for (const row of rows) {
        const candidate = byRow.get(row.rowid) ?? {
          row,
          score: 0,
          matched: 0,
          identifierMatched: false,
          ftsRank: 0,
        };
        candidate.score += idf;
        candidate.matched += 1;
        candidate.identifierMatched ||= term.identifier;
        byRow.set(row.rowid, candidate);
      }
    }
    if (byRow.size === 0) return [];
    const ranks = this.db
      .prepare<[string], { rowid: number; rank: number }>(
        "SELECT rowid, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ?",
      )
      .all(`{text tags} : ${terms.map((term) => term.fts).join(" OR ")}`);
    for (const { rowid, rank } of ranks) {
      const candidate = byRow.get(rowid);
      if (candidate) candidate.ftsRank = rank;
    }
    // Spec 42 §4: at equal score a lesson goes before a plain memory.
    return [...byRow.values()].sort(
      (left, right) =>
        right.score - left.score ||
        kindRank(left.row.kind) - kindRank(right.row.kind) ||
        left.ftsRank - right.ftsRank ||
        right.row.updated_at - left.row.updated_at,
    );
  }

  private row(id: string): MemoryRow | undefined {
    return this.db.prepare<[string], MemoryRow>(`${ROW_SELECT} WHERE m.id = ?`).get(id);
  }

  private require(id: string): MemoryRecord {
    const row = this.row(id);
    if (!row) throw new MemoryInputError("Memory not found.", "not_found");
    return toRecord(row);
  }
}

/**
 * The auto-inject threshold. One shared word is not enough evidence when the message has several:
 * a memory needs two distinct query terms, or one path/identifier term, or every term of a
 * one-term message.
 */
function qualifies(candidate: Candidate, terms: readonly QueryTerm[]): boolean {
  if (candidate.identifierMatched) return true;
  return candidate.matched >= Math.min(2, terms.length);
}

function kindRank(kind: MemoryKind): number {
  return kind === "lesson" ? 0 : 1;
}

function mergeCitations(
  existing: readonly MemoryCitation[],
  incoming: readonly MemoryCitation[],
): MemoryCitation[] {
  const merged = [...existing];
  for (const citation of incoming) {
    const same = merged.some(
      (other) =>
        other.path === citation.path &&
        other.symbol === citation.symbol &&
        other.excerpt === citation.excerpt,
    );
    if (!same) merged.push(citation);
  }
  return merged.slice(-5);
}

function scopeCondition(scope: MemoryScope | undefined): string {
  if (scope === "global") return "m.scope = 'global'";
  if (scope === "project") return "m.scope = 'project' AND m.project_id = ?";
  return "(m.scope = 'global' OR (m.scope = 'project' AND m.project_id = ?))";
}

function withScore(record: MemoryRecord, score: number | null): ScoredMemory {
  return Object.assign(record, { score });
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toRecord(row: MemoryRow): MemoryRecord {
  const base = {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id,
    text: row.text,
    tags: JSON.parse(row.tags) as string[],
    pinned: row.pinned === 1,
    source: JSON.parse(row.source) as MemorySource,
    createdAtMs: row.created_at,
    updatedAtMs: row.updated_at,
    lastUsedAtMs: row.last_used_at,
    useCount: row.use_count,
  };
  const record: MemoryRecord = {
    ...base,
    kind: row.kind ?? "memory",
    status: row.status ?? "active",
    citations: JSON.parse(row.citations ?? "[]") as MemoryCitation[],
    helpful: row.helpful ?? 0,
    harmful: row.harmful ?? 0,
    statusReason: row.status_reason ?? null,
    lastValidatedAtMs: row.last_validated_at ?? null,
    agentCount: row.agent_count ?? 0,
    graduatedPath: row.graduated_path ?? null,
    graduationReady: false,
  };
  record.graduationReady = isGraduationReady(record);
  return record;
}
