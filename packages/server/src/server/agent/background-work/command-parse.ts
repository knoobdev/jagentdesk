import { isAbsolute, normalize, resolve } from "node:path";

/**
 * ADR-0064: reads a background shell command for the files it writes its output to and the
 * script it runs. Only literal words count. A command with command substitution, a subshell,
 * a here-doc or anything else this reader cannot be sure of yields nothing; a single word
 * with a variable, glob or brace is skipped.
 */

export interface ParsedBackgroundCommand {
  /** Absolute paths of `> f`, `>> f`, `1> f`, `2> f`, `&> f` and `| tee [-a] f`, in order. */
  redirects: string[];
  /** Absolute path of the script an interpreter runs (`zsh x.sh`) or that runs itself (`./x.sh`). */
  script: string | null;
}

export interface ParseCommandContext {
  /** Folder the command starts in; relative paths are dropped without it. */
  cwd: string | null;
  /** Home folder for `~/…`. */
  home: string | null;
}

const EMPTY: ParsedBackgroundCommand = { redirects: [], script: null };
const MAX_NESTING = 3;

type Token =
  | { kind: "word"; value: string; literal: boolean; tilde: boolean }
  | { kind: "op"; value: string };

class Unparsable extends Error {}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SCRIPT_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "node",
  "python",
  "python3",
  "ruby",
  "bun",
]);
/** Commands that run the next word as the command (`nohup x.sh`). */
const PREFIX_COMMANDS = new Set(["nohup", "exec", "command", "time", "builtin", "caffeinate"]);
/** Prefixes that take one value before the command. */
const PREFIX_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  nice: new Set(["-n"]),
  timeout: new Set(),
  env: new Set(["-u", "-C"]),
};
/** Options that take the next word as their value, per interpreter. */
const INTERPRETER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
  node: new Set(["-r", "--require", "--import", "--loader", "--env-file", "--conditions", "-C"]),
  python: new Set(["-W", "-X", "-Q"]),
  python3: new Set(["-W", "-X", "-Q"]),
  ruby: new Set(["-I", "-r", "-C", "-E"]),
};
/** Options after which no script file follows (`python -m mod`, `node -e code`). */
const NO_SCRIPT_OPTIONS = new Set(["-c", "-m", "-e", "--eval", "-p", "--print", "-"]);

export function parseBackgroundCommand(
  command: string,
  context: ParseCommandContext,
): ParsedBackgroundCommand {
  try {
    const result: ParsedBackgroundCommand = { redirects: [], script: null };
    walk(command, { cwd: context.cwd, home: context.home }, result, 0);
    result.redirects = [...new Set(result.redirects)];
    return result;
  } catch (error) {
    if (error instanceof Unparsable) return EMPTY;
    throw error;
  }
}

export interface ParsedReadCommand {
  /** Absolute paths a `cat`/`tail`/`head`/`less` in the command reads. */
  paths: string[];
}

const READ_COMMANDS = new Set(["cat", "tail", "head", "less", "more", "bat"]);

/** ADR-0064 §3: the files an agent's own shell command reads with cat/tail/head/less. */
export function parseReadCommand(command: string, context: ParseCommandContext): string[] {
  try {
    const paths: string[] = [];
    walkReads(command, { cwd: context.cwd, home: context.home }, paths, 0);
    return [...new Set(paths)];
  } catch (error) {
    if (error instanceof Unparsable) return [];
    throw error;
  }
}

interface WalkState {
  cwd: string | null;
  home: string | null;
}

function walk(
  command: string,
  state: WalkState,
  result: ParsedBackgroundCommand,
  depth: number,
): void {
  if (depth > MAX_NESTING) throw new Unparsable();
  for (const simple of splitCommands(tokenize(command))) {
    pushPaths(result.redirects, simple.redirects, state);
    walkCommand(simple, state, result, depth);
  }
}

function pushPaths(into: string[], words: readonly WordToken[], state: WalkState): void {
  for (const word of words) {
    if (word.literal && word.value.startsWith("-")) continue;
    const path = resolveWord(word, state);
    if (path) into.push(path);
  }
}

/** What one simple command adds: a folder change, tee files, an inline shell, or the script. */
function walkCommand(
  { words, pipedFrom }: SimpleCommand,
  state: WalkState,
  result: ParsedBackgroundCommand,
  depth: number,
): void {
  const name = commandName(words);
  if (!name?.word.literal) return;
  const { word, rest } = name;
  const base = basename(word.value);
  if (base === "cd" || base === "pushd" || base === "popd") {
    state.cwd = base === "popd" ? null : changeDirectory(rest[0], state);
    return;
  }
  if (pipedFrom && base === "tee") {
    pushPaths(result.redirects, rest, state);
    return;
  }
  const inline = SHELLS.has(base) ? shellInlineCommand(rest) : undefined;
  if (inline === null) throw new Unparsable();
  if (inline !== undefined) {
    walk(inline, state, result, depth + 1);
    return;
  }
  if (result.script) return;
  if (SCRIPT_INTERPRETERS.has(base) || base === "deno") {
    const script = interpreterScript(base, rest);
    if (script) result.script = resolveWord(script, state);
    return;
  }
  if (word.value.includes("/")) result.script = resolveWord(word, state);
}

function walkReads(command: string, state: WalkState, paths: string[], depth: number): void {
  if (depth > MAX_NESTING) throw new Unparsable();
  for (const { words } of splitCommands(tokenize(command))) {
    const name = commandName(words);
    if (!name?.word.literal) continue;
    const base = basename(name.word.value);
    if (base === "cd" || base === "pushd") {
      state.cwd = changeDirectory(name.rest[0], state);
      continue;
    }
    if (SHELLS.has(base)) {
      const inline = shellInlineCommand(name.rest);
      if (inline) walkReads(inline, state, paths, depth + 1);
      continue;
    }
    if (!READ_COMMANDS.has(base)) continue;
    for (const arg of name.rest) {
      if (arg.literal && arg.value.startsWith("-")) continue;
      const path = resolveWord(arg, state);
      if (path) paths.push(path);
    }
  }
}

/**
 * `sh -c "…"`, `bash -lc '…'`: the inline command, or null when the shell takes `-c` but the
 * command word is not literal. Undefined when the shell runs a file or nothing.
 */
function shellInlineCommand(args: WordToken[]): string | null | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.literal) return undefined;
    if (!arg.value.startsWith("-") || arg.value === "-" || arg.value === "--") return undefined;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg.value)) {
      const inline = args[index + 1];
      if (!inline) return undefined;
      return inline.literal ? inline.value : null;
    }
  }
  return undefined;
}

function interpreterScript(base: string, args: WordToken[]): WordToken | null {
  let index = 0;
  if (base === "deno" || base === "bun") {
    if (args[0]?.literal && args[0].value === "run") index = 1;
    else if (base === "deno") return null;
  }
  const valueOptions = INTERPRETER_VALUE_OPTIONS[base];
  for (; index < args.length; index++) {
    const arg = args[index];
    if (!arg.literal) return null;
    if (NO_SCRIPT_OPTIONS.has(arg.value)) return null;
    if (arg.value === "--") return args[index + 1] ?? null;
    if (arg.value.startsWith("-")) {
      if (valueOptions?.has(arg.value)) index++;
      continue;
    }
    return arg;
  }
  return null;
}

type WordToken = Extract<Token, { kind: "word" }>;

interface SimpleCommand {
  words: WordToken[];
  /** Output redirect targets of this command. */
  redirects: WordToken[];
  /** True when this command reads a pipe (`… | tee f`). */
  pipedFrom: boolean;
}

const COMMAND_SEPARATORS = new Set([";", "&", "&&", "||", "\n"]);
const PIPES = new Set(["|", "|&"]);

function splitCommands(tokens: Token[]): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [], pipedFrom: false };
  const flush = (pipedNext: boolean) => {
    if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
    current = { words: [], redirects: [], pipedFrom: pipedNext };
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind === "word") {
      current.words.push(token);
      continue;
    }
    if (COMMAND_SEPARATORS.has(token.value)) {
      flush(false);
      continue;
    }
    if (PIPES.has(token.value)) {
      flush(true);
      continue;
    }
    const target = tokens[index + 1];
    if (!target || target.kind !== "word") throw new Unparsable();
    index++;
    const redirect = /^(\d*|&)(>>?|>\||>&|<|<>|<&)$/.exec(token.value);
    if (!redirect) throw new Unparsable();
    const [, fd, op] = redirect;
    if (op === "<" || op === "<&" || op === "<>") continue;
    // `2>&1` duplicates a descriptor; `>& file` is `&> file`.
    if (op === ">&" && target.literal && /^(?:\d+-?|-)$/.test(target.value)) continue;
    if (fd !== "" && fd !== "&" && fd !== "1" && fd !== "2") continue;
    current.redirects.push(target);
  }
  flush(false);
  return commands;
}

/** The command word after `VAR=value` assignments and wrappers like `nohup` or `nice -n 5`. */
function commandName(words: WordToken[]): { word: WordToken; rest: WordToken[] } | null {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word.literal && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.value)) {
      index++;
      continue;
    }
    if (!word.literal) return { word, rest: words.slice(index + 1) };
    const base = basename(word.value);
    if (PREFIX_COMMANDS.has(base)) {
      index++;
      while (words[index]?.literal && words[index].value.startsWith("-")) index++;
      continue;
    }
    const valueOptions = PREFIX_WITH_VALUE[base];
    if (valueOptions) {
      index++;
      while (index < words.length) {
        const next = words[index];
        if (!next.literal) break;
        if (valueOptions.has(next.value)) {
          index += 2;
          continue;
        }
        if (next.value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(next.value)) {
          index++;
          continue;
        }
        break;
      }
      // `timeout 60 cmd`: the duration comes before the command.
      if (base === "timeout" && words[index]?.literal && /^\d/.test(words[index].value)) index++;
      continue;
    }
    return { word, rest: words.slice(index + 1) };
  }
  return null;
}

/** The folder after `cd <word>`; null when it cannot be known (`cd -`, `cd $DIR`). */
function changeDirectory(target: WordToken | undefined, state: WalkState): string | null {
  if (!target) return state.home;
  if (target.literal && target.value.startsWith("-")) return null;
  return resolveWord(target, state);
}

function resolveWord(word: WordToken, state: WalkState): string | null {
  if (!word.literal || word.value === "") return null;
  let value = word.value;
  if (word.tilde) {
    if (!state.home) return null;
    value = state.home + value.slice(1);
  }
  if (isAbsolute(value)) return normalize(value);
  if (!state.cwd) return null;
  return resolve(state.cwd, value);
}

function basename(value: string): string {
  const index = value.lastIndexOf("/");
  return index >= 0 ? value.slice(index + 1) : value;
}

const OPERATOR_START = /[|&;<>()\n]/;

/**
 * Splits a POSIX shell command into words and operators. Quotes and backslashes are removed;
 * a word holding `$`, a glob or a brace is kept but marked not literal. Command substitution,
 * subshells, here-docs and process substitution make the whole command unparsable.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = skipBlank(input, 0);
  while (index < input.length) {
    const char = input[index];
    if (char === "(" || char === ")" || char === "`") throw new Unparsable();
    const op = startsOperator(input, index) ? readOperator(input, index) : null;
    if (op) {
      if (op.value.startsWith("<<") || op.value.includes("(")) throw new Unparsable();
      tokens.push({ kind: "op", value: op.value });
      index = op.end;
    } else {
      const word = readWord(input, index);
      tokens.push(word.token);
      index = word.end;
    }
    index = skipBlank(input, index);
  }
  return tokens;
}

/** Past blanks, line continuations and comments. */
function skipBlank(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const char = input[index];
    if (char === " " || char === "\t" || char === "\r") index++;
    else if (char === "\\" && input[index + 1] === "\n") index += 2;
    else if (char === "#") {
      while (index < input.length && input[index] !== "\n") index++;
    } else break;
  }
  return index;
}

/** An operator starts here, or a redirect with its descriptor digits (`2>`). */
function startsOperator(input: string, index: number): boolean {
  if (OPERATOR_START.test(input[index])) return true;
  let end = index;
  while (/\d/.test(input[end] ?? "")) end++;
  return input[end] === "<" || input[end] === ">";
}

function readOperator(input: string, start: number): { value: string; end: number } | null {
  const rest = input.slice(start);
  const match =
    /^(?:\d*(?:>>|>\||>&|<<<|<<-?|<>|<&|>|<)|&>>|&>|<\(|>\(|\|&|\|\||&&|;;|[|&;\n])/.exec(rest);
  if (!match) return null;
  if (match[0] === ";;") throw new Unparsable();
  return { value: match[0], end: start + match[0].length };
}

function readWord(input: string, start: number): { token: WordToken; end: number } {
  const word = { value: "", literal: true };
  const tilde = input[start] === "~" && (input[start + 1] === "/" || input.length === start + 1);
  let index = start;
  while (index < input.length && !/[\s|&;<>()]/.test(input[index])) {
    const char = input[index];
    if (char === "'") index = readSingleQuoted(input, index, word);
    else if (char === '"') index = readDoubleQuoted(input, index, word);
    else if (char === "\\") {
      if (index + 1 >= input.length) throw new Unparsable();
      word.value += input[index + 1];
      index += 2;
    } else {
      if (char === "`" || (char === "$" && input[index + 1] === "(")) throw new Unparsable();
      if (UNQUOTED_EXPANSION.test(char) || (char === "~" && index !== start)) word.literal = false;
      word.value += char;
      index++;
    }
  }
  if (input[start] === "~" && !tilde) word.literal = false;
  return { token: { kind: "word", value: word.value, literal: word.literal, tilde }, end: index };
}

/** `$`, globs and braces expand when unquoted. */
const UNQUOTED_EXPANSION = /[$*?[\]{}]/;

interface WordBuffer {
  value: string;
  literal: boolean;
}

function readSingleQuoted(input: string, start: number, word: WordBuffer): number {
  const end = input.indexOf("'", start + 1);
  if (end < 0) throw new Unparsable();
  word.value += input.slice(start + 1, end);
  return end + 1;
}

function readDoubleQuoted(input: string, start: number, word: WordBuffer): number {
  let index = start + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === '"') return index + 1;
    if (char === "`" || (char === "$" && input[index + 1] === "(")) throw new Unparsable();
    if (char === "$") word.literal = false;
    if (char === "\\" && /["\\$`\n]/.test(input[index + 1] ?? "")) {
      word.value += input[index + 1];
      index += 2;
    } else {
      word.value += char;
      index++;
    }
  }
  throw new Unparsable();
}
