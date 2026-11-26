import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  MemoryRecord,
  MemoryScope,
  MemorySource,
  MemoryUse,
  MemoryUseKind,
  ScoredMemory,
} from "../shared/types.js";
import { MEMORY_TEXT_MAX_CHARS } from "../shared/types.js";
import { extractQueryTerms, type QueryTerm } from "./query-terms.js";
import { findSecret } from "./secrets.js";

export class MemoryInputError extends Error {
  constructor(
    message: string,
    readonly code: "empty" | "too_long" | "secret" | "not_found" | "no_project" | "disabled",
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
}

export interface AddMemoryInput {
  scope: MemoryScope;
  projectId: string | null;
  text: string;
  tags?: readonly string[];
  pinned?: boolean;
  source: MemorySource;
}

export interface UpdateMemoryInput {
  text?: string;
  tags?: readonly string[];
  pinned?: boolean;
}

export interface ListMemoriesFilter {
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
    const existing = this.db
      .prepare<[string, string, string], MemoryRow>(
        "SELECT rowid, * FROM memories WHERE scope = ? AND ifnull(project_id, '') = ? AND norm = ?",
      )
      .get(input.scope, projectId ?? "", norm);
    if (existing) {
      const tags = cleanTags([...JSON.parse(existing.tags), ...(input.tags ?? [])]);
      this.db
        .prepare("UPDATE memories SET text = ?, tags = ?, updated_at = ? WHERE id = ?")
        .run(text, JSON.stringify(tags), now, existing.id);
      return { memory: this.require(existing.id), deduplicated: true };
    }
    const id = this.newId();
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, project_id, text, norm, tags, pinned, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    return { memory: this.require(id), deduplicated: false };
  }

  update(id: string, patch: UpdateMemoryInput): MemoryRecord {
    const row = this.row(id);
    if (!row) throw new MemoryInputError("Memory not found.", "not_found");
    const text = patch.text === undefined ? row.text : validateMemoryText(patch.text);
    const tags = patch.tags === undefined ? JSON.parse(row.tags) : cleanTags(patch.tags);
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
          "UPDATE memories SET text = ?, norm = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?",
        )
        .run(text, norm, JSON.stringify(tags), pinned, this.now(), id);
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
    if (filter.scope === "global") where.push("scope = 'global'");
    else if (filter.scope === "project") {
      where.push("scope = 'project' AND project_id = ?");
      params.push(filter.projectId ?? "");
    } else if (filter.projectId !== undefined) {
      where.push("(scope = 'global' OR (scope = 'project' AND project_id = ?))");
      params.push(filter.projectId ?? "");
    }
    if (filter.tag) {
      where.push("EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE value = ?)");
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
    const sql = `SELECT rowid, * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
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
   * `tokenCap`. Pinned memories go first; a memory that does not fit is skipped, not cut.
   */
  selectForPrompt(input: {
    text: string;
    projectId: string | null;
    maxRelevant?: number;
    maxPinned?: number;
    tokenCap: number;
  }): ScoredMemory[] {
    const maxRelevant = input.maxRelevant ?? 5;
    const maxPinned = input.maxPinned ?? 10;
    const pinned = this.list({ projectId: input.projectId })
      .filter((memory) => memory.pinned)
      .slice(0, maxPinned);
    const terms = extractQueryTerms(input.text);
    const relevant = this.candidates(input.text, input.projectId)
      .filter((candidate) => qualifies(candidate, terms))
      .filter((candidate) => !pinned.some((memory) => memory.id === candidate.row.id))
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
        MemoryRow & { turn_key: string; kind: MemoryUseKind; score: number | null; at: number }
      >(
        `SELECT m.rowid, m.*, u.turn_key, u.kind, u.score AS score, u.at
         FROM memory_uses u JOIN memories m ON m.id = u.memory_id
         WHERE u.agent_id = ? ORDER BY u.at DESC`,
      )
      .all(agentId);
    return rows.map((row) => ({
      memory: toRecord(row),
      turnKey: row.turn_key,
      kind: row.kind,
      score: row.score,
      usedAtMs: row.at,
    }));
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
    const scopeSql = scopeCondition(scope);
    const scopeParams = scope === "global" ? [] : [projectId ?? ""];
    const total =
      this.db
        .prepare<string[], { n: number }>(`SELECT count(*) AS n FROM memories m WHERE ${scopeSql}`)
        .get(...scopeParams)?.n ?? 0;
    if (total === 0) return [];
    const byRow = new Map<number, Candidate>();
    const matchTerm = this.db.prepare<string[], MemoryRow>(
      `SELECT m.rowid, m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
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
    return [...byRow.values()].sort(
      (left, right) =>
        right.score - left.score ||
        left.ftsRank - right.ftsRank ||
        right.row.updated_at - left.row.updated_at,
    );
  }

  private row(id: string): MemoryRow | undefined {
    return this.db
      .prepare<[string], MemoryRow>("SELECT rowid, * FROM memories WHERE id = ?")
      .get(id);
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
  return {
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
}
