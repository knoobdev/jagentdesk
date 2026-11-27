import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCheckoutIdentity, getCheckoutStatus } from "./checkout-git.js";
import { CheckoutReadSession } from "./checkout-read-session.js";
import { writeJAgentDeskWorktreeMetadata } from "./worktree-metadata.js";
import { createWorktree } from "./worktree.js";
import { startGitCommandMetrics, stopGitCommandMetrics } from "./run-git-command.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore" });
}

describe("getCheckoutIdentity", () => {
  let tempDir: string;
  let jagentdeskHome: string;
  let repoDir: string;
  let linkedDir: string;
  let plainDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "checkout-identity-")));
    jagentdeskHome = join(tempDir, "jagentdesk-home");
    repoDir = join(tempDir, "repo");
    linkedDir = join(tempDir, "linked");
    plainDir = join(tempDir, "plain");
    mkdirSync(jagentdeskHome);
    mkdirSync(repoDir);
    mkdirSync(plainDir);
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.email", "test@test.com");
    git(repoDir, "config", "user.name", "Test");
    writeFileSync(join(repoDir, "tracked.txt"), "tracked\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "initial");
    git(repoDir, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    git(repoDir, "worktree", "add", "-b", "feature", linkedDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports the same identity as the full status for a checkout, linked and JAgentDesk worktrees and a plain folder", async () => {
    const jagentdeskWorktree = await createWorktree({
      cwd: repoDir,
      worktreeSlug: "alpha",
      source: { kind: "branch-off", baseBranch: "main", branchName: "alpha" },
      jagentdeskHome,
    });
    for (const cwd of [repoDir, linkedDir, jagentdeskWorktree.worktreePath]) {
      const status = await getCheckoutStatus(cwd, { jagentdeskHome });
      const identity = await getCheckoutIdentity(cwd, { jagentdeskHome });
      if (!status.isGit) throw new Error(`${cwd} should be a git checkout`);
      expect(identity).toEqual({
        isGit: true,
        repoRoot: status.repoRoot,
        mainRepoRoot: status.mainRepoRoot,
        currentBranch: status.currentBranch,
        remoteUrl: status.remoteUrl,
        isJAgentDeskOwnedWorktree: status.isJAgentDeskOwnedWorktree,
      });
    }
    const mainRepoRoot = await realpath(repoDir);
    expect(await getCheckoutIdentity(linkedDir, { jagentdeskHome })).toMatchObject({
      currentBranch: "feature",
      mainRepoRoot,
    });
    expect(
      await getCheckoutIdentity(jagentdeskWorktree.worktreePath, { jagentdeskHome }),
    ).toMatchObject({
      isJAgentDeskOwnedWorktree: true,
      mainRepoRoot,
    });
    expect(await getCheckoutIdentity(plainDir, { jagentdeskHome })).toEqual({ isGit: false });
  });

  it("reads Git worktree registration once for all marked worktrees in a batch", async () => {
    const second = join(tempDir, "second");
    git(repoDir, "worktree", "add", "-b", "second", second);
    await writeJAgentDeskWorktreeMetadata(linkedDir, { baseRefName: "main" });
    await writeJAgentDeskWorktreeMetadata(second, { baseRefName: "main" });

    const readSession = new CheckoutReadSession();
    startGitCommandMetrics();
    try {
      const checkouts = await Promise.all([
        getCheckoutIdentity(linkedDir, { jagentdeskHome, readSession }),
        getCheckoutIdentity(second, { jagentdeskHome, readSession }),
      ]);
      expect(checkouts).toMatchObject([
        { isGit: true, currentBranch: "feature", isJAgentDeskOwnedWorktree: true },
        { isGit: true, currentBranch: "second", isJAgentDeskOwnedWorktree: true },
      ]);
      const worktreeLists = stopGitCommandMetrics().commands.filter(
        (command) => command.args[0] === "worktree" && command.args[1] === "list",
      );
      expect(worktreeLists).toHaveLength(1);
    } finally {
      stopGitCommandMetrics();
    }
  });

  it("shares worktree registration and main checkout discovery in a bare repository", async () => {
    const bare = join(tempDir, "shared.git");
    const main = join(tempDir, "main");
    const first = join(tempDir, "first");
    const second = join(tempDir, "second");
    git(repoDir, "clone", "--bare", repoDir, bare);
    git(bare, "worktree", "add", main, "main");
    git(bare, "worktree", "add", "-b", "first", first);
    git(bare, "worktree", "add", "-b", "second", second);
    await writeJAgentDeskWorktreeMetadata(first, { baseRefName: "main" });
    await writeJAgentDeskWorktreeMetadata(second, { baseRefName: "main" });

    const readSession = new CheckoutReadSession();
    startGitCommandMetrics();
    try {
      const checkouts = await Promise.all(
        [main, first, second].map((cwd) =>
          getCheckoutIdentity(cwd, { jagentdeskHome, readSession }),
        ),
      );
      const mainRepoRoot = await realpath(main);
      expect(checkouts).toMatchObject([
        { currentBranch: "main", isJAgentDeskOwnedWorktree: false, mainRepoRoot: null },
        { currentBranch: "first", isJAgentDeskOwnedWorktree: true },
        { currentBranch: "second", isJAgentDeskOwnedWorktree: true },
      ]);
      for (const checkout of checkouts.slice(1)) {
        if (!checkout.isGit || !checkout.mainRepoRoot) {
          throw new Error("Expected bare worktree checkout to report mainRepoRoot");
        }
        expect(realpathSync.native(checkout.mainRepoRoot)).toBe(mainRepoRoot);
      }
      const worktreeLists = stopGitCommandMetrics().commands.filter(
        (command) => command.args[0] === "worktree" && command.args[1] === "list",
      );
      expect(worktreeLists).toHaveLength(1);
    } finally {
      stopGitCommandMetrics();
    }
  });

  it("never scans the working tree or compares commits", async () => {
    startGitCommandMetrics();
    await getCheckoutIdentity(repoDir, { jagentdeskHome });
    await getCheckoutIdentity(linkedDir, { jagentdeskHome });
    const verbs = stopGitCommandMetrics().commands.map((command) => command.args[0]);

    expect(verbs.length).toBeGreaterThan(0);
    expect(
      verbs.filter((verb) => ["status", "ls-files", "rev-list", "diff"].includes(verb)),
    ).toEqual([]);
  });
});
