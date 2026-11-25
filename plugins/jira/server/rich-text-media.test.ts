import { describe, expect, it } from "vitest";
import { adfToRichText } from "./adf.js";
import { attachmentMarkdown, type RichTextAttachment } from "./markdown-tokens.js";
import { wikiToRichText } from "./wiki.js";

// Smart links and attachments inside rich text (spec 29.3 Issue, 29.7 #9): links come out as
// Markdown links (never `<url>`, which renderers read as an HTML tag), and media point at the
// issue's attachments through `jira-attachment:<id>` so the app loads bytes via the daemon.

const ATTACHMENTS: RichTextAttachment[] = [
  { id: "30002", filename: "image-20260812-044924.png", mimeType: "image/png", created_ms: 2 },
  { id: "30003", filename: "release-notes.txt", mimeType: "text/plain", created_ms: 2 },
  // An older upload with the same name: the newest wins.
  { id: "29999", filename: "image-20260812-044924.png", mimeType: "image/png", created_ms: 1 },
];

const URL = "https://stg.app.test/chat/2078b414-5c1d-4f7e-9a10-3b2c4d5e6f70";

describe("ADF smart links", () => {
  it("emits inline, block and embed cards as [url](url)", () => {
    const rich = adfToRichText({
      version: 1,
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Link: " },
            { type: "inlineCard", attrs: { url: URL } },
          ],
        },
        { type: "blockCard", attrs: { url: "https://git.test/shop/pull/7" } },
        { type: "embedCard", attrs: { url: "https://docs.app.test/a b(1)", layout: "wide" } },
        {
          type: "paragraph",
          content: [{ type: "inlineCard", attrs: { data: { url: "https://data.app.test/x" } } }],
        },
      ],
    });
    expect(rich.markdown).toBe(
      [
        `Link: [${URL}](${URL})`,
        "[https://git.test/shop/pull/7](https://git.test/shop/pull/7)",
        "[https://docs.app.test/a b(1)](https://docs.app.test/a%20b%281%29)",
        "[https://data.app.test/x](https://data.app.test/x)",
      ].join("\n\n"),
    );
    expect(rich.markdown).not.toMatch(/<https?:/);
  });
});

describe("ADF media → issue attachments", () => {
  const doc = {
    version: 1,
    type: "doc",
    content: [
      {
        type: "mediaSingle",
        attrs: { layout: "center" },
        content: [
          {
            type: "media",
            attrs: {
              id: "6a1f0c2e-8d3b-4e59-9b7a-1c2d3e4f5a6b",
              type: "file",
              collection: "",
              alt: "image-20260812-044924.png",
            },
          },
          { type: "caption", content: [{ type: "text", text: "Totals off by one cent" }] },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Notes: " },
          {
            type: "mediaInline",
            attrs: { id: "0b9e", type: "file", collection: "", alt: "release-notes.txt" },
          },
        ],
      },
      {
        type: "mediaGroup",
        content: [
          { type: "media", attrs: { id: "ffff", type: "file", collection: "", alt: "gone.pdf" } },
          {
            type: "media",
            attrs: { type: "external", url: "https://img.app.test/logo.png", alt: "logo" },
          },
        ],
      },
    ],
  };

  it("maps media by file name to jira-attachment references (newest of equal names)", () => {
    const rich = adfToRichText(doc, ATTACHMENTS);
    expect(rich.markdown).toBe(
      [
        "![image-20260812-044924.png](jira-attachment:30002)",
        "*Totals off by one cent*",
        "Notes: [release-notes.txt](jira-attachment:30003)",
        "[attachment: gone.pdf]",
        "![logo](https://img.app.test/logo.png)",
      ].join("\n\n"),
    );
    // Media cannot be written back from Markdown: the text stays read-only.
    expect(rich.editable).toBe(false);
    expect(rich.unsupported).toContain("media");
  });

  it("falls back to the label without an attachment list", () => {
    expect(adfToRichText(doc).markdown).toContain("[attachment: image-20260812-044924.png]");
  });

  it("matches names case-insensitively only when no exact name exists", () => {
    expect(attachmentMarkdown("IMAGE-20260812-044924.PNG", ATTACHMENTS)).toBe(
      "![image-20260812-044924.png](jira-attachment:30002)",
    );
    expect(attachmentMarkdown("missing.png", ATTACHMENTS)).toBeNull();
    expect(attachmentMarkdown("", ATTACHMENTS)).toBeNull();
  });
});

describe("wiki markup links and attachments (Data Center)", () => {
  it("renders bare [url] and [text|url] as Markdown links, never <url>", () => {
    const rich = wikiToRichText(`Link: [${URL}] or [the chat|${URL}]`);
    expect(rich.markdown).toBe(`Link: [${URL}](${URL}) or [the chat](${URL})`);
    expect(rich.editable).toBe(true);
  });

  it("maps !image!, !image|thumbnail!, [^file] and [label|^file] to attachments", () => {
    const rich = wikiToRichText(
      [
        "!image-20260812-044924.png|thumbnail!",
        "",
        "Notes: [^release-notes.txt] and [the notes|^release-notes.txt]",
        "",
        "!missing.png! !https://img.app.test/logo.png!",
      ].join("\n"),
      ATTACHMENTS,
    );
    expect(rich.markdown).toBe(
      [
        "![image-20260812-044924.png](jira-attachment:30002)",
        "Notes: [release-notes.txt](jira-attachment:30003) and [the notes](jira-attachment:30003)",
        "[attachment: missing.png] ![](https://img.app.test/logo.png)",
      ].join("\n\n"),
    );
    expect(rich.editable).toBe(false);
  });

  it("leaves bare URLs in text as text for the renderer to linkify", () => {
    expect(wikiToRichText("Logs at https://logs.app.test/run/42").markdown).toBe(
      "Logs at https://logs.app.test/run/42",
    );
  });
});
