import type { SpecKitCommand, SpecKitScriptVariant } from "./vendor.js";

/**
 * TypeScript port of spec-kit 1.3.0 template processing
 * (`IntegrationBase.process_template`, `src/specify_cli/integrations/base.py:905`) and of the
 * helpers it and `install_shared_infra` call. Behaviour must stay byte-identical to the CLI:
 * the fixture test compares the output with real `specify init` runs.
 */

export type InvokeSeparator = "." | "-";
export type InvocationPrefix = "/" | "$";

const DOLLAR_SKILLS_AGENTS = new Set(["codex", "zcode", "command-code"]);

/** `_invocation_style.get_invocation_prefix` for the agents JAgentDesk installs. */
export function invocationPrefixFor(agentKey: string, skillsMode: boolean): InvocationPrefix {
  return skillsMode && DOLLAR_SKILLS_AGENTS.has(agentKey) ? "$" : "/";
}

function splitLinesKeepEnds(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineEnding(line: string): string {
  if (line.endsWith("\r\n")) return "\r\n";
  return line.endsWith("\n") ? "\n" : "";
}

function stripLineEnding(line: string): string {
  return line.replace(/[\r\n]+$/, "");
}

function isPythonSpace(char: string): boolean {
  return char.length > 0 && /\s/.test(char);
}

/** Step 1: `scripts.<variant>` commands from the template frontmatter. */
function extractScriptCommands(content: string): Map<string, string> {
  const commands = new Map<string, string>();
  const pattern = /^\s*([A-Za-z0-9_-]+):\s*(.+)$/;
  let inFrontmatter = false;
  let inScripts = false;
  for (const line of splitLines(content)) {
    if (line === "---") {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (!inFrontmatter) continue;
    if (line === "scripts:") {
      inScripts = true;
      continue;
    }
    if (inScripts && line && !isPythonSpace(line[0] ?? "")) break;
    if (inScripts) {
      const match = pattern.exec(line);
      if (match?.[1] && match[2]) commands.set(match[1], match[2].trim());
    }
  }
  return commands;
}

function selectScriptVariant(requested: SpecKitScriptVariant, available: Map<string, string>) {
  if (available.has(requested)) return requested;
  const fallback = requested === "ps" ? ["ps", "sh"] : ["sh", "ps"];
  const found = fallback.find((variant) => available.has(variant));
  if (!found) {
    throw new Error(
      `No runnable script variant: requested ${requested}; available: ${[...available.keys()].sort().join(", ")}`,
    );
  }
  return found;
}

/** Step 3: drop the `scripts:` block (and anything indented under it) from the frontmatter. */
function stripScriptsSection(content: string): string {
  const output: string[] = [];
  let inFrontmatter = false;
  let skipSection = false;
  let dashCount = 0;
  for (const line of splitLinesKeepEnds(content)) {
    const stripped = stripLineEnding(line);
    if (stripped === "---") {
      dashCount += 1;
      inFrontmatter = dashCount === 1;
      skipSection = false;
      output.push(line);
      continue;
    }
    if (inFrontmatter) {
      if (stripped === "scripts:") {
        skipSection = true;
        continue;
      }
      if (skipSection) {
        if (isPythonSpace(line.slice(0, 1))) continue;
        skipSection = false;
      }
    }
    output.push(line);
  }
  return output.join("");
}

const PROJECT_PATH_PATTERN =
  /(?:(?<![.\p{L}\p{N}_])(?<parent>(?:\.\.\/){2,})|(?<boundary>^|[\s`"'([{<=])(?<rel>\.specify\/|(?:\.?\/))?)(?<target>scripts|memory|templates)\//gu;

/** Step 6: `CommandRegistrar.rewrite_project_relative_paths` (`agents.py:188`). */
export function rewriteProjectRelativePaths(text: string): string {
  return text.replace(PROJECT_PATH_PATTERN, (match, ...args: unknown[]) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const target = groups.target ?? "";
    if (groups.parent) return `.specify/${target}/`;
    const prefix = groups.boundary ?? "";
    if (groups.rel === ".specify/") return match;
    return `${prefix}.specify/${target}/`;
  });
}

/** Step 7: `IntegrationBase.resolve_command_refs`. */
export function resolveCommandRefs(
  content: string,
  separator: InvokeSeparator,
  prefix: InvocationPrefix,
): string {
  return content.replace(
    /__SPECKIT_COMMAND_([A-Z][A-Z0-9_-]*)__/g,
    (_match, name: string) =>
      `${prefix}speckit${separator}${name.toLowerCase().replaceAll("_", separator)}`,
  );
}

function formatSpeckitCommand(commandName: string, separator: string, prefix: string): string {
  let name = commandName.trim().replace(/^\/+/, "");
  if (name.startsWith("speckit.")) name = name.slice("speckit.".length);
  else if (name.startsWith("speckit-")) name = name.slice("speckit-".length);
  return `${prefix}speckit${separator}${name.replaceAll(".", separator)}`;
}

/** `shared_infra._resolve_dynamic_command_refs`: render the scripts' command-name helpers. */
export function resolveDynamicCommandRefs(
  content: string,
  separator: InvokeSeparator,
  prefix: InvocationPrefix,
): string {
  const bashPrefix = prefix === "$" ? "\\$" : prefix;
  const powershellPrefix = prefix === "$" ? "`$" : prefix;
  return content
    .replace(
      /\$\(\s*format_speckit_command\s+(['"]?)([A-Za-z0-9_.-]+)\1(?:\s+[^)]*)?\)/g,
      (_match, _quote: string, name: string) => formatSpeckitCommand(name, separator, bashPrefix),
    )
    .replace(
      /Format-SpecKitCommand\s+-CommandName\s+(['"])([A-Za-z0-9_.-]+)\1(?:\s+-RepoRoot\s+[^\r\n]+)?/g,
      (_match, _quote: string, name: string) =>
        `'${formatSpeckitCommand(name, separator, prefix)}'`,
    )
    .replace(
      /printf '\/speckit%s%s\\n' "\$separator" "\$command_name"/g,
      () => `printf '${prefix}speckit%s%s\\n' "$separator" "$command_name"`,
    )
    .replace(
      /return "\/speckit\$separator\$name"/g,
      () => `return "${powershellPrefix}speckit$separator$name"`,
    );
}

export interface ProcessTemplateOptions {
  agentKey: string;
  script: SpecKitScriptVariant;
  separator: InvokeSeparator;
  argPlaceholder?: string;
}

/** `IntegrationBase.process_template` (sh/ps variants; the py variant is not shipped). */
export function processTemplate(content: string, options: ProcessTemplateOptions): string {
  const commands = extractScriptCommands(content);
  let processed = content;
  if (commands.size > 0) {
    const variant = selectScriptVariant(options.script, commands);
    const scriptCommand = commands.get(variant) ?? "";
    if (scriptCommand) processed = processed.replaceAll("{SCRIPT}", scriptCommand);
  }
  processed = stripScriptsSection(processed);
  const placeholder = options.argPlaceholder ?? "$ARGUMENTS";
  processed = processed.replaceAll("{ARGS}", placeholder).replaceAll("$ARGUMENTS", placeholder);
  processed = processed.replaceAll("__AGENT__", options.agentKey);
  processed = rewriteProjectRelativePaths(processed);
  const prefix = invocationPrefixFor(options.agentKey, options.separator === "-");
  return resolveCommandRefs(processed, options.separator, prefix);
}

const YAML_ESCAPES: Record<string, string> = {
  "\0": "\\0",
  "\x07": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  "\x1b": "\\e",
  '"': '\\"',
  "\\": "\\\\",
  "\x85": "\\N",
  "\xa0": "\\_",
  " ": "\\L",
  " ": "\\P",
};

/** `base.yaml_quote`: PyYAML double-quoted scalar on one line (allow_unicode). */
export function yamlQuote(value: string): string {
  let out = "";
  for (const char of value) {
    const escape = YAML_ESCAPES[char];
    if (escape) {
      out += escape;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0xfeff) {
      out +=
        code <= 0xff
          ? `\\x${code.toString(16).padStart(2, "0").toUpperCase()}`
          : `\\u${code.toString(16).padStart(4, "0").toUpperCase()}`;
      continue;
    }
    out += char;
  }
  return `"${out}"`;
}

/** The plain `description:` scalar of a command template's frontmatter. */
export function templateDescription(raw: string): string {
  if (!raw.startsWith("---")) return "";
  const lines = splitLines(raw);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trimEnd() === "---") break;
    const match = /^description:\s*(.*)$/.exec(line);
    if (match) {
      const value = (match[1] ?? "").trim();
      if (/^["'|>]/.test(value)) {
        throw new Error("spec-kit template description is not a plain scalar");
      }
      return value;
    }
  }
  return "";
}

/** Body of a processed template after its frontmatter, keeping the text after the closing `---`. */
function bodyAfterFrontmatter(processed: string): string {
  if (!processed.startsWith("---")) return processed;
  const lines = splitLinesKeepEnds(processed);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trimEnd() === "---") return line.slice(3) + lines.slice(index + 1).join("");
  }
  return processed;
}

const HOOK_COMMAND_NOTE =
  "- When constructing command invocations from hook command names, replace dots (`.`) with hyphens (`-`). For example, `speckit.git.commit` → `/speckit-git-commit`.";

/** `SkillsIntegration._inject_hook_command_note`. */
function injectHookCommandNote(content: string, prefix: InvocationPrefix): string {
  const note =
    prefix === "/"
      ? HOOK_COMMAND_NOTE
      : HOOK_COMMAND_NOTE.replace("`/speckit-git-commit`", `\`${prefix}speckit-git-commit\``);
  const pattern =
    /^([ \t]*)(- For each executable hook, output the following[^\r\n]*)(\r\n|\n|$)/gm;
  return content.replace(
    pattern,
    (match, indent: string, instruction: string, eol: string, offset: number) => {
      const previous = splitLines(content.slice(0, offset));
      if (previous.length > 0 && previous[previous.length - 1] === indent + note) return match;
      const lineEnd = eol || "\n";
      return `${indent}${note}${lineEnd}${indent}${instruction}${lineEnd}`;
    },
  );
}

/** `ClaudeIntegration._inject_frontmatter_flag`: `key: value` before the closing `---`. */
function injectFrontmatterFlag(content: string, key: string, value = "true"): string {
  const lines = splitLinesKeepEnds(content);
  let dashCount = 0;
  for (const line of lines) {
    const stripped = stripLineEnding(line);
    if (stripped === "---") {
      dashCount += 1;
      if (dashCount === 2) break;
      continue;
    }
    if (dashCount === 1 && stripped.startsWith(`${key}:`)) return content;
  }
  const out: string[] = [];
  dashCount = 0;
  let injected = false;
  for (const line of lines) {
    if (stripLineEnding(line) === "---") {
      dashCount += 1;
      if (dashCount === 2 && !injected) {
        const eol = line.endsWith("\r\n") ? "\r\n" : "\n";
        out.push(`${key}: ${value}${eol}`);
        injected = true;
      }
    }
    out.push(line);
  }
  return out.join("");
}

/** `ClaudeIntegration.inject_argument_hint`: insert after the `description:` scalar. */
function injectArgumentHint(content: string, hint: string): string {
  const lines = splitLinesKeepEnds(content);
  let dashCount = 0;
  for (const line of lines) {
    const stripped = stripLineEnding(line);
    if (stripped === "---") {
      dashCount += 1;
      if (dashCount === 2) break;
      continue;
    }
    if (dashCount === 1 && stripped.startsWith("argument-hint:")) return content;
  }
  const out: string[] = [];
  let inFrontmatter = false;
  let injected = false;
  dashCount = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const stripped = stripLineEnding(line);
    if (stripped === "---") {
      dashCount += 1;
      inFrontmatter = dashCount === 1;
      out.push(line);
      index += 1;
      continue;
    }
    if (inFrontmatter && !injected && stripped.startsWith("description:")) {
      out.push(line);
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        const isContinuation =
          next.startsWith(" ") || next.startsWith("\t") || stripLineEnding(next) === "";
        if (!isContinuation) break;
        out.push(next);
        index += 1;
      }
      const eol = lineEnding(line);
      const escaped = hint.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      out.push(`argument-hint: "${escaped}"${eol}`);
      injected = true;
      continue;
    }
    out.push(line);
    index += 1;
  }
  return out.join("");
}

/** `claude/__init__.py` ARGUMENT_HINTS. */
const CLAUDE_ARGUMENT_HINTS: Partial<Record<SpecKitCommand, string>> = {
  specify: "Describe the feature you want to specify",
  plan: "Optional guidance for the planning phase",
  tasks: "Optional task generation constraints",
  implement: "Optional implementation guidance or task filter",
  analyze: "Optional focus areas for analysis",
  clarify: "Optional areas to clarify in the spec",
  constitution: "Principles or values for the project constitution",
  checklist: "Domain or focus area for the checklist",
};

export type SkillFlavor = "claude" | "copilot" | "plain";

export interface RenderSkillOptions {
  agentKey: string;
  command: SpecKitCommand;
  raw: string;
  script: SpecKitScriptVariant;
  flavor: SkillFlavor;
  /** `--no-model-invocation`: the skill runs only when invoked (ADR-0030 decision 2). */
  disableModelInvocation: boolean;
}

/** `SkillsIntegration.setup` + the integration's `post_process_skill_content` for one command. */
export function renderSkill(options: RenderSkillOptions): string {
  const skillName = `speckit-${options.command}`;
  const processed = processTemplate(options.raw, {
    agentKey: options.agentKey,
    script: options.script,
    separator: "-",
  });
  const description = templateDescription(options.raw) || `Spec Kit: ${options.command} workflow`;
  let content =
    `---\n` +
    `name: ${yamlQuote(skillName)}\n` +
    `description: ${yamlQuote(description)}\n` +
    `compatibility: ${yamlQuote("Requires spec-kit project structure with .specify/ directory")}\n` +
    `metadata:\n` +
    `  author: ${yamlQuote("github-spec-kit")}\n` +
    `  source: ${yamlQuote(`templates/commands/${options.command}.md`)}\n` +
    `---\n` +
    bodyAfterFrontmatter(processed);
  content = injectHookCommandNote(content, invocationPrefixFor(options.agentKey, true));
  if (options.flavor === "claude") {
    content = injectFrontmatterFlag(content, "user-invocable");
    content = injectFrontmatterFlag(
      content,
      "disable-model-invocation",
      options.disableModelInvocation ? "true" : "false",
    );
    const hint = CLAUDE_ARGUMENT_HINTS[options.command];
    if (hint) content = injectArgumentHint(content, hint);
  } else if (options.flavor === "copilot" && options.disableModelInvocation) {
    content = injectFrontmatterFlag(content, "disable-model-invocation");
  }
  return content.replaceAll("\r\n", "\n");
}

/** `MarkdownIntegration.setup` output for one command (`speckit.<command>.md`). */
export function renderMarkdownCommand(options: {
  agentKey: string;
  raw: string;
  script: SpecKitScriptVariant;
}): string {
  return processTemplate(options.raw, {
    agentKey: options.agentKey,
    script: options.script,
    separator: ".",
  }).replaceAll("\r\n", "\n");
}

/**
 * Python `json.dumps(value, indent=2)`: same layout as `JSON.stringify(value, null, 2)`, with
 * `ensure_ascii` escaping of non-ASCII characters.
 */
export function pythonJsonDump(value: unknown, options: { ensureAscii: boolean }): string {
  const json = JSON.stringify(value, null, 2);
  if (!options.ensureAscii) return json;
  return json.replace(
    /[\u0080-￿]/g,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

/** Python `json.dumps(..., sort_keys=True)` for a flat object. */
export function sortKeys<T extends Record<string, unknown>>(value: T): T {
  const sorted = Object.keys(value)
    .sort()
    .map((key) => [key, value[key]] as const);
  return Object.fromEntries(sorted) as T;
}

/** Python `datetime.now(timezone.utc).isoformat()`. */
export function pythonUtcIsoformat(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  const [seconds, fraction] = iso.slice(0, -1).split(".");
  const millis = Number.parseInt(fraction ?? "0", 10);
  return millis === 0
    ? `${seconds}+00:00`
    : `${seconds}.${String(millis * 1000).padStart(6, "0")}+00:00`;
}

/**
 * A command rendered as a chat prompt for providers without a command directory (generic ACP,
 * ADR-0030 decision 3): the `/speckit.*` markdown body with the user's text in place of
 * `$ARGUMENTS`, under a header line the app recognises for the "Spec mode · <phase>" label.
 */
export function renderPromptCommand(options: {
  command: SpecKitCommand;
  raw: string;
  script: SpecKitScriptVariant;
  args: string;
}): string {
  const body = bodyAfterFrontmatter(
    processTemplate(options.raw, {
      agentKey: "generic",
      script: options.script,
      separator: ".",
    }),
  ).replaceAll("$ARGUMENTS", () => options.args);
  return `Spec Kit command speckit.${options.command}\n${body.replaceAll("\r\n", "\n")}`;
}
