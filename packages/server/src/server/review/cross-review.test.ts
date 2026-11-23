import { describe, expect, it } from "vitest";
import {
  ReviewCategorySchema,
  ReviewRoleSchema,
  ReviewSeveritySchema,
  type ReviewFinding,
  type ReviewRole,
  type ReviewVerdict,
} from "@jagentdesk/protocol/review/types";
import {
  deriveReviewVerdict,
  deriveTaskStatusFromReviews,
  renderReviewMarkdown,
} from "./cross-review.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: "src/auth.ts",
    startLine: 12,
    endLine: 14,
    category: "bug",
    severity: "high",
    content: "Session expiry is ignored.",
    suggestion: null,
    ...overrides,
  };
}

const dimensions: Partial<Record<ReviewRole, readonly string[]>> = {
  ba: ["maintainability", "documentation", "other"],
  tester: ["test", "bug"],
  pentester: ["security"],
};

function review(role: ReviewRole, verdict: ReviewVerdict = "approve") {
  return { role, verdict };
}

describe("cross review verdicts", () => {
  for (const role of ReviewRoleSchema.options) {
    it(`${role}: empty findings approve`, () => {
      expect(deriveReviewVerdict(role, [])).toBe("approve");
    });
    for (const severity of ReviewSeveritySchema.options) {
      for (const category of ReviewCategorySchema.options) {
        it(`${role}: ${severity}/${category}`, () => {
          const blocks =
            severity === "critical" ||
            severity === "high" ||
            (severity === "medium" && (dimensions[role]?.includes(category) ?? false));
          expect(deriveReviewVerdict(role, [finding({ severity, category })])).toBe(
            blocks ? "request_changes" : "approve",
          );
        });
      }
    }
  }
  it("one blocking finding wins among nonblocking findings", () => {
    expect(
      deriveReviewVerdict("tester", [
        finding({ severity: "low" }),
        finding({ severity: "medium", category: "test" }),
      ]),
    ).toBe("request_changes");
  });
});

describe("cross review completion", () => {
  it("waits for all three required roles", () => {
    expect(deriveTaskStatusFromReviews([])).toBe("review");
    expect(deriveTaskStatusFromReviews([review("ba"), review("tester")])).toBe("review");
    expect(deriveTaskStatusFromReviews([review("ba"), review("tester"), review("pentester")])).toBe(
      "done",
    );
  });
  it("uses the last entry for each role, so a corrected review can complete the task", () => {
    expect(
      deriveTaskStatusFromReviews([
        review("ba", "request_changes"),
        review("tester"),
        review("pentester"),
        review("ba"),
      ]),
    ).toBe("done");
    expect(
      deriveTaskStatusFromReviews([
        review("ba"),
        review("tester"),
        review("pentester"),
        review("ba", "request_changes"),
      ]),
    ).toBe("in_progress");
  });
  it("any role's latest request for changes blocks, including a non-required role", () => {
    expect(deriveTaskStatusFromReviews([review("reviewer", "request_changes")])).toBe(
      "in_progress",
    );
    expect(
      deriveTaskStatusFromReviews([
        review("ba"),
        review("tester"),
        review("pentester"),
        review("peer", "request_changes"),
      ]),
    ).toBe("in_progress");
  });
  it("extra approvals do not replace a required role", () => {
    expect(deriveTaskStatusFromReviews([review("ba"), review("tester"), review("reviewer")])).toBe(
      "review",
    );
  });
});

describe("cross review markdown", () => {
  it("renders empty findings and optional coverage verbatim", () => {
    expect(renderReviewMarkdown("approve", [], "")).toBe("✅ **Approved** — no blocking findings.");
    expect(renderReviewMarkdown("request_changes", [], "reviewed 3/3 files")).toBe(
      "🔴 **Changes requested** · _reviewed 3/3 files_ — no blocking findings.",
    );
  });
  it("keeps finding order, severity icons, start-line anchors, and suggestions", () => {
    expect(
      renderReviewMarkdown(
        "request_changes",
        [
          finding({ severity: "critical", suggestion: "Check the expiry before accepting." }),
          finding({ severity: "high", startLine: null }),
          finding({ severity: "medium", startLine: 0, suggestion: "" }),
          finding({ severity: "low", category: "documentation" }),
        ],
        "4 files",
      ),
    ).toBe(
      [
        "🔴 **Changes requested** · _4 files_",
        "- 🟥 **critical/bug** `src/auth.ts:12` — Session expiry is ignored.\n  ↳ Check the expiry before accepting.",
        "- 🟧 **high/bug** `src/auth.ts` — Session expiry is ignored.",
        "- 🟨 **medium/bug** `src/auth.ts` — Session expiry is ignored.",
        "- ⬜ **low/documentation** `src/auth.ts:12` — Session expiry is ignored.",
      ].join("\n"),
    );
  });
});
