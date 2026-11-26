/**
 * Turns free text (a user message, a search query) into FTS5 query terms.
 *
 * The FTS table uses `porter unicode61 remove_diacritics 2`, so plain words are passed to FTS5 as
 * quoted strings and stemmed there. Paths and dotted/underscored identifiers become phrases of
 * their parts, which is how unicode61 indexed them; camelCase names stay one token.
 */

export interface QueryTerm {
  /** FTS5 query fragment: one quoted string or phrase. */
  fts: string;
  /** Dedup key. */
  key: string;
  /** Paths, file names and code identifiers are specific enough to count on their own. */
  identifier: boolean;
}

/** More terms than this add cost without changing which memories qualify. */
export const MAX_QUERY_TERMS = 24;

// English function words plus common Vietnamese ones (diacritics removed, as the index stores
// them). Words that carry meaning in a coding context ("install", "test", "build") stay.
const STOPWORDS = new Set(
  [
    "a an and are as at be been being but by can could did do does doing done for from had has",
    "have having he her here hers him his how i if in into is it its itself just let lets me",
    "more most my no nor not now of off on once only or other our ours out over own please same",
    "she should so some such than that the their theirs them then there these they this those",
    "through to too under until up very was we were what when where which while who whom why",
    "will with would you your yours yourself also any about again all am because before below",
    "between both during each few further get got make made many may might much must need",
    "ok okay one onto shall since still tell thing things try us use used uses using want way",
    "well yes yet",
    // Vietnamese
    "la va cua co khong duoc cho nay do voi cac nhung mot de thi ma nhu khi da se dang rang bang",
    "gi nao o trong ra vao lai cung nhe a hay ban toi minh em anh chi no ho ay day kia thay",
    "nhu vay the sao roi nua hoi oi vui long giup lam xem cai nha",
  ]
    .join(" ")
    .split(/\s+/),
);

/** Lowercase and drop diacritics, matching unicode61 remove_diacritics 2. */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

function parts(value: string): string[] {
  return foldText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length > 0);
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function keepWord(word: string): boolean {
  if (STOPWORDS.has(word)) return false;
  if (/^\p{N}+$/u.test(word)) return word.length >= 3;
  return word.length >= 2;
}

export function extractQueryTerms(text: string, limit = MAX_QUERY_TERMS): QueryTerm[] {
  const terms: QueryTerm[] = [];
  const seen = new Set<string>();
  const push = (term: QueryTerm) => {
    if (seen.has(term.key) || terms.length >= limit) return;
    seen.add(term.key);
    terms.push(term);
  };
  for (const raw of text.split(/\s+/)) {
    if (terms.length >= limit) break;
    // Trim sentence punctuation and quotes, keep inner separators.
    const token = raw.replace(/^[^\p{L}\p{N}~/.]+|[^\p{L}\p{N}]+$/gu, "");
    if (!token) continue;
    const tokenParts = parts(token);
    if (tokenParts.length === 0) continue;
    if (tokenParts.length > 1) {
      push({ fts: quote(tokenParts.join(" ")), key: tokenParts.join(" "), identifier: true });
      continue;
    }
    const word = tokenParts[0]!;
    const camel = /\p{Ll}\p{Lu}/u.test(token);
    if (!camel && !keepWord(word)) continue;
    push({ fts: quote(word), key: word, identifier: camel });
  }
  return terms;
}
