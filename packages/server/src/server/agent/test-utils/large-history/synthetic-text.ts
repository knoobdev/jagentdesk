/** Shape of a generated long-running agent history. */
export interface LargeHistorySize {
  turns: number;
  toolsPerTurn: number;
  promptChars: number;
  thinkingChars: number;
  textChars: number;
  toolOutputChars: number;
  /** Every Nth turn launches a subagent; 0 disables subagents. */
  subagentEvery: number;
  /** Every Nth tool call returns `hugeOutputChars`; 0 disables. */
  hugeOutputEvery: number;
  hugeOutputChars: number;
  /** Every Nth turn attaches a screenshot; 0 disables. */
  imageEvery: number;
  seed?: number;
}

/**
 * About 2 700 timeline items, 60 MB of transcript and millions of tokens of text: the scale of a months-long
 * agent. A4.19b.1 needs at least 2 000 items and 300 000 tokens.
 */
export const LONG_AGENT_HISTORY: LargeHistorySize = {
  turns: 300,
  toolsPerTurn: 5,
  promptChars: 600,
  thinkingChars: 1_500,
  textChars: 900,
  toolOutputChars: 12_000,
  subagentEvery: 40,
  hugeOutputEvery: 60,
  hugeOutputChars: 600_000,
  imageEvery: 30,
};

const WORDS = (
  "session timeline replay cursor projected history provider daemon render paging tail " +
  "fixture worker socket client transcript record parser stream buffer index commit agent " +
  "function return const await import export interface type module test assert expect value"
).split(" ");

/** Deterministic filler text, so a fixture is reproducible and compresses like real prose/code. */
export class LargeHistoryText {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  private next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }

  sentence(chars: number): string {
    const parts: string[] = [];
    let length = 0;
    while (length < chars) {
      const word = WORDS[this.next() % WORDS.length];
      parts.push(word);
      length += word.length + 1;
    }
    return parts.join(" ");
  }

  base64(chars: number): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    while (out.length < chars) out += alphabet[this.next() % 64].repeat(1 + (this.next() % 8));
    return out.slice(0, chars - (chars % 4));
  }

  /** Multi-line output shaped like source code or command output. */
  block(chars: number): string {
    const lines: string[] = [];
    let length = 0;
    let lineNumber = 1;
    while (length < chars) {
      const line = `${String(lineNumber).padStart(5, " ")}\t${this.sentence(60)}`;
      lines.push(line);
      length += line.length + 1;
      lineNumber += 1;
    }
    return lines.join("\n");
  }
}
