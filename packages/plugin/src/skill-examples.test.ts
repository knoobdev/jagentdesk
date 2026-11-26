import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// A Windows checkout writes CRLF line endings.
const skill = readFileSync(
  path.join(repository, "skills/jagentdesk-plugin/SKILL.md"),
  "utf8",
).replaceAll("\r\n", "\n");
const pluginRoot = path.join(repository, "plugin-examples/skill-example");

interface SkillExample {
  heading: string;
  files: Record<string, string>;
}

// Groups every ts and tsx block under its nearest heading. Each block starts with a `// <path>`
// comment that places it in a plugin, so the blocks of one heading form one plugin.
function skillExamples(): SkillExample[] {
  const examples: SkillExample[] = [];
  let heading = "";
  for (const match of skill.matchAll(/^(#{1,6}) (.+)$|^```(tsx?)\n([\s\S]*?)\n```$/gm)) {
    if (match[2]) {
      heading = match[2];
      continue;
    }
    const code = match[4] ?? "";
    const file = /^\/\/ ([\w./-]+\.tsx?)\n/.exec(code)?.[1];
    if (!file)
      throw new Error(`A ${match[3]} block under "${heading}" does not start with // <path>`);
    let example = examples.at(-1);
    if (example?.heading !== heading) {
      example = { heading, files: {} };
      examples.push(example);
    }
    if (example.files[file]) throw new Error(`"${heading}" has two blocks for ${file}`);
    example.files[file] = code;
  }
  return examples;
}

// Checks plugin files, keyed by path in the plugin, with the same options as the plugin examples.
function typeErrors(files: Record<string, string>): string[] {
  const configPath = path.join(repository, "packages/plugin/tsconfig.examples.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));
  const sources = new Map(
    Object.entries(files).map(([file, code]) => [path.join(pluginRoot, file), code]),
  );
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, language, ...rest) => {
    const code = sources.get(path.resolve(name));
    return code === undefined
      ? getSourceFile.call(host, name, language, ...rest)
      : ts.createSourceFile(name, code, language);
  };
  host.fileExists = (name) => sources.has(path.resolve(name)) || ts.sys.fileExists(name);
  host.directoryExists = (name) =>
    [...sources.keys()].some((file) => file.startsWith(`${path.resolve(name)}${path.sep}`)) ||
    ts.sys.directoryExists(name);
  const program = ts.createProgram([...sources.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("jagentdesk-plugin skill examples", () => {
  const examples = skillExamples();

  it("has examples", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(examples.map((example) => [example.heading, example.files] as const))(
    "%s typechecks against the plugin SDK",
    (_heading, files) => {
      expect(typeErrors(files)).toEqual([]);
    },
  );
});
