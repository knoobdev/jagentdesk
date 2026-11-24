import { expect, it } from "vitest";
import { deriveReviewVerdict } from "../review/cross-review.js";
import type { ReviewFinding } from "@jagentdesk/protocol/review/types";
import { diffHash } from "./review.js";
it("blocks role-owned medium findings and all high findings, and pins diff identity", () => {
  const security: ReviewFinding = {
    path: "sum.js",
    startLine: 1,
    endLine: 1,
    category: "security",
    severity: "medium",
    content: "eval on request input",
    suggestion: "Parse a number",
  };
  expect(deriveReviewVerdict("pentester", [security])).toBe("request_changes");
  expect(deriveReviewVerdict("tester", [security])).toBe("approve");
  expect(deriveReviewVerdict("ba", [{ ...security, severity: "high" }])).toBe("request_changes");
  expect(diffHash("a")).not.toBe(diffHash("b"));
});
