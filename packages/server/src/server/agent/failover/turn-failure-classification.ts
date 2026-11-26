/**
 * What kind of failure ended a turn. Only `usage_limit` may trigger failover (spec 40 §4); network,
 * auth and tool failures never do.
 */
export type TurnFailureKind = "usage_limit" | "network" | "auth" | "other";

export interface TurnFailureInput {
  error: string;
  code?: string | null;
  diagnostic?: string | null;
}

// Messages the providers send when an account or model has run out of quota:
// Claude Code ("Claude AI usage limit reached", "You've hit your limit · resets 3pm",
// "5-hour limit reached"), Codex ("You've hit your usage limit … try again at",
// `usageLimitExceeded`), OpenAI/OpenRouter-backed OpenCode ("insufficient_quota",
// "You exceeded your current quota", "rate_limit_exceeded"), Anthropic API ("rate_limit_error",
// "credit balance is too low").
const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage[ _-]?limit/i,
  /hit your (?:usage )?limit/i,
  /\blimit (?:reached|exceeded)\b/i,
  /\b(?:5|five)[- ]hour limit\b/i,
  /\bweekly limit\b/i,
  /insufficient[_ ]quota/i,
  /exceeded your (?:current )?quota/i,
  /quota (?:exceeded|exhausted)/i,
  /rate[_ ]limit(?:_error|_exceeded| exceeded| reached)?/i,
  /too many requests/i,
  /credit balance is too low/i,
  /out of credits/i,
  /\b429\b/,
];

const AUTH_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /unauthori[sz]ed/i,
  /authentication(?:_error| failed| required)/i,
  /invalid (?:api[ _-]?key|x-api-key|token)/i,
  /not (?:logged|signed) in/i,
  /please (?:log|sign) ?in/i,
  /oauth token (?:has )?expired/i,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b/,
  /socket hang up/i,
  /fetch failed/i,
  /network (?:error|is unreachable)/i,
  /stream disconnected/i,
  /connection (?:reset|refused|closed|error)/i,
  /timed? ?out/i,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyTurnFailure(input: TurnFailureInput): TurnFailureKind {
  const text = [input.error, input.code, input.diagnostic].filter(Boolean).join("\n");
  if (!text.trim()) return "other";
  // Auth wins over the rest: a 401 page can mention rate limits in its body.
  if (matchesAny(text, AUTH_PATTERNS)) return "auth";
  if (matchesAny(text, USAGE_LIMIT_PATTERNS)) return "usage_limit";
  if (matchesAny(text, NETWORK_PATTERNS)) return "network";
  return "other";
}
