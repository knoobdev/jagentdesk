import { fromMarkdown } from "mdast-util-from-markdown";
import { toNativeLinkRecognition } from "react-native-enriched-markdown/src/utils/regexParser";
import { parseMarkdown } from "react-native-enriched-markdown/src/web/parseMarkdown";
import type { ASTNode } from "react-native-enriched-markdown/src/web/types";
import { QueryClient } from "@tanstack/react-query";
import { decodeMarkdownImage, getMarkdownImageStatus } from "./image-decoding";
import { describe, expect, it } from "vitest";
import { darkTheme, lightTheme } from "@/styles/theme";
import { createMarkdownStyles } from "./styles";
import { prepareMarkdownSource, PENDING_MARKDOWN_IMAGE } from "./source";
import { normalizeMarkdownHtml } from "./html";
import { splitStreamingMarkdown } from "./streaming";

describe("shared Markdown source adaptation", () => {
  it("keeps paragraphs, fences and quotes together for the library", () => {
    const source = "First paragraph.\n\nSecond paragraph.\n\n```ts\nconst n = 1;\n```\n\n> Quote";
    expect(prepareMarkdownSource(source).render()).toBe(source);
  });
  it("resolves workspace images without rewriting code or remote image URLs", () => {
    const source =
      "![Local](assets/a.png)\n\n![Remote](https://example.com/a.png)\n\n```md\n![Code](assets/a.png)\n```";
    const prepared = prepareMarkdownSource(source);
    expect(prepared.images.map((image) => image.source)).toEqual([
      "assets/a.png",
      "https://example.com/a.png",
    ]);
    expect(prepared.render(new Map([["assets/a.png", "blob:cached"]]))).toBe(
      "![Local](<blob:cached>)\n\n![Remote](https://example.com/a.png)\n\n```md\n![Code](assets/a.png)\n```",
    );
  });
  it("resolves reference images and images nested in lists and quotes", () => {
    const prepared = prepareMarkdownSource("> - ![Image][picture]\n\n[picture]: ../a.png");
    expect(prepared.render(new Map([["../a.png", "file:///cache/a.png"]]))).toBe(
      "> - ![Image](<file:///cache/a.png>)\n\n[picture]: ../a.png",
    );
  });
  it("escapes spoiler delimiters only in prose", () => {
    expect(prepareMarkdownSource("Show ||words|| and `||code||`.").render()).toBe(
      "Show \\|\\|words\\|\\| and `||code||`.",
    );
  });
});

it("preserves named and numeric entities as literal rendered text", () => {
  expect(prepareMarkdownSource("AT&amp;T &#x1F600; &#35; heading and `&amp;`").render()).toBe(
    "AT\\&T 😀 \\# heading and `&amp;`",
  );
});

it("preserves empty table cells while escaping spoilers in cell text", () => {
  const source = "| A || B |\n| --- | --- | --- |\n| x || z |";
  expect(prepareMarkdownSource(source).render()).toBe(
    "| A | | B |\n| --- | --- | --- |\n| x | | z |",
  );
});

it("renders a table directly after a paragraph through the library parser", async () => {
  const source = "**Notes**\n| Item | Detail |\n| --- | --- |\n| A | one |\n| B | two |";
  const separated = "**Notes**\n\n| Item | Detail |\n| --- | --- |\n| A | one |\n| B | two |";
  const flags = { hardSoftBreaks: true, latexMath: false };
  const expected = await parseMarkdown(separated, flags);
  expect(expected.children?.map((node) => node.type)).toEqual(["Paragraph", "Table"]);
  expect(await parseMarkdown(prepareMarkdownSource(source).render(), flags)).toEqual(expected);
});

it.each([
  [
    "a quote",
    "> Notes\n> | Item |\n> | --- |\n> | A |",
    "> Notes\n>\n> | Item |\n> | --- |\n> | A |",
    ["Document", ["Blockquote", "Paragraph", "Table"]],
  ],
  [
    "a list item",
    "- Notes\n  | Item |\n  | --- |\n  | A |\n- Next",
    "- Notes\n\n  | Item |\n  | --- |\n  | A |\n- Next",
    ["Document", ["UnorderedList", ["ListItem", "Paragraph", "Table"], ["ListItem", "Paragraph"]]],
  ],
  [
    "a quoted list item",
    "> - Notes\n>   | Item |\n>   | --- |\n>   | A |",
    "> - Notes\n>\n>   | Item |\n>   | --- |\n>   | A |",
    ["Document", ["Blockquote", ["UnorderedList", ["ListItem", "Paragraph", "Table"]]]],
  ],
  [
    "a quote inside a list item",
    "- > Notes\n  > | Item |\n  > | --- |\n  > | A |",
    "- > Notes\n  >\n  > | Item |\n  > | --- |\n  > | A |",
    ["Document", ["UnorderedList", ["ListItem", ["Blockquote", "Paragraph", "Table"]]]],
  ],
  [
    "aligned columns without outer pipes",
    "Notes\nItem | Detail\n:--- | ---:\nA | one",
    "Notes\n\nItem | Detail\n:--- | ---:\nA | one",
    ["Document", "Paragraph", "Table"],
  ],
  [
    "an entity at the start of a header without outer pipes",
    "Notes\nAT&amp;T | Detail\n--- | ---\nA | one",
    "Notes\n\nAT\\&T | Detail\n--- | ---\nA | one",
    ["Document", "Paragraph", "Table"],
  ],
  [
    "a local image at the start of a header without outer pipes",
    "Notes\n![Local](assets/a.png) | Detail\n--- | ---\nA | one",
    "Notes\n\nLocal | Detail\n--- | ---\nA | one",
    ["Document", "Paragraph", "Table"],
  ],
  [
    "CRLF lines",
    "Notes\r\n| Item |\r\n| --- |\r\n| A |",
    "Notes\r\n\r\n| Item |\r\n| --- |\r\n| A |",
    ["Document", "Paragraph", "Table"],
  ],
  [
    "CR lines",
    "Notes\r| Item |\r| --- |\r| A |",
    "Notes\r\r| Item |\r| --- |\r| A |",
    ["Document", "Paragraph", "Table"],
  ],
  [
    "a quote with CRLF lines",
    "> Notes\r\n> | Item |\r\n> | --- |\r\n> | A |",
    "> Notes\r\n>\r\n> | Item |\r\n> | --- |\r\n> | A |",
    ["Document", ["Blockquote", "Paragraph", "Table"]],
  ],
  [
    "a list item with CRLF lines",
    "- Notes\r\n  | Item |\r\n  | --- |\r\n  | A |\r\n- Next",
    "- Notes\r\n\r\n  | Item |\r\n  | --- |\r\n  | A |\r\n- Next",
    ["Document", ["UnorderedList", ["ListItem", "Paragraph", "Table"], ["ListItem", "Paragraph"]]],
  ],
  [
    "a quote with CR lines",
    "> Notes\r> | Item |\r> | --- |\r> | A |",
    "> Notes\r>\r> | Item |\r> | --- |\r> | A |",
    ["Document", ["Blockquote", "Paragraph", "Table"]],
  ],
  [
    "a list item with CR lines",
    "- Notes\r  | Item |\r  | --- |\r  | A |\r- Next",
    "- Notes\r\r  | Item |\r  | --- |\r  | A |\r- Next",
    ["Document", ["UnorderedList", ["ListItem", "Paragraph", "Table"], ["ListItem", "Paragraph"]]],
  ],
  [
    "a non-interrupting ordered marker with tildes",
    "Intro\n2. ~~~\n   Notes\n   | A |\n   | --- |\n   | x |",
    "Intro\n2. ~~~\n   Notes\n\n   | A |\n   | --- |\n   | x |",
    ["Document", "Paragraph", "Table"],
  ],
  [
    "a non-interrupting ordered marker with backticks",
    "Notes\n2. ```\n   | Item |\n   | --- |\n   | A |",
    "Notes\n2. ```\n\n   | Item |\n   | --- |\n   | A |",
    ["Document", "Paragraph", "Table"],
  ],
])("preserves tables after paragraphs in %s", async (_name, source, separated, expected) => {
  const rendered = prepareMarkdownSource(source).render();
  expect(rendered).toEqual(separated);
  const flags = { hardSoftBreaks: true, latexMath: false };
  function blocks(node: ASTNode): unknown {
    if (node.type === "Paragraph" || node.type === "Table") return node.type;
    return [node.type, ...(node.children ?? []).map(blocks)];
  }
  expect(blocks(await parseMarkdown(rendered, flags))).toEqual(expected);
});

it.each([
  [
    "a literal backslash",
    "Notes\\\n| Item |\n| --- |\n| A |",
    "Notes\\\n\n| Item |\n| --- |\n| A |",
    "Notes\\",
  ],
  [
    "an entity and literal backslash with LF lines",
    "AT&amp;T\\\n| Item |\n| --- |\n| A |",
    "AT\\&T\\\n\n| Item |\n| --- |\n| A |",
    "AT&T\\",
  ],
  [
    "an entity and literal backslash with CRLF lines",
    "AT&amp;T\\\r\n| Item |\r\n| --- |\r\n| A |",
    "AT\\&T\\\r\n\r\n| Item |\r\n| --- |\r\n| A |",
    "AT&T\\",
  ],
  [
    "an entity and literal backslash with CR lines",
    "AT&amp;T\\\r| Item |\r| --- |\r| A |",
    "AT\\&T\\\r\r| Item |\r| --- |\r| A |",
    "AT&T\\",
  ],
])(
  "preserves paragraph text before an interrupting table in %s",
  async (_name, source, separated, text) => {
    const rendered = prepareMarkdownSource(source).render();
    expect(rendered).toEqual(separated);
    const tree = await parseMarkdown(rendered, { hardSoftBreaks: true, latexMath: false });
    expect(tree.children?.map((node) => node.type)).toEqual(["Paragraph", "Table"]);
    expect(tree.children?.[0]?.children?.map((node) => node.content).join("")).toEqual(text);
  },
);

it.each([
  "```yaml\n---\nkey: value\n---\n```\n",
  "~~~md\n| Item |\n| --- |\n| A |\n~~~\n",
  "````md\n```\n| Item |\n| --- |\n```\n`````\n",
  "> ```md\n> | Item |\n> | --- |\n> ```\n",
  "> ```md\n> Code\n",
  "- ```md\n  Code\n",
  "    ```\n\n",
  "```not`a-fence\n",
])("renders a table after a fence without changing its code: %s", async (prefix) => {
  const table = "| Item |\n| --- |\n| A |";
  const rendered = prepareMarkdownSource(`${prefix}Notes\n${table}`).render();
  expect(rendered).toEqual(`${prefix}Notes\n\n${table}`);
  const tree = await parseMarkdown(rendered, { hardSoftBreaks: true, latexMath: false });
  expect(tree.children?.slice(-2).map((node) => node.type)).toEqual(["Paragraph", "Table"]);
});

it.each([
  "| Item | Detail |\n| --- | --- |\n" + "| A | one |\n".repeat(100),
  "Notes\n\n| Item | Detail |\n| --- | --- |\n" + "| A | one |\n".repeat(100),
  "Notes\n\n| Item |\n| --- |\n| A |",
  "| Item |\n| --- |\n| A |",
  "```md\nNotes\n| Item |\n| --- |\n| A |\n```",
  "```yaml\n---\nkey: value\n---\n```",
  "```yaml\n---\nkey: value",
  "~~~md\n| Item |\n| --- |\n| A |\n~~~",
  "````md\n```\n| Item |\n| --- |\n```\n````",
  "    Notes\n    | Item |\n    | --- |\n    | A |",
  "Notes\n| Item | Detail |\n| --- |\n| A |",
])("leaves separated tables and table-like text unchanged: %s", (source) => {
  expect(prepareMarkdownSource(source).render()).toEqual(source);
});

// The user's reply: a bold line directly above a table (2026-11-28 report).
const USER_TABLE_REPLY = [
  "**Câu chữ mới cần anh duyệt:**",
  "| Chỗ | Chữ |",
  "|---|---|",
  "| Pill khoá của workflow chạy tay | Activated — choose Deactivate in the ··· menu to edit. |",
  "| Run test khi còn việc chưa xong | Finish the items in the attention card first, then Run test. |",
  "| Deactivate workflow chạy tay | This stops the workflow and unlocks it for editing. |",
  "| Cột phụ trong Audit log | Ran an earlier version · A newer run exists |",
  "",
  "**Cần sửa phía backend (FE không làm được):**",
].join("\n");

it("renders the reported bold line and table as a paragraph and a table", async () => {
  const flags = { hardSoftBreaks: true, latexMath: false, admonitions: true };
  // MD4C alone keeps the header in the bold line's paragraph and prints the pipes.
  const raw = await parseMarkdown(USER_TABLE_REPLY, flags);
  expect(raw.children?.map((node) => node.type)).toEqual(["Paragraph", "Paragraph"]);
  const rendered = prepareMarkdownSource(USER_TABLE_REPLY).render();
  expect(rendered).toEqual(USER_TABLE_REPLY.replace("duyệt:**\n| Chỗ", "duyệt:**\n\n| Chỗ"));
  const tree = await parseMarkdown(rendered, flags);
  expect(tree.children?.map((node) => node.type)).toEqual(["Paragraph", "Table", "Paragraph"]);
  const table = tree.children?.[1];
  expect(table?.children?.flatMap((section) => section.children ?? []).length).toBe(5);
});

it.each([
  // Prose that merely contains pipes.
  "Use a | b to pipe\nand c | d too\nthen stop",
  "Notes\na | b\n---",
  "Notes\n| a | b | c |\n|---|---|\n| 1 | 2 | 3 |",
  "Notes\n| Item | Detail |\nnot a delimiter | row",
  // A table inside a fence stays code.
  "```md\n**Notes**\n| Item | Detail |\n|---|---|\n| A | one |\n```",
  // A partial table mid-stream: no delimiter row yet, or one too short for the header.
  "**Notes**\n| Item | Detail |",
  "**Notes**\n| Item | Detail |\n",
  "**Notes**\n| Item | Detail |\n|--",
  "**Notes**\n| Item | Detail |\n|---|",
])("leaves text without a complete GFM table after prose unchanged: %s", (source) => {
  expect(prepareMarkdownSource(source).render()).toEqual(source);
});

it("renders every streamed prefix of the reported reply without literal delimiter rows", async () => {
  const flags = { hardSoftBreaks: true, latexMath: false, admonitions: true };
  // As on GitHub, `|---|-` is the first prefix whose delimiter row has both columns.
  const delimiterEnd = USER_TABLE_REPLY.indexOf("|---|---|") + "|---|-".length;
  function text(node: ASTNode): string {
    return (node.content ?? "") + (node.children ?? []).map(text).join("");
  }
  for (let length = 1; length <= USER_TABLE_REPLY.length; length++) {
    const prefix = USER_TABLE_REPLY.slice(0, length);
    // Native streaming renders closed blocks and the mutable tail separately.
    const { head, tail } = splitStreamingMarkdown(prefix, true);
    const parts = await Promise.all(
      [head, tail]
        .filter(Boolean)
        .map((part) => parseMarkdown(prepareMarkdownSource(part).render(), flags)),
    );
    const blocks = parts.flatMap((tree) => tree.children ?? []);
    const tables = blocks.filter((node) => node.type === "Table");
    if (length < delimiterEnd) expect(tables, prefix).toEqual([]);
    if (length >= delimiterEnd) {
      expect(tables, prefix).toHaveLength(1);
      expect(blocks[0]?.type, prefix).toBe("Paragraph");
      expect(text(blocks[0]!), prefix).toBe("Câu chữ mới cần anh duyệt:");
    }
  }
});

it("separates a streaming table once its delimiter row matches the header", async () => {
  const source = "**Notes**\n| Item | Detail |\n|---|---|\n| A";
  const rendered = prepareMarkdownSource(source).render();
  expect(rendered).toEqual("**Notes**\n\n| Item | Detail |\n|---|---|\n| A");
  const tree = await parseMarkdown(rendered, { hardSoftBreaks: true, latexMath: false });
  expect(tree.children?.map((node) => node.type)).toEqual(["Paragraph", "Table"]);
});

it.each([
  "src/components/message.tsx",
  "C:\\repo\\file.ts",
  "docs/说明.md",
  "my%20file.ts",
  "src/file.ts:10-20",
  "src/file.ts(10,2)",
])("recognizes inline paths through the file resolver: %s", (path) => {
  const prepared = prepareMarkdownSource(`Open \`${path}\`.`);
  expect(prepared.linkRecognition.inlineCode?.test(path)).toBe(true);
  expect(prepared.linkSource(path, "inline-code")).toEqual({
    href: path,
    text: path,
    sourceType: "inline-code",
  });
});

it("recognizes bare Unicode filenames and preserves inline-code URLs", () => {
  const prepared = prepareMarkdownSource("Read 说明.md, or `https://example.com`.");
  expect([..."说明.md,".matchAll(prepared.linkRecognition.text)].map(([text]) => text)).toEqual([
    "说明.md",
  ]);
  expect(prepared.linkRecognition.inlineCode?.test("https://example.com")).toBe(true);
});

it("keeps explicit and inline-code links distinct when their URL strings match", () => {
  const url = "/tmp/my%20file.ts";
  const prepared = prepareMarkdownSource(`[open](${url}) and \`${url}\``);
  expect(prepared.linkSource(url, "markdown")).toEqual({ href: url, text: url });
  expect(prepared.linkSource(url, "inline-code")).toEqual({
    href: url,
    text: url,
    sourceType: "inline-code",
  });
});

it("extracts only Mermaid fences for the native diagram host", async () => {
  const { splitMermaidFences } = await import("./fence/mermaid/segments");
  const source =
    "First.\n\n```ts\nconst n = 1;\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n\n> Last.";
  expect(splitMermaidFences(source)).toEqual([
    { kind: "markdown", id: "0", source: "First.\n\n```ts\nconst n = 1;\n```\n\n" },
    { kind: "mermaid", id: "1", source: "graph TD\nA-->B" },
    { kind: "markdown", id: "2", source: "\n\n> Last." },
  ]);
  expect(splitMermaidFences("```md\n```mermaid\n```")).toEqual([
    { kind: "markdown", id: "0", source: "```md\n```mermaid\n```" },
  ]);
});

it("keeps reference links available across native Mermaid boundaries", async () => {
  const { splitMermaidFences } = await import("./fence/mermaid/segments");
  const parts = splitMermaidFences(
    "[Before][file]\n\n```mermaid\ngraph TD\nA-->B\n```\n\n[After][file]\n\n[file]: src/file.ts",
  );
  for (const part of parts.filter((candidate) => candidate.kind === "markdown"))
    expect(part.source).toContain("[file]: <src/file.ts>");
});

it("recognizes mixed-case Mermaid fence info and incomplete streaming fences", async () => {
  const { splitMermaidFences } = await import("./fence/mermaid/segments");
  expect(splitMermaidFences("```Mermaid title\ngraph TD\nA-->B")).toEqual([
    { kind: "mermaid", id: "0", source: "graph TD\nA-->B" },
  ]);
});

it("carries reference definitions nested in quotes across a diagram", async () => {
  const { splitMermaidFences } = await import("./fence/mermaid/segments");
  const parts = splitMermaidFences(
    "[open][file]\n\n```mermaid\ngraph TD\nA-->B\n```\n\n> [file]: src/file.ts",
  );
  expect(parts[0].source).toContain("[file]: <src/file.ts>");
});

it("keeps diagram identity when an earlier workspace image resolves", async () => {
  const { splitMermaidFences } = await import("./fence/mermaid/segments");
  const source = "![image](a.png)\n\n```mermaid\ngraph TD\nA-->B\n```";
  const before = splitMermaidFences(source).find((part) => part.kind === "mermaid");
  const after = splitMermaidFences(
    source.replace("a.png", "file:///long/cache/path/image.png"),
  ).find((part) => part.kind === "mermaid");
  expect(before).toHaveProperty("id");
  expect(after?.id).toBe(before?.id);
});

it("keeps workspace-relative hover titles on explicit absolute file links", () => {
  expect(prepareMarkdownSource("[Open](/repo/src/file.ts:42-45)", "/repo").render()).toBe(
    '[Open](/repo/src/file.ts:42-45 "src/file.ts:42-45")',
  );
});

it.each(['""', "''", "()"])("preserves an authored empty link title: %s", (title) => {
  const source = `[Open](/repo/file.ts ${title})`;
  expect(prepareMarkdownSource(source, "/repo").render()).toBe(source);
});

describe("shared Markdown theme colours", () => {
  it.each([
    ["dark", darkTheme],
    ["light", lightTheme],
  ] as const)("uses %s theme colours for tables and task labels", (_name, theme) => {
    const { markdownStyle: style } = createMarkdownStyles(theme);
    expect(style.table).toMatchObject({
      color: theme.colors.foreground,
      headerTextColor: theme.colors.foreground,
      headerBackgroundColor: theme.colors.surface2,
      rowEvenBackgroundColor: theme.colors.surface0,
      rowOddBackgroundColor: theme.colors.surface1,
      borderColor: theme.colors.border,
    });
    expect(style.list).toMatchObject({
      color: theme.colors.foreground,
      bulletColor: theme.colors.foregroundMuted,
      markerColor: theme.colors.foregroundMuted,
    });
    expect(style.h6?.color).toBe(theme.colors.foregroundMuted);
    expect(style.taskList).toMatchObject({
      checkedTextColor: theme.colors.foregroundMuted,
      checkedColor: theme.colors.accent,
      checkmarkColor: theme.colors.accentForeground,
      borderColor: theme.colors.foregroundMuted,
    });
  });
});

it.each([
  ["dark", darkTheme],
  ["light", lightTheme],
] as const)(
  "uses %s theme colours for quotes, admonitions, code, links and dividers",
  (_name, theme) => {
    const { markdownStyle: style } = createMarkdownStyles(theme);
    expect(style.blockquote).toMatchObject({
      color: `${theme.colors.foreground}cc`,
      backgroundColor: theme.colors.surface1,
      borderColor: theme.colors.surface2,
      admonitions: {
        note: { color: theme.colors.accentBright, backgroundColor: theme.colors.surface2 },
        tip: { color: theme.colors.statusSuccess, backgroundColor: theme.colors.surface2 },
        important: { color: theme.colors.statusMerged, backgroundColor: theme.colors.surface2 },
        warning: { color: theme.colors.statusWarning, backgroundColor: theme.colors.surface2 },
        caution: { color: theme.colors.statusDanger, backgroundColor: theme.colors.surface2 },
      },
    });
    expect(style.code).toMatchObject({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: "transparent",
    });
    expect(style.link?.color).toBe(theme.colors.accentBright);
    expect(style.linkVariants?.["^(?!https?://).+"]).toEqual({
      color: theme.colors.accentBright,
    });
    expect(style.thematicBreak?.color).toBe(theme.colors.border);
  },
);

it.each([darkTheme, lightTheme])("supplies the theme selection colour to the renderer", (theme) => {
  expect(createMarkdownStyles(theme)).toHaveProperty(
    "selectionColor",
    theme.colors.terminal.selectionBackground,
  );
});

describe("GitHub comment HTML normalization", () => {
  it.each([
    [
      '<img alt="P1" src="https://example.com/p1.svg" align="top">',
      "![P1](<https://example.com/p1.svg>)",
    ],
    ['<a href="https://example.com/review">▶</a>', "[▶](<https://example.com/review>)"],
    ["Before<br>After<br/>End", "Before  \nAfter  \nEnd"],
    ["<b>bold</b> and <strong>strong</strong>", "**bold** and **strong**"],
    ["<i>italic</i> and <em>emphasis</em>", "*italic* and *emphasis*"],
    ["Use <code>const n = 1</code>.", "Use `const n = 1`."],
    ["H<sub>2</sub>O and x<sup>2</sup>", "H2O and x2"],
    [
      "<details><summary>Review details</summary>Body **stays**.</details>",
      "**Review details**\n\nBody **stays**.",
    ],
    ["Before<!-- private -->After", "BeforeAfter"],
    [
      "<details><summary><h3>Important Files Changed</h3></summary>Body</details>",
      "**Important Files Changed**\n\nBody",
    ],
    [
      "<details><summary><p>First</p><p>Second</p></summary>Body</details>",
      "**First Second**\n\nBody",
    ],
    ["<span>file.</span>ts", "file.ts"],
    ['<a href="https://example.com">Git</a>Hub', "[Git](<https://example.com>)Hub"],
    ["<span>Git</span><span>Hub</span>", "GitHub"],
    ["<span>Git</span> Hub", "Git Hub"],
    ["<div><span>Keep the content</span></div>", "Keep the content"],
    [
      '<a href="https://example.com"><strong>Review</strong></a>',
      "[**Review**](<https://example.com>)",
    ],
    ['`<img src="literal.png">` and <b>bold</b>', '`<img src="literal.png">` and **bold**'],
    [
      '```html\n<img src="literal.png">\n```\n\n<b>bold</b>',
      '```html\n<img src="literal.png">\n```\n\n**bold**',
    ],
    ['~~~html\n<a href="literal">link</a>\n~~~', '~~~html\n<a href="literal">link</a>\n~~~'],
    [
      '<details><summary>Code</summary>\n\n```html\n<img src="literal.png">\n```\n</details>',
      '**Code**\n\n\n\n```html\n<img src="literal.png">\n```\n',
    ],
    [
      "<https://example.com> and <user@example.com>",
      "<https://example.com> and <user@example.com>",
    ],
  ])("normalizes %s without changing code", (source, expected) => {
    expect(prepareMarkdownSource(source).render()).toBe(expected);
  });
});

it("preserves backslashes and decodes entities inside HTML code", () => {
  const source = String.raw`<code>\*literal\* &lt;img&gt;</code>`;
  expect(prepareMarkdownSource(source).render()).toBe("`" + String.raw`\*literal\* <img>` + "`");
});

it.each([false, true])(
  "caps inline images to the paragraph line height (compact: %s)",
  (compact) => {
    const { markdownStyle } = createMarkdownStyles(darkTheme, compact);
    expect(markdownStyle.inlineImage?.size).toBe(markdownStyle.paragraph?.lineHeight);
  },
);

it("shows native SVG badges as alt text without reserving an image box", () => {
  const source = "![P1](https://example.com/p1.svg?v=9) **Finding**";
  const prepared = prepareMarkdownSource(source, undefined, { supportsSvg: false });
  expect(prepared.render()).toBe("P1 **Finding**");
  expect(prepared.images).toEqual([]);
});

it("collapses images that fail to load or decode to their alt text", () => {
  const prepared = prepareMarkdownSource(
    "![Remote](https://example.com/broken.png) and ![Local](broken.png)",
  );
  expect(
    prepared.render(
      new Map([["broken.png", "file:///broken.png"]]),
      new Set(["https://example.com/broken.png", "broken.png"]),
    ),
  ).toBe("Remote and Local");
});

it("preserves angle-bracket image destinations and authored link titles during HTML normalization", () => {
  const prepared = prepareMarkdownSource(
    '![shot](<my file.png>) and [open](<my file.png> "<b>literal title</b>")',
  );
  expect(prepared.images.map((image) => image.source)).toEqual(["my file.png"]);
  expect(prepared.render(new Map([["my file.png", "blob:shot"]]))).toBe(
    '![shot](<blob:shot>) and [open](<my file.png> "<b>literal title</b>")',
  );
});

it("uses the first repeated image reference definition", () => {
  const source = "![chart][image]\n\n[image]: first.png\n[image]: second.png";
  const prepared = prepareMarkdownSource(source);
  expect(prepared.images.map((image) => image.source)).toEqual(["first.png"]);
  expect(prepared.render(new Map([["first.png", "blob:first"]]))).toBe(
    "![chart](<blob:first>)\n\n[image]: first.png\n[image]: second.png",
  );
});

it("preserves authored adjacency in the Greptile header", () => {
  const source =
    '<h2><a href="https://app.greptile.com/api/retrigger?id=81261069"><picture><source media="(prefers-color-scheme: dark)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/RetriggerDark.svg?v=2"><source media="(prefers-color-scheme: light)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/Retrigger.svg?v=2"><img alt="Retrigger" src="https://greptile-static-assets.s3.amazonaws.com/badges/Retrigger.svg?v=2" align="right"></picture></a><a href="https://app.greptile.com/jagentdesk/github/jagentdesk/jagentdesk/-/pull/6973"><picture><source media="(prefers-color-scheme: dark)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/ViewInGreptileDark.svg?v=2"><source media="(prefers-color-scheme: light)" srcset="https://greptile-static-assets.s3.amazonaws.com/badges/ViewInGreptile.svg?v=2"><img alt="View in Greptile" src="https://greptile-static-assets.s3.amazonaws.com/badges/ViewInGreptile.svg?v=2" align="right"></picture></a>Confidence Score: 2/5</h2>';
  const rendered = prepareMarkdownSource(source, undefined, { supportsSvg: false }).render();
  expect(rendered).toContain(
    "[Retrigger](<https://app.greptile.com/api/retrigger?id=81261069>)[View in Greptile]",
  );
  expect(rendered).toContain(")Confidence Score: 2/5");
});

it("keeps paragraph, heading and table-row boundaries when stripping HTML", () => {
  const source =
    "<div>First</div><p>Second<br>line</p><h3>Heading</h3><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>";
  const rendered = prepareMarkdownSource(source).render();
  expect(rendered).toBe("First\n\nSecond  \nline\n\nHeading\n\nA B\n\nC D");
});

it("normalizes images following HTML code in the same HTML block", () => {
  const prepared = prepareMarkdownSource('<code>\nx\n</code>\n<img src="shot.png">');
  expect(prepared.images.map((image) => image.source)).toEqual(["shot.png"]);
  expect(prepared.render(new Map([["shot.png", "blob:shot"]]))).toContain("![](<blob:shot>)");
  expect(prepared.render()).toContain("`\nx\n`");
});

it("preserves literal Markdown punctuation in unsupported and failed image labels", () => {
  const label = String.raw`\*literal\* \[label\]`;
  expect(
    prepareMarkdownSource(`![${label}](badge.svg)`, undefined, { supportsSvg: false }).render(),
  ).toBe(label);
  expect(
    prepareMarkdownSource(`![${label}](https://example.com/badge.png)`).render(
      new Map(),
      new Set(["https://example.com/badge.png"]),
    ),
  ).toBe(label);
});

it("retries transient image decoding failures instead of caching an unavailable image", async () => {
  const client = new QueryClient();
  let attempts = 0;
  const decoded = await client.fetchQuery({
    queryKey: ["markdownImageDecode", "transient.png"],
    retry: 1,
    retryDelay: 0,
    queryFn: () =>
      decodeMarkdownImage("transient.png", (_uri, success, failure) => {
        attempts += 1;
        if (attempts === 1) failure(new Error("temporarily unavailable"));
        else success(20, 20);
      }),
  });
  expect(decoded).toBe(true);
  expect(attempts).toBe(2);
  client.clear();
});

it("keeps the document's first reference definition across every native Mermaid segment", async () => {
  const { splitMermaidFences } = await import("./fence/mermaid/segments");
  const before = '[first]: /repo/first.ts "Original"\n\n';
  const after = '\n\n[open][first]\n\n[first]: /repo/second.ts "Later"';
  const source = `${before}\`\`\`mermaid\ngraph TD\nA-->B\n\`\`\`${after}`;
  const firstDefinition = (markdown: string) =>
    fromMarkdown(markdown).children.find((node) => node.type === "definition");
  const canonical = firstDefinition(source);
  const segments = splitMermaidFences(source);
  for (const segment of segments.filter((candidate) => candidate.kind === "markdown")) {
    expect(firstDefinition(segment.source)).toMatchObject({
      identifier: canonical?.identifier,
      url: canonical?.url,
      title: canonical?.title,
    });
  }
  expect(segments[0].source.endsWith(before)).toBe(true);
  expect(segments[2].source.endsWith(after)).toBe(true);
  expect(segments[1]).toEqual({ kind: "mermaid", id: "1", source: "graph TD\nA-->B" });
});

it("reserves pending image geometry until decode succeeds and collapses only confirmed failures", () => {
  const source = "![Local](shot.png)\n\n![Remote](https://example.com/image.png)";
  const prepared = prepareMarkdownSource(source);
  const pending = prepared.render(
    new Map(),
    new Set(),
    new Set(prepared.images.map((image) => image.source)),
  );
  expect(pending.match(/!\[/g)).toHaveLength(2);
  expect(pending).toContain("data:image/png;base64,");
  expect(prepared.render(new Map(), new Set(prepared.images.map((image) => image.source)))).toBe(
    "Local\n\nRemote",
  );
});

it("normalizes a large HTML table into one block per row", () => {
  const cell = "cell".repeat(8);
  const rows = 8000;
  const source = `<table>${`<tr><td>${cell}</td><td>${cell}</td></tr>`.repeat(rows)}</table>`;
  const rendered = normalizeMarkdownHtml(source);
  expect(rendered.split("\n\n")).toHaveLength(rows);
  expect(rendered.startsWith(`${cell} ${cell}`)).toBe(true);
  expect(rendered.endsWith(`${cell} ${cell}`)).toBe(true);
});

it.each([
  "3/4",
  "1.5",
  "v1.2",
  "10/10",
  "2024/10/16",
  "10.0.0.1",
  "word.word",
  "example.com",
  "file.tsxextra",
  "v1.2.3-beta",
  "123/456.789",
  "×/÷",
  "２０２４/１０/１６",
])("leaves non-path tokens unlinked in prose and inline code: %s", (token) => {
  const { linkRecognition } = prepareMarkdownSource(`Value ${token}, then continue.`);
  expect([...`Value ${token}, then continue.`.matchAll(linkRecognition.text)]).toEqual([]);
  expect(linkRecognition.inlineCode.test(token)).toBe(false);
});

it.each([
  "src/index.ts",
  "README.md",
  "./scripts/run",
  "./x/y",
  "../x/y",
  "/x/y",
  "a/b/c",
  String.raw`C:\Users\x`,
  "src/index.ts:12:3",
  "src/run:12",
  "src/run:12:3",
  "src/run:12-20",
  "~/dev/jagentdesk",
  String.raw`C:\Users\x\file.txt`,
  "file.ts:12",
  "file.ts:12-20",
  "123.ts",
  "FILE.TS",
  "https://example.com/path",
])("recognizes complete paths and URLs in prose and inline code: %s", (token) => {
  const { linkRecognition } = prepareMarkdownSource(`Open ${token} then continue.`);
  expect(
    [...`Open ${token} then continue.`.matchAll(linkRecognition.text)].map(([text]) => text),
  ).toEqual([token]);
  expect(linkRecognition.inlineCode.test(token)).toBe(true);
});

it.each([
  "before/after",
  "and/or",
  "input/output",
  "read/write",
  "packages/app",
  "123/file",
  "src/123",
])("requires stronger path intent in prose while preserving inline code: %s", (token) => {
  const { linkRecognition } = prepareMarkdownSource(`Compare ${token}, then continue.`);
  expect([...`Compare ${token}, then continue.`.matchAll(linkRecognition.text)]).toEqual([]);
  expect(linkRecognition.inlineCode.test(token)).toBe(true);
});

it("keeps prose and inline-code recognition enabled through the native regex adapter", () => {
  const { linkRecognition } = prepareMarkdownSource("3/4 src/index.ts");
  const native = toNativeLinkRecognition(linkRecognition);
  expect(native.text).toMatchObject({
    pattern: linkRecognition.text.source,
    isDisabled: false,
    isDefault: false,
  });
  expect(native.inlineCode).toMatchObject({
    pattern: linkRecognition.inlineCode.source,
    isDisabled: false,
    isDefault: false,
  });
});

it.each([undefined, "file:///cache/shot.png"])(
  "reserves a native workspace image while acquiring or decoding %s",
  (url) => {
    const status = getMarkdownImageStatus({
      canAcquire: true,
      url,
      acquisitionFailed: false,
      decodeFailed: false,
      decoded: false,
    });
    expect(status).toBe("pending");
    const prepared = prepareMarkdownSource("Before ![image](shot.png) after", undefined, {
      supportsSvg: false,
    });
    const rendered = prepared.render(new Map(), new Set(), new Set(["shot.png"]));
    expect(rendered).toBe(`Before ![image](<${PENDING_MARKDOWN_IMAGE}>) after`);
    expect(fromMarkdown(rendered).children).toMatchObject([
      {
        type: "paragraph",
        children: [
          { type: "text", value: "Before " },
          { type: "image", url: PENDING_MARKDOWN_IMAGE },
          { type: "text", value: " after" },
        ],
      },
    ]);
  },
);

it.each([
  { acquisitionFailed: true, decodeFailed: false },
  { acquisitionFailed: false, decodeFailed: true },
])("collapses confirmed native image failures to alt text: %s", (failure) => {
  expect(
    getMarkdownImageStatus({
      canAcquire: true,
      url: "file:///cache/shot.png",
      decoded: false,
      ...failure,
    }),
  ).toBe("unavailable");
  const prepared = prepareMarkdownSource("Before ![image](shot.png) after", undefined, {
    supportsSvg: false,
  });
  expect(prepared.render(new Map(), new Set(["shot.png"]), new Set(["shot.png"]))).toBe(
    "Before image after",
  );
});

it("replaces the native placeholder only after the resolved URL decodes", () => {
  const url = "file:///cache/shot.png";
  expect(
    getMarkdownImageStatus({
      canAcquire: true,
      url,
      acquisitionFailed: false,
      decodeFailed: false,
      decoded: true,
    }),
  ).toBe("ready");
  const prepared = prepareMarkdownSource("![image](shot.png)", undefined, { supportsSvg: false });
  expect(prepared.render(new Map([["shot.png", url]]))).toBe(`![image](<${url}>)`);
});
