import { describe, expect, test, vi } from "vitest";
import { generateBranchNameFromFirstAgentContext } from "./worktree-branch-name-generator.js";

function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function generate(
  firstAgentContext: Parameters<
    typeof generateBranchNameFromFirstAgentContext
  >[0]["firstAgentContext"],
) {
  return generateBranchNameFromFirstAgentContext({
    cwd: "/tmp/repo",
    firstAgentContext,
    logger: createLogger(),
  });
}

describe("generateBranchNameFromFirstAgentContext (deterministic, no LLM)", () => {
  test("derives title and a git-ref-safe branch slug from the prompt", async () => {
    const result = await generate({ prompt: "Fix the login flow" });
    expect(result).toEqual({ title: "Fix the login flow", branch: "fix-the-login-flow" });
  });

  test("slug collapses punctuation/spaces into single hyphens", async () => {
    const result = await generate({ prompt: "Add a payments flow with Stripe checkout" });
    expect(result?.branch).toBe("add-a-payments-flow-with-stripe-checkout");
  });

  test("strips a leading slash-command marker for the title", async () => {
    const result = await generate({ prompt: "/refactor-one-thing" });
    expect(result?.title).toBe("refactor-one-thing");
    expect(result?.branch).toBe("refactor-one-thing");
  });

  test("uses only the first non-empty line", async () => {
    const result = await generate({ prompt: "\n\nShip the release\nthen update the changelog" });
    expect(result?.title).toBe("Ship the release");
    expect(result?.branch).toBe("ship-the-release");
  });

  test("strips Vietnamese diacritics so the branch stays a valid git ref", async () => {
    const result = await generate({ prompt: "Sửa lỗi đăng nhập" });
    expect(result?.branch).toBe("sua-loi-dang-nhap");
    expect(result?.branch).toMatch(/^[a-z0-9/-]+$/);
  });

  test("names from an attachment-only context (e.g. a PR)", async () => {
    const result = await generate({
      attachments: [
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 42,
          title: "Review flaky checkout",
          url: "https://github.com/acme/repo/pull/42",
        },
      ],
    });
    expect(result?.branch).toContain("review-flaky-checkout");
  });

  test("returns null when there is no prompt or attachment", async () => {
    expect(await generate({ prompt: "   " })).toBeNull();
    expect(await generate(undefined)).toBeNull();
  });

  test("caps an overlong title and branch without trailing hyphens", async () => {
    const long = "Implement a very long and elaborate description ".repeat(4).trim();
    const result = await generate({ prompt: long });
    expect((result?.title ?? "").length).toBeLessThanOrEqual(80);
    expect((result?.branch ?? "").length).toBeLessThanOrEqual(60);
    expect(result?.branch ?? "").not.toMatch(/-$/);
  });
});
