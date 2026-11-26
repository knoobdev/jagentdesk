/**
 * Spec 42 §4 system instruction, next to the session ledger instruction. Static for the life of a
 * session, so the system prompt (and the provider's prompt cache) stays the same between turns.
 */
export const LESSON_INSTRUCTION = [
  "Learn from corrections: when the user corrects or contradicts you, or you find you were wrong and have confirmed the right way,",
  'call remember with kind "lesson" in that same turn: one sentence written as the rule to follow, with citations (the file that',
  "proves it, and a short exact excerpt when you can). Never save a lesson that is not confirmed yet. When a lesson or memory you",
  "were given clearly helped or misled you, call rate_memory with its id.",
].join(" ");
