import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { attachmentIdOf } from "./rich-text";

// What the Jira renderer (jira-markdown.tsx: markdown-it with linkify, no HTML pass) makes of the
// Markdown the daemon sends for smart links, bare URLs and attachments.

const parser = new MarkdownIt({ typographer: false, linkify: true });

function inlineTokens(markdown: string) {
  return parser.parse(markdown, {}).flatMap((token) => token.children ?? []);
}

describe("Jira rich text in the app", () => {
  it("reads jira-attachment ids and nothing else", () => {
    expect(attachmentIdOf("jira-attachment:30002")).toBe("30002");
    expect(attachmentIdOf("jira-attachment:")).toBeNull();
    expect(attachmentIdOf("jira-mention:acc-1")).toBeNull();
    expect(attachmentIdOf("https://stg.app.test/x")).toBeNull();
    expect(attachmentIdOf("jira-attachment:%E0%A4%A")).toBeNull();
  });

  it("renders a smart link as a link to the https URL", () => {
    const url = "https://stg.app.test/chat/2078b414-5c1d-4f7e-9a10-3b2c4d5e6f70";
    const tokens = inlineTokens(`Link: [${url}](${url})`);
    const open = tokens.find((t) => t.type === "link_open");
    expect(open?.attrGet("href")).toBe(url);
    expect(tokens.map((t) => t.content).join("")).toContain(url);
  });

  it("linkifies bare URLs, escaped underscores included", () => {
    const tokens = inlineTokens("Logs at https://logs.app.test/run\\_42/a\\_b");
    const open = tokens.find((t) => t.type === "link_open");
    expect(open?.attrGet("href")).toBe("https://logs.app.test/run_42/a_b");
  });

  it("keeps jira-attachment images and links (markdown-it's link validation allows the scheme)", () => {
    const tokens = inlineTokens(
      "![image-20260812-044924.png](jira-attachment:30002) [release-notes.txt](jira-attachment:30003)",
    );
    expect(tokens.find((t) => t.type === "image")?.attrGet("src")).toBe("jira-attachment:30002");
    expect(tokens.find((t) => t.type === "link_open")?.attrGet("href")).toBe(
      "jira-attachment:30003",
    );
  });
});
