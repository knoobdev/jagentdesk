import { describe, expect, it } from "vitest";
import { adfToRichText, markdownToAdf } from "./adf.js";
import { markdownToWiki, wikiToRichText } from "./wiki.js";

describe("Markdown → ADF", () => {
  it("builds headings, marks, links, lists, code and tables", () => {
    const doc = markdownToAdf(
      [
        "## Goal",
        "",
        "Make **login** *fast* with `cache` and ~~old~~ [docs](https://docs.example.test/a).",
        "",
        "- one",
        "  - nested",
        "- two",
        "",
        "3. third",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "",
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(doc.content.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "codeBlock",
      "table",
    ]);
    expect(doc.content[1]?.content).toEqual([
      { type: "text", text: "Make " },
      { type: "text", text: "login", marks: [{ type: "strong" }] },
      { type: "text", text: " " },
      { type: "text", text: "fast", marks: [{ type: "em" }] },
      { type: "text", text: " with " },
      { type: "text", text: "cache", marks: [{ type: "code" }] },
      { type: "text", text: " and " },
      { type: "text", text: "old", marks: [{ type: "strike" }] },
      { type: "text", text: " " },
      {
        type: "text",
        text: "docs",
        marks: [{ type: "link", attrs: { href: "https://docs.example.test/a" } }],
      },
      { type: "text", text: "." },
    ]);
    expect(doc.content[3]?.attrs).toEqual({ order: 3 });
    expect(doc.content[4]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const a = 1;" }],
    });
  });

  it("turns jira-mention links into mention nodes", () => {
    const doc = markdownToAdf("ping [@Ada Lovelace](jira-mention:acc-123) please");
    expect(doc.content[0]?.content).toEqual([
      { type: "text", text: "ping " },
      { type: "mention", attrs: { id: "acc-123", text: "@Ada Lovelace" } },
      { type: "text", text: " please" },
    ]);
  });
});

describe("ADF → Markdown", () => {
  it("round-trips the Markdown it can represent and marks it editable", () => {
    const source = [
      "# Title",
      "",
      "Text with **bold**, *em*, `code` and [a link](https://site.test/x).",
      "",
      "- a",
      "- b",
      "",
      "> quoted",
      "",
      "---",
      "",
      "| H1 | H2 |",
      "| --- | --- |",
      "| c1 | c2 |",
      "",
      "Hi [@Grace](jira-mention:acc-9)",
    ].join("\n");
    const rich = adfToRichText(markdownToAdf(source));
    expect(rich).toEqual({ markdown: source, editable: true, unsupported: [] });
  });

  it("refuses editing for panels, macros, media and merged cells", () => {
    const rich = adfToRichText({
      version: 1,
      type: "doc",
      content: [
        {
          type: "panel",
          attrs: { panelType: "info" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Note" }] }],
        },
        { type: "extension", attrs: { extensionKey: "toc" } },
        { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", alt: "shot.png" } }] },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 2 },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "wide" }] }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(rich.editable).toBe(false);
    expect(rich.unsupported).toEqual(["complex table", "macro", "media", "panel"]);
    expect(rich.markdown).toContain("> Note");
    expect(rich.markdown).toContain("[attachment: shot.png]");
  });

  it("escapes plain text that would otherwise turn into Markdown", () => {
    const rich = adfToRichText({
      version: 1,
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "# not *a* heading" }] }],
    });
    expect(rich.markdown).toBe("\\# not \\*a\\* heading");
    expect(markdownToAdf(rich.markdown).content[0]?.content).toEqual([
      { type: "text", text: "# not *a* heading" },
    ]);
  });
});

describe("wiki markup (Data Center)", () => {
  it("renders headings, emphasis, mentions, links, code and tables as Markdown", () => {
    const rich = wikiToRichText(
      [
        "h2. Steps",
        "Run *fast* and _carefully_, see [the guide|https://wiki.test/g] and ping [~jdoe].",
        "* first",
        "** nested",
        "# numbered",
        "{code:java}",
        "int x = 1;",
        "{code}",
        "||Name||Value||",
        "|a|{{b}}|",
      ].join("\n"),
    );
    expect(rich).toEqual({
      markdown: [
        "## Steps",
        "",
        "Run **fast** and *carefully*, see [the guide](https://wiki.test/g) and ping [@jdoe](jira-mention:jdoe).",
        "",
        "- first\n  - nested\n1. numbered",
        "",
        "```java\nint x = 1;\n```",
        "",
        "| Name | Value |\n| --- | --- |\n| a | `b` |",
      ].join("\n"),
      editable: true,
      unsupported: [],
    });
  });

  it("keeps panels and colors readable but not editable", () => {
    const rich = wikiToRichText("{panel:title=Info}\nSecret plan\n{panel}\n{color:red}hot{color}");
    expect(rich.editable).toBe(false);
    expect(rich.unsupported).toEqual(["color", "panel"]);
    expect(rich.markdown).toBe("> Secret plan\n\nhot");
  });

  it("writes Markdown back as wiki markup", () => {
    expect(
      markdownToWiki(
        "## Done\n\nShipped **v2** with `flag` — see [PR](https://git.test/pr/1), thanks [@jdoe](jira-mention:jdoe).\n\n- a\n  - b\n\n```sh\nmake\n```",
      ),
    ).toBe(
      "h2. Done\n\nShipped *v2* with {{flag}} — see [PR|https://git.test/pr/1], thanks [~jdoe].\n\n* a\n** b\n\n{code:sh}\nmake\n{code}",
    );
  });
});
