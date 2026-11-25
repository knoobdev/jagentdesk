import { expect, it } from "vitest";
import { matchCommandLink } from "./index";
it("inserts only complete authored commands that the active agent advertises", () => {
  const names = new Set(["code-review", "review:fast"]);
  expect(matchCommandLink("/code-review", "inline-code", names)).toBe("/code-review");
  expect(matchCommandLink("/review:fast", "inline-code", names)).toBe("/review:fast");
  expect(matchCommandLink("/code-review", "markdown", names)).toBe("/code-review");
  expect(matchCommandLink("/code-review/file", "markdown", names)).toBeNull();
  expect(matchCommandLink("/code-review", "text", names)).toBeNull();
  expect(matchCommandLink("https://example.com/code-review", "markdown", names)).toBeNull();
  expect(matchCommandLink("/unknown", "markdown", names)).toBeNull();
});
