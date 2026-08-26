import type { Skill } from "@/stores/skills-store";

/**
 * Auto-load matching (redesign B5, docs/plans/active/skills-redesign.md).
 *
 * `matchSkillsForQuery` picks the skills whose tags / name / description overlap
 * the user's message so the agent can pull in relevant knowledge WITHOUT the user
 * manually attaching them. It is deliberately simple and deterministic (keyword /
 * tag overlap, no embeddings) so the same message always resolves the same skills.
 */

// Very common words carry no signal for matching; drop them so a message like
// "how do I review the diff" matches on "review"/"diff", not "how"/"the".
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "your",
  "with",
  "this",
  "that",
  "how",
  "what",
  "why",
  "when",
  "can",
  "does",
  "did",
  "are",
  "was",
  "our",
  "out",
  "get",
  "got",
  "into",
  "from",
  "about",
  "please",
  "help",
  "should",
  "would",
  "could",
  "some",
  "any",
  "all",
]);

const MIN_TOKEN_LENGTH = 3;
const WEIGHT_TAG = 3;
const WEIGHT_NAME = 2;
const WEIGHT_DESCRIPTION = 1;

/** Lowercase, split on non-alphanumerics, drop short tokens and stopwords. */
export function tokenizeSkillText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token));
}

function toTokenSet(values: string[]): Set<string> {
  const set = new Set<string>();
  for (const value of values) {
    for (const token of tokenizeSkillText(value)) {
      set.add(token);
    }
  }
  return set;
}

/**
 * Score one skill against the already-tokenized query. Each query token counts
 * once, at its strongest source: a tag hit outweighs a name hit outweighs a
 * description hit. Zero means the skill is irrelevant to the message.
 */
export function scoreSkillForTokens(skill: Skill, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 0;
  const tagTokens = toTokenSet(skill.tags);
  const nameTokens = toTokenSet([skill.name]);
  const descriptionTokens = toTokenSet([skill.description]);
  let score = 0;
  for (const token of queryTokens) {
    if (tagTokens.has(token)) {
      score += WEIGHT_TAG;
    } else if (nameTokens.has(token)) {
      score += WEIGHT_NAME;
    } else if (descriptionTokens.has(token)) {
      score += WEIGHT_DESCRIPTION;
    }
  }
  return score;
}

/**
 * The skills relevant to `text`, most relevant first. Deterministic: ties break
 * on skill name so the order is stable across calls.
 */
export function matchSkillsForQuery(skills: Skill[], text: string): Skill[] {
  const queryTokens = new Set(tokenizeSkillText(text));
  if (queryTokens.size === 0) return [];
  return skills
    .map((skill) => ({ skill, score: scoreSkillForTokens(skill, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((entry) => entry.skill);
}
