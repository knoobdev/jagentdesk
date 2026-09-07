import type { DatabaseEngine } from "@jagentdesk/protocol/database/rpc-schemas";
import { quoteIdent } from "@/utils/sql-ident";

/**
 * Context-aware WHERE-clause completion (DataGrip-style), used by the data grid's
 * filter bar. Completion runs in three phases, never a flat mix of columns and
 * literals:
 *   • column position (start, after AND/OR/NOT, after "(") → the table's columns
 *   • right after a column → comparison operators (=, LIKE, IN, IS NULL, …)
 *   • after a complete condition → the AND / OR connectors
 *
 * Kept pure and standalone so the phase logic is unit-tested without the component.
 */

export interface WhereAcItem {
  key: string;
  label: string;
  detail?: string;
  /** Text to insert; includes a trailing space (or "(" for IN) so the caret lands
   *  where the next token goes. */
  insert: string;
}

/** Just the column fields the completion needs (a subset of DbColumn). */
export interface WhereAcColumn {
  name: string;
  dataType?: string;
}

// Operators offered right after a column.
// prettier-ignore
export const WHERE_OPERATORS: ReadonlyArray<{ label: string; insert: string }> = [
  { label: "=", insert: "= " },
  { label: "<>", insert: "<> " },
  { label: "!=", insert: "!= " },
  { label: "<", insert: "< " },
  { label: "<=", insert: "<= " },
  { label: ">", insert: "> " },
  { label: ">=", insert: ">= " },
  { label: "LIKE", insert: "LIKE " },
  { label: "ILIKE", insert: "ILIKE " },
  { label: "IN", insert: "IN (" },
  { label: "NOT IN", insert: "NOT IN (" },
  { label: "IS NULL", insert: "IS NULL " },
  { label: "IS NOT NULL", insert: "IS NOT NULL " },
  { label: "BETWEEN", insert: "BETWEEN " },
];

export const WHERE_CONNECTORS: ReadonlyArray<{ label: string; insert: string }> = [
  { label: "AND", insert: "AND " },
  { label: "OR", insert: "OR " },
];

// Tokens that mark phase boundaries when scanning the text before the caret.
const WHERE_LOGICAL = new Set(["and", "or", "not"]);
// prettier-ignore
const WHERE_OP_TOKENS = new Set([
  "=", "<>", "!=", "<", "<=", ">", ">=", "like", "ilike", "in", "is", "between", "not",
]);

/** The identifier word being typed at the end of the text (unquoted). */
const FILTER_WORD_RE = /([A-Za-z_][A-Za-z0-9_]*)$/;

function stripIdentQuotes(token: string): string {
  return token.replace(/^["'`[]+|["'`\]]+$/g, "");
}

const MAX_ITEMS = 12;

/**
 * Completion items for the current filter text, plus the partial word being typed
 * (so the UI can highlight it). Deterministic; no async, no schema fetch.
 */
export function buildWhereCompletion(
  text: string,
  columns: readonly WhereAcColumn[],
  engine: DatabaseEngine,
): { items: WhereAcItem[]; partial: string } {
  const colByLower = new Map(columns.map((c) => [c.name.toLowerCase(), c] as const));
  const columnItems = (): WhereAcItem[] =>
    columns.map((c) => {
      const plain = /^[a-z_][a-z0-9_]*$/.test(c.name);
      const ident = plain ? c.name : quoteIdent(engine, c.name);
      return { key: `col:${c.name}`, label: c.name, detail: c.dataType, insert: `${ident} ` };
    });
  const opItems = (): WhereAcItem[] =>
    WHERE_OPERATORS.map((o) => ({ key: `op:${o.label}`, label: o.label, insert: o.insert }));
  const cxItems = (): WhereAcItem[] =>
    WHERE_CONNECTORS.map((o) => ({ key: `cx:${o.label}`, label: o.label, insert: o.insert }));

  const endsWithSpace = text.length === 0 || /\s$/.test(text);
  const wordMatch = endsWithSpace ? null : FILTER_WORD_RE.exec(text);
  const partial = wordMatch ? wordMatch[1] : "";
  const before = (wordMatch ? text.slice(0, wordMatch.index) : text).replace(/\s+$/, "");
  const beforeTokens = before.length > 0 ? before.split(/\s+/) : [];
  const lastBefore =
    beforeTokens.length > 0 ? beforeTokens[beforeTokens.length - 1].toLowerCase() : undefined;

  let items: WhereAcItem[] = [];
  if (lastBefore === undefined || WHERE_LOGICAL.has(lastBefore) || before.endsWith("(")) {
    items = columnItems();
  } else if (colByLower.has(stripIdentQuotes(lastBefore))) {
    items = opItems();
  } else if (WHERE_OP_TOKENS.has(lastBefore)) {
    items = []; // expecting a value — stay out of the way
  } else if (endsWithSpace) {
    items = cxItems(); // a value / ")" completed a condition
  }

  if (partial) {
    const p = partial.toLowerCase();
    items = items.filter((it) => it.label.toLowerCase().startsWith(p));
  }
  return { items: items.slice(0, MAX_ITEMS), partial };
}

/**
 * Insert a completion into the current text: replace the partial word being typed,
 * or append after a trailing space.
 */
export function applyWhereCompletion(current: string, item: WhereAcItem): string {
  const endsWithSpace = current.length === 0 || /\s$/.test(current);
  if (!endsWithSpace) {
    const m = FILTER_WORD_RE.exec(current);
    if (m) return current.slice(0, m.index) + item.insert;
  }
  return current + item.insert;
}
