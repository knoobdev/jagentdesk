// A small JQL evaluator for the fake Jira server: the subset the daemon and its tests send
// (AND/OR/NOT, parentheses, = != >= <= > < ~ IN / NOT IN / IS EMPTY, functions currentUser(),
// openSprints(), unreleasedVersions()). Unknown fields fail like Jira does (400).

export interface JqlIssueView {
  key: string;
  project: string;
  summary: string;
  status: string;
  statusCategory: string; // "To Do" | "In Progress" | "Done"
  assignee: string | null; // ref
  reporter: string | null;
  labels: string[];
  updated_ms: number;
  created_ms: number;
  issuetype: string;
  parent: string | null;
  sprintIds: number[];
  watchers: string[];
  resolution: string | null;
  text: string;
}

export interface JqlContext {
  me: string;
  openSprintIds: number[];
  /** Offset of the user's profile time zone, minutes east of UTC. */
  tzOffsetMinutes: number;
}

export class JqlError extends Error {}

interface Token {
  kind: "word" | "string" | "op" | "lparen" | "rparen" | "comma";
  text: string;
}

function tokenize(jql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < jql.length) {
    const char = jql[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") tokens.push({ kind: "lparen", text: char });
    else if (char === ")") tokens.push({ kind: "rparen", text: char });
    else if (char === ",") tokens.push({ kind: "comma", text: char });
    else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < jql.length && jql[end] !== char) end += 1;
      tokens.push({ kind: "string", text: jql.slice(index + 1, end) });
      index = end + 1;
      continue;
    } else if (/[!<>=~]/.test(char)) {
      const two = jql.slice(index, index + 2);
      const op = [">=", "<=", "!=", "!~"].includes(two) ? two : char;
      tokens.push({ kind: "op", text: op });
      index += op.length;
      continue;
    } else {
      let end = index;
      while (end < jql.length && /[^\s(),!<>=~"']/.test(jql[end] ?? "")) end += 1;
      tokens.push({ kind: "word", text: jql.slice(index, end) });
      index = end;
      continue;
    }
    index += 1;
  }
  return tokens;
}

type Predicate = (issue: JqlIssueView) => boolean;

const FIELDS = new Set([
  "project",
  "key",
  "issuekey",
  "summary",
  "status",
  "statuscategory",
  "assignee",
  "reporter",
  "labels",
  "updated",
  "created",
  "issuetype",
  "type",
  "parent",
  "sprint",
  "watcher",
  "resolution",
  "text",
  "fixversion",
  "id",
]);

class Parser {
  private index = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly context: JqlContext,
  ) {}

  parse(): Predicate {
    if (this.tokens.length === 0) return () => true;
    const predicate = this.or();
    if (this.peekWord("order")) return predicate;
    if (this.index < this.tokens.length)
      throw new JqlError(`Unexpected '${this.tokens[this.index]?.text}'`);
    return predicate;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
  private peekWord(word: string): boolean {
    const token = this.peek();
    return token?.kind === "word" && token.text.toLowerCase() === word;
  }
  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new JqlError("Unexpected end of JQL");
    this.index += 1;
    return token;
  }

  private or(): Predicate {
    let left = this.and();
    while (this.peekWord("or")) {
      this.next();
      const right = this.and();
      const l = left;
      left = (issue) => l(issue) || right(issue);
    }
    return left;
  }

  private and(): Predicate {
    let left = this.unary();
    while (this.peekWord("and")) {
      this.next();
      const right = this.unary();
      const l = left;
      left = (issue) => l(issue) && right(issue);
    }
    return left;
  }

  private unary(): Predicate {
    if (this.peekWord("not")) {
      this.next();
      const inner = this.unary();
      return (issue) => !inner(issue);
    }
    if (this.peek()?.kind === "lparen") {
      this.next();
      const inner = this.or();
      if (this.next().kind !== "rparen") throw new JqlError("Expected ')'");
      return inner;
    }
    return this.clause();
  }

  private value(): string[] {
    const token = this.next();
    if (token.kind === "lparen") {
      const values: string[] = [];
      while (this.peek()?.kind !== "rparen") {
        values.push(...this.value());
        if (this.peek()?.kind === "comma") this.next();
      }
      this.next();
      return values;
    }
    if (token.kind === "word" && this.peek()?.kind === "lparen") {
      this.next();
      this.next();
      return [this.callFunction(token.text)];
    }
    return [token.text];
  }

  private callFunction(name: string): string {
    switch (name.toLowerCase()) {
      case "currentuser":
        return this.context.me;
      case "opensprints":
        return `#sprints:${this.context.openSprintIds.join(",")}`;
      case "unreleasedversions":
        return "#any";
      default:
        throw new JqlError(`Unknown function ${name}()`);
    }
  }

  // oxlint-disable-next-line complexity
  private clause(): Predicate {
    const fieldToken = this.next();
    const field = fieldToken.text.toLowerCase();
    if (!FIELDS.has(field))
      throw new JqlError(
        `Field '${fieldToken.text}' does not exist or you do not have permission to view it.`,
      );
    let op = this.next().text.toLowerCase();
    if (op === "not" && this.peekWord("in")) {
      this.next();
      op = "not in";
    }
    if (op === "is" && this.peekWord("not")) {
      this.next();
      op = "is not";
    }
    const values = op === "is" || op === "is not" ? [this.next().text.toLowerCase()] : this.value();
    if (field === "updated" || field === "created") {
      const bound = this.parseTime(values[0] ?? "");
      return (issue) => {
        const at = field === "updated" ? issue.updated_ms : issue.created_ms;
        if (op === ">=") return at >= bound;
        if (op === ">") return at > bound;
        if (op === "<=") return at <= bound;
        return at < bound;
      };
    }
    // oxlint-disable-next-line complexity
    const read = (issue: JqlIssueView): string[] => {
      switch (field) {
        case "project":
          return [issue.project];
        case "key":
        case "issuekey":
          return [issue.key];
        case "summary":
          return [issue.summary];
        case "text":
          return [issue.text];
        case "status":
          return [issue.status];
        case "statuscategory":
          return [issue.statusCategory];
        case "assignee":
          return issue.assignee ? [issue.assignee] : [];
        case "reporter":
          return issue.reporter ? [issue.reporter] : [];
        case "labels":
          return issue.labels;
        case "issuetype":
        case "type":
          return [issue.issuetype];
        case "parent":
          return issue.parent ? [issue.parent] : [];
        case "sprint":
          return issue.sprintIds.map(String);
        case "watcher":
          return issue.watchers;
        case "resolution":
          return issue.resolution ? [issue.resolution] : [];
        default:
          return ["#any"];
      }
    };
    const matches = (actual: string[], expected: string) => {
      if (expected === "#any") return true;
      if (expected.startsWith("#sprints:")) {
        const ids = expected.slice(9).split(",");
        return actual.some((a) => ids.includes(a));
      }
      if (expected.toLowerCase() === "unresolved") return actual.length === 0;
      return actual.some((a) => a.toLowerCase() === expected.toLowerCase());
    };
    switch (op) {
      case "=":
      case "in":
        return (issue) => values.some((v) => matches(read(issue), v));
      case "!=":
      case "not in":
        return (issue) => !values.some((v) => matches(read(issue), v));
      case "~":
        return (issue) =>
          read(issue).some((a) =>
            a.toLowerCase().includes((values[0] ?? "").replace(/\*$/, "").toLowerCase()),
          );
      case "is":
        return (issue) => read(issue).length === 0;
      case "is not":
        return (issue) => read(issue).length > 0;
      default:
        throw new JqlError(`Operator '${op}' is not supported for ${field}`);
    }
  }

  private parseTime(text: string): number {
    const match = /^(\d{4})[/-](\d{2})[/-](\d{2})(?: (\d{2}):(\d{2}))?$/.exec(text);
    if (!match) throw new JqlError(`Date value '${text}' for field 'updated' is invalid.`);
    const [, y, mo, d, h = "00", mi = "00"] = match;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    return utc - this.context.tzOffsetMinutes * 60_000;
  }
}

export function compileJql(jql: string, context: JqlContext): Predicate {
  return new Parser(tokenize(jql), context).parse();
}
