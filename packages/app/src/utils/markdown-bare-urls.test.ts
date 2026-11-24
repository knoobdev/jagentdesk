import { describe, expect, it } from "vitest";
import { createAssistantMarkdownParser } from "./assistant-markdown-parser";

const parser = createAssistantMarkdownParser();
parser.options.typographer = false;
describe("bare URL sentence punctuation (Paseo #7859)", () => {
  it.each([
    ["http://127.0.0.1:8059/?token=t-1", ""],
    ["http://example.com:8080/a", "."],
    ["http://localhost:8059/?token=t-1", "."],
    ["http://localhost:8059/?token=t-1", ")"],
    ["http://user@127.0.0.1:8059/?token=t-1", '"'],
    ["http://user:pass@127.0.0.1:8059/?token=t-1", ""],
    ["http://localhost", ":"],
    ["http://[::1]:8059/?token=t-1", "'"],
    ["https://github.com/o/r/compare/main...user:repo:fix/branch", ""],
    ["https://example.com/a:b/c", ":"],
  ])("links %s whole and leaves %j outside", (url, punctuation) => {
    const tokens = parser.parse(`See ${url}${punctuation} now`, {})[1].children!;
    expect(
      tokens.map((token) => [
        token.type,
        token.type === "link_open" ? token.attrGet("href") : token.content,
      ]),
    ).toEqual([
      ["text", "See "],
      ["link_open", url],
      ["text", url],
      ["link_close", ""],
      ["text", `${punctuation} now`],
    ]);
  });
  it.each(["[Authored](https://example.com/a.)", "<https://example.com/a.>"])(
    "preserves explicit destinations: %s",
    (source) => {
      const links = parser
        .parse(source, {})[1]
        .children!.filter((token) => token.type === "link_open");
      expect(links.map((token) => token.attrGet("href"))).toEqual(["https://example.com/a."]);
    },
  );
  it("leaves code spans and fences alone", () => {
    expect(parser.render("`http://[::1]:8059/`\n\n```\nhttp://[::1]:8059/\n```", {})).not.toContain(
      "<a ",
    );
  });
});
