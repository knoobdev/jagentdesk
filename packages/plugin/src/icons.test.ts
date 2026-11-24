import { expect, it } from "vitest";
import { findSvgIconProblem } from "./icons.js";
it("accepts self-contained SVG and rejects active or remote content", () => {
  expect(
    findSvgIconProblem(
      '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M0 0h24v24z"/></svg>',
    ),
  ).toBeNull();
  expect(findSvgIconProblem("<svg><script>alert(1)</script></svg>")).toBe(
    "script elements are not allowed",
  );
  expect(findSvgIconProblem('<svg><image href="https://remote.invalid/image"/></svg>')).toBe(
    "external href references are not allowed",
  );
});
