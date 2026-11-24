import { describe, it, expect } from "vitest";
import { measureMainThreadWork } from "../../../server/src/test-utils/main-thread-work.js";
import { setImmediate } from "node:timers/promises";
import { highlightCodeWithBudget, HIGHLIGHT_MAX_SOURCE_BYTES } from "../budgeted-highlighter.js";
import { highlightCode, highlightLine } from "../highlighter.js";

describe("highlightCode", () => {
  it("highlights JavaScript code with correct token styles", () => {
    const code = "const x = 42;";
    const result = highlightCode(code, "test.js");

    expect(result).toHaveLength(1);
    const tokens = result[0];
    expect(tokens.length).toBeGreaterThan(1);

    const keywordToken = tokens.find((t) => t.text === "const");
    expect(keywordToken?.style).toBe("keyword");

    const numberToken = tokens.find((t) => t.text === "42");
    expect(numberToken?.style).toBe("number");
  });

  it("highlights Python code", () => {
    const code = 'def hello():\n    print("world")';
    const result = highlightCode(code, "test.py");

    expect(result).toHaveLength(2);

    const defToken = result[0].find((t) => t.text === "def");
    expect(defToken?.style).toBe("keyword");

    const stringToken = result[1].find((t) => t.text.includes("world"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Swift code", () => {
    const code = 'struct Greeter {\n    let message = "hello"\n}';
    const result = highlightCode(code, "test.swift");

    expect(result).toHaveLength(3);

    const structToken = result[0].find((t) => t.text === "struct");
    expect(structToken?.style).toBe("keyword");

    const typeToken = result[0].find((t) => t.text === "Greeter");
    expect(typeToken?.style).toBe("definition");

    const stringToken = result[1].find((t) => t.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Dart code", () => {
    const code = 'class Greeter {\n  final String message = "hello";\n}';
    const result = highlightCode(code, "test.dart");

    expect(result).toHaveLength(3);

    const classToken = result[0].find((t) => t.text === "class");
    expect(classToken?.style).toBe("keyword");

    const finalToken = result[1].find((t) => t.text === "final");
    expect(finalToken?.style).toBe("keyword");

    const stringToken = result[1].find((t) => t.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights C# code", () => {
    const code = 'class Greeter {\n    string message = "hello";\n}';
    const result = highlightCode(code, "test.cs");

    expect(result).toHaveLength(3);

    const classToken = result[0].find((t) => t.text === "class");
    expect(classToken?.style).toBe("keyword");

    const stringToken = result[1].find((t) => t.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Nix code", () => {
    const code = 'let message = "hello"; in message';
    const result = highlightCode(code, "default.nix");

    const letToken = result[0].find((token) => token.text === "let");
    expect(letToken?.style).toBe("keyword");

    const stringToken = result[0].find((token) => token.text.includes("hello"));
    expect(stringToken?.style).toBe("string");
  });

  it("highlights Svelte components across script, markup, and style", () => {
    const code = [
      '<script lang="ts">',
      "  let count: number = 1;",
      "</script>",
      "",
      "{#if count > 0}",
      '  <span class="badge">{count}</span>',
      "{/if}",
      "",
      "<style>",
      "  .badge {",
      "    color: red;",
      "  }",
      "</style>",
    ].join("\n");
    const result = highlightCode(code, "Counter.svelte");

    expect(result[1].find((t) => t.text === "let")?.style).toBe("keyword");
    expect(result[1].find((t) => t.text === "number")?.style).toBe("type");

    expect(result[4].find((t) => t.text === "if")?.style).toBe("keyword");
    expect(result[4].find((t) => t.text === "count")?.style).toBe("variable");

    expect(result[5].find((t) => t.text === "span")?.style).toBe("tag");
    expect(result[5].find((t) => t.text === "class")?.style).toBe("attribute");
    expect(result[5].find((t) => t.text === "count")?.style).toBe("variable");

    expect(result[9].find((t) => t.text === "badge")?.style).toBe("class");
    expect(result[10].find((t) => t.text === "color")?.style).toBe("property");
  });

  it("highlights Astro components across frontmatter, markup, and style", () => {
    const code = `---
const title = "Hello";
---
<main class="page">
  <h1>{title}</h1>
</main>
<style>
  .page { color: red; }
</style>`;

    const tokens = highlightCode(code, "Page.astro").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "const", style: "keyword" },
        { text: '"Hello"', style: "string" },
        { text: "main", style: "tag" },
        { text: "class", style: "attribute" },
        { text: "title", style: "variable" },
        { text: "page", style: "class" },
        { text: "color", style: "property" },
      ]),
    );
  });

  it("highlights Astro markup containing only an empty expression", () => {
    const code = "<p>{}</p>";

    const tokens = highlightCode(code, "Empty.astro").flat();

    expect(tokens.map((token) => token.text).join("")).toBe(code);
    expect(tokens).toContainEqual({ text: "p", style: "tag" });
  });

  it.each([
    "<p>{title} {} {title}</p>",
    '<p class="{} {title}">{title}</p>',
    "<p class={} title={title}>{title}</p>",
  ])("highlights Astro containing an empty expression: %s", (markup) => {
    const code = `---\nconst title = "Hello";\n---\n${markup}\n<style>.page { color: red; }</style>`;

    const lines = highlightCode(code, "Empty.astro");

    expect(lines).toHaveLength(code.split("\n").length);
    for (const [index, tokens] of lines.entries()) {
      expect(tokens.map((token) => token.text).join("")).toBe(code.split("\n")[index]);
    }
    expect(lines.flat()).toContainEqual({ text: "const", style: "keyword" });
    expect(lines.flat()).toContainEqual({ text: "p", style: "tag" });
    expect(lines.flat()).toContainEqual({ text: "color", style: "property" });
    expect(lines.flat()).toContainEqual({ text: "title", style: "variable" });
  });

  it("keeps an Astro expression open through nested template strings", () => {
    const code = "<p>{`a ${`}`} b`}</p>";

    const tokens = highlightCode(code, "Nested.astro").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "`}`", style: "string" },
        { text: " b`", style: "string" },
      ]),
    );
  });

  it("highlights Vue SFCs across script, template, and style", () => {
    const code = [
      '<script lang="ts">',
      "  let count: number = 1;",
      "</script>",
      "",
      "<template>",
      '  <p v-if="count > 0" :class="badge">{{ { count: 1 } }}</p>',
      "  <span>{{ 'a}}b' }} {{ { inner: 2 }}}</span>",
      "</template>",
      "",
      "<style>",
      "  .badge {",
      "    color: red;",
      "  }",
      "</style>",
    ].join("\n");

    const tokens = highlightCode(code, "Counter.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "let", style: "keyword" },
        { text: "number", style: "type" },
        { text: "template", style: "tag" },
        { text: "v-if", style: "attribute" },
        { text: "count", style: "definition" },
        { text: "1", style: "number" },
        { text: "'a}}b'", style: "string" },
        { text: "inner", style: "definition" },
        { text: "2", style: "number" },
        { text: "badge", style: "class" },
        { text: "color", style: "property" },
      ]),
    );
  });

  it("highlights a Vue SFC that contains an empty interpolation", () => {
    const code = ["<template>", "  <p>{{}} {{ count }}</p>", "</template>"].join("\n");

    const tokens = highlightCode(code, "Empty.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "template", style: "tag" },
        { text: "count", style: "variable" },
      ]),
    );
  });

  it("highlights quoted Vue directive values as code", () => {
    const code = "<template><p v-if=\"count > 0\" :class='badge'>x</p></template>";

    const tokens = highlightCode(code, "Directive.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "count", style: "variable" },
        { text: "0", style: "number" },
        { text: "badge", style: "variable" },
      ]),
    );
    expect(tokens).not.toContainEqual({ text: '"count > 0"', style: "string" });
  });

  it("keeps a Vue interpolation open through nested template strings", () => {
    const code = "<template><p>{{ `a ${`}}`} b` }}</p></template>";

    const tokens = highlightCode(code, "Nested.vue").flat();

    expect(tokens).toEqual(
      expect.arrayContaining([
        { text: "`}}`", style: "string" },
        { text: " b`", style: "string" },
      ]),
    );
  });

  it("highlights TSX code with correct dialect", () => {
    const code = 'const el = <div className="test">hello</div>;';
    const result = highlightCode(code, "test.tsx");

    expect(result).toHaveLength(1);
    const tokens = result[0];

    const constToken = tokens.find((t) => t.text === "const");
    expect(constToken?.style).toBe("keyword");

    const tagToken = tokens.find((t) => t.text === "div");
    expect(tagToken).toBeDefined();
  });

  it("returns unhighlighted tokens for unsupported extensions", () => {
    const code = "hello world\nsecond line";
    const result = highlightCode(code, "test.xyz");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([{ text: "hello world", style: null }]);
    expect(result[1]).toEqual([{ text: "second line", style: null }]);
  });

  it("splits multi-line code into separate line arrays", () => {
    const code = "line1\nline2\nline3";
    const result = highlightCode(code, "test.txt");

    expect(result).toHaveLength(3);
  });

  it("handles empty lines", () => {
    const code = "const a = 1;\n\nconst b = 2;";
    const result = highlightCode(code, "test.js");

    expect(result).toHaveLength(3);
    expect(result[1]).toEqual([{ text: "", style: null }]);
  });

  it("returns a single empty line for empty input", () => {
    expect(highlightCode("", "test.ts")).toEqual([[{ text: "", style: null }]]);
  });

  it("returns valid HighlightStyle values for all tokens", () => {
    const validStyles = new Set([
      "keyword",
      "comment",
      "string",
      "number",
      "literal",
      "function",
      "definition",
      "class",
      "type",
      "tag",
      "attribute",
      "property",
      "variable",
      "operator",
      "punctuation",
      "regexp",
      "escape",
      "meta",
      "heading",
      "link",
      null,
    ]);

    const code = '// comment\nconst x: number = 42;\nfunction foo() { return "bar"; }';
    const result = highlightCode(code, "test.ts");

    for (const line of result) {
      for (const token of line) {
        expect(validStyles.has(token.style)).toBe(true);
      }
    }
  });
});

describe("highlightLine", () => {
  it("highlights a single line", () => {
    const tokens = highlightLine("const x = 1;", "test.js");

    expect(tokens.length).toBeGreaterThan(1);
    const keywordToken = tokens.find((t) => t.text === "const");
    expect(keywordToken?.style).toBe("keyword");
  });

  it("returns unhighlighted token for unsupported files", () => {
    const tokens = highlightLine("hello", "test.xyz");

    expect(tokens).toEqual([{ text: "hello", style: null }]);
  });
});

describe("highlightCodeWithBudget", () => {
  it("yields to IO while producing byte-identical output below the source budget", async () => {
    const code = "const value = Math.max(42, 7);\n".repeat(3_000);
    const expected = JSON.stringify(highlightCode(code, "file.ts"));
    const measured = await measureMainThreadWork("budgeted highlight", () =>
      highlightCodeWithBudget(code, "file.ts", { yieldToEventLoop: setImmediate }),
    );
    expect(measured.yields).toBeGreaterThan(1);
    expect(measured.blockingMs).toBeLessThan(50);
    expect(JSON.stringify(measured.result)).toBe(expected);
  });

  it("budgets UTF-8 bytes before parsing, including multibyte text", async () => {
    expect(
      await highlightCodeWithBudget("é".repeat(HIGHLIGHT_MAX_SOURCE_BYTES / 2 + 1), "file.ts", {
        yieldToEventLoop: setImmediate,
      }),
    ).toBeNull();
    expect(
      await highlightCodeWithBudget("a".repeat(HIGHLIGHT_MAX_SOURCE_BYTES + 1), "file.ts", {
        yieldToEventLoop: setImmediate,
      }),
    ).toBeNull();
  });

  it("stops a parser that is cancelled between real event-loop turns", async () => {
    const controller = new AbortController();
    const pending = highlightCodeWithBudget(
      "const value = Math.max(42, 7);\n".repeat(3_000),
      "file.ts",
      { yieldToEventLoop: setImmediate, signal: controller.signal },
    );
    await setImmediate();
    controller.abort();
    expect(await pending).toBeNull();
  });
});

import { getParserForFile } from "../parsers.js";
describe("Terraform", () => {
  function styleOf(line: HighlightToken[], text: string) {
    return line.find((token) => token.text === text)?.style;
  }

  it("highlights blocks, labels, attributes, and values", () => {
    const code = [
      "# The web server",
      'resource "aws_instance" "web" {',
      "  count   = 2",
      "  enabled = true",
      '  tags    = merge(var.labels, { Name = "web" })',
      "}",
    ].join("\n");
    const result = highlightCode(code, "main.tf");

    expect(result[0][0]).toEqual({ text: "# The web server", style: "comment" });
    expect(styleOf(result[1], "resource")).toBe("type");
    expect(styleOf(result[1], '"aws_instance"')).toBe("string");
    expect(styleOf(result[1], '"web"')).toBe("string");
    expect(styleOf(result[2], "count")).toBe("definition");
    expect(styleOf(result[2], "2")).toBe("number");
    expect(styleOf(result[3], "true")).toBe("literal");
    expect(styleOf(result[4], "merge")).toBe("function");
    expect(styleOf(result[4], "var")).toBe("variable");
    expect(styleOf(result[4], "labels")).toBe("property");
  });

  it("highlights expressions interpolated inside strings", () => {
    const result = highlightCode('name = "app-${var.env}-web"', "main.tf");

    expect(result[0].map((token) => [token.text, token.style])).toEqual([
      ["name", "definition"],
      [" ", null],
      ["=", "operator"],
      [" ", null],
      ['"app-', "string"],
      ["${", "punctuation"],
      ["var", "variable"],
      [".", "operator"],
      ["env", "property"],
      ["}", "punctuation"],
      ['-web"', "string"],
    ]);
  });

  it("highlights heredoc bodies as strings and resumes after the terminator", () => {
    const code = ["policy = <<-EOT", '  { "Version": "2012" }', "  EOT", "retries = 3"].join("\n");
    const result = highlightCode(code, "main.tf");

    expect(styleOf(result[0], "EOT")).toBe("keyword");
    expect(result[1].map((token) => token.style)).toEqual(["string"]);
    expect(styleOf(result[3], "retries")).toBe("definition");
    expect(styleOf(result[3], "3")).toBe("number");
  });

  it("ends a heredoc with a Unicode delimiter", () => {
    const result = highlightCode("x = <<ÉOF\nfoo\nÉOF\ny = 1", "main.tf");

    expect(styleOf(result[3], "y")).toBe("definition");
    expect(styleOf(result[3], "1")).toBe("number");
  });

  it.each([
    ['x = "$$${var.name}"', "$"],
    ['x = "%%%{ if true }"', "%"],
  ])("keeps escaped template text in %s as a string", (code) => {
    const line = highlightCode(code, "main.tf")[0];

    expect(line[line.length - 1]).toEqual({ text: code.slice(4), style: "string" });
  });

  it("parses a real configuration without error nodes", () => {
    const code = [
      "terraform {",
      '  required_version = ">= 1.5"',
      '  backend "s3" {}',
      "}",
      "",
      'variable "subnets" {',
      "  type    = map(object({ cidr = string }))",
      "  default = {}",
      "}",
      "",
      "locals {",
      "  names = [for key, subnet in var.subnets : upper(key) if subnet.cidr != null]",
      '  first = length(local.names) > 0 ? local.names[0] : "none"',
      "  arns  = aws_instance.web[*].arn",
      "  /* block comment */",
      "  path  = provider::time::rfc3339_parse(timestamp()) // trailing",
      "}",
      "",
      'data "aws_iam_policy_document" "assume" {',
      '  dynamic "statement" {',
      "    for_each = var.subnets",
      "    content {",
      '      sid = "${statement.key}-%{ if statement.value.cidr != "" }set%{ else }unset%{ endif }"',
      "    }",
      "  }",
      "}",
      "",
      'output "script" {',
      "  value = <<EOT",
      "#!/bin/sh",
      "echo ${local.first}",
      "EOT",
      "}",
    ].join("\n");

    const parser = getParserForFile("main.tf");
    if (!parser) throw new Error("Expected a parser for .tf files");
    const errors: number[] = [];
    parser.parse(code).iterate({
      enter(node) {
        if (node.type.isError) errors.push(node.from);
      },
    });

    expect(errors.map((from) => code.slice(from, from + 30))).toEqual([]);
  });

  it("uses the same grammar for tfvars and hcl files", () => {
    expect(highlightCode('region = "eu-west-1"', "prod.tfvars")).toEqual(
      highlightCode('region = "eu-west-1"', "terragrunt.hcl"),
    );
    expect(styleOf(highlightLine('region = "eu-west-1"', "prod.tfvars"), "region")).toBe(
      "definition",
    );
  });
});
