import { describe, test, expect } from "vitest";
import { extractArtifacts } from "./extract";

describe("extractArtifacts", () => {
  test("extracts html/svg/mermaid as previewable artifacts", () => {
    const arts = extractArtifacts([
      { type: "assistant_message", text: "Here:\n```html\n<h1>Hi</h1>\n```\n" },
      { type: "assistant_message", text: "```svg\n<svg></svg>\n```" },
      { type: "assistant_message", text: "```mermaid\ngraph TD; A-->B;\n```" },
    ]);
    expect(arts.map((a) => a.kind)).toEqual(["html", "svg", "mermaid"]);
    expect(arts[0].content).toBe("<h1>Hi</h1>");
  });

  test("small untagged blocks are NOT artifacts; large ones are", () => {
    const small = extractArtifacts([{ type: "assistant_message", text: "```\nhi\n```" }]);
    expect(small).toHaveLength(0);
    const big = extractArtifacts([
      { type: "assistant_message", text: "```\n" + "x\n".repeat(20) + "```" },
    ]);
    expect(big).toHaveLength(1);
    expect(big[0].kind).toBe("code");
  });

  test("tagged code blocks (e.g. ts) are artifacts", () => {
    const arts = extractArtifacts([
      { type: "assistant_message", text: "```ts\nconst a = 1;\n```" },
    ]);
    expect(arts).toHaveLength(1);
    expect(arts[0].kind).toBe("code");
    expect(arts[0].language).toBe("ts");
  });

  test("ignores non-assistant items and empty blocks", () => {
    const arts = extractArtifacts([
      { type: "user_message", text: "```html\n<h1>ignored</h1>\n```" },
      { type: "assistant_message", text: "```html\n\n```" },
    ]);
    expect(arts).toHaveLength(0);
  });

  test("ids are stable for identical content", () => {
    const a = extractArtifacts([{ type: "assistant_message", text: "```svg\n<svg/>\n```" }]);
    const b = extractArtifacts([{ type: "assistant_message", text: "```svg\n<svg/>\n```" }]);
    expect(a[0].id).toBe(b[0].id);
  });
});
