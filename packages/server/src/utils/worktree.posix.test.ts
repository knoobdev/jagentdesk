// POSIX-only: git worktree and teardown shell fixtures
/* eslint-disable max-nested-callbacks */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BranchAlreadyCheckedOutError,
  createWorktree as createWorktreePrimitive,
  deriveWorktreeProjectHash,
  deleteJAgentDeskWorktree,
  InvalidGitBranchNameError,
  getScriptConfigs,
  getWorktreeSetupCommands,
  getWorktreeTerminalSpecs,
  getWorktreeTeardownCommands,
  isServiceScript,
  isJAgentDeskOwnedWorktreeCwd,
  listJAgentDeskWorktrees,
  readJAgentDeskConfig,
  resolveWorktreeRuntimeEnv,
  type WorktreeSetupCommandProgressEvent,
  runWorktreeSetupCommands,
  type CreateWorktreeOptions,
  type WorktreeConfig,
} from "./worktree";
import type { JAgentDeskConfig } from "@jagentdesk/protocol/jagentdesk-config-schema";
import { getJAgentDeskWorktreeMetadataPath } from "./worktree-metadata.js";
import { execFileSync } from "child_process";
import { isPlatform } from "../test-utils/platform.js";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "fs";
import { delimiter, dirname, join } from "path";
import { tmpdir } from "os";
import net from "node:net";

function loadConfigForTest(repoRoot: string): JAgentDeskConfig | null {
  const result = readJAgentDeskConfig(repoRoot);
  return result.ok ? result.config : null;
}

interface LegacyCreateWorktreeTestOptions {
  branchName: string;
  cwd: string;
  baseBranch: string;
  worktreeSlug: string;
  runSetup?: boolean;
  jagentdeskHome?: string;
  worktreesRoot?: string;
}

function createLegacyWorktreeForTest(
  options: CreateWorktreeOptions | LegacyCreateWorktreeTestOptions,
): Promise<WorktreeConfig> {
  if ("source" in options) {
    return createWorktreePrimitive(options);
  }

  return createWorktreePrimitive({
    cwd: options.cwd,
    worktreeSlug: options.worktreeSlug,
    source: {
      kind: "branch-off",
      baseBranch: options.baseBranch,
      branchName: options.branchName,
    },
    runSetup: options.runSetup ?? true,
    jagentdeskHome: options.jagentdeskHome,
    worktreesRoot: options.worktreesRoot,
  });
}

describe.skipIf(isPlatform("win32"))("worktree POSIX-only", () => {
  describe("createWorktree", () => {
    let tempDir: string;
    let repoDir: string;
    let jagentdeskHome: string;

    beforeEach(() => {
      // Use realpathSync to resolve symlinks (e.g., /var -> /private/var on macOS)
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-test-")));
      repoDir = join(tempDir, "test-repo");
      jagentdeskHome = join(tempDir, "jagentdesk-home");

      // Create a git repo with an initial commit
      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("creates a worktree for the current branch (main)", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello-world",
        jagentdeskHome,
      });

      expect(result.worktreePath).toBe(join(jagentdeskHome, "worktrees", projectHash, "hello-world"));
      expect(existsSync(result.worktreePath)).toBe(true);
      expect(existsSync(join(result.worktreePath, "file.txt"))).toBe(true);
      const metadataPath = getJAgentDeskWorktreeMetadataPath(result.worktreePath);
      expect(existsSync(metadataPath)).toBe(true);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
    });

    it("creates and owns worktrees under a configured root", async () => {
      const worktreesRoot = join(tempDir, "custom-worktrees");
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        branchName: "custom-root",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "custom-root",
        jagentdeskHome,
        worktreesRoot,
      });

      expect(result.worktreePath).toBe(join(worktreesRoot, projectHash, "custom-root"));
      await expect(
        isJAgentDeskOwnedWorktreeCwd(result.worktreePath, { jagentdeskHome, worktreesRoot }),
      ).resolves.toMatchObject({ allowed: true, worktreeRoot: join(worktreesRoot, projectHash) });
      await expect(
        isJAgentDeskOwnedWorktreeCwd(result.worktreePath, { jagentdeskHome }),
      ).resolves.toMatchObject({ allowed: false });

      const worktrees = await listJAgentDeskWorktrees({ cwd: repoDir, jagentdeskHome, worktreesRoot });
      expect(worktrees.map((entry) => entry.path)).toContain(result.worktreePath);

      await deleteJAgentDeskWorktree({
        cwd: repoDir,
        worktreePath: result.worktreePath,
        jagentdeskHome,
        worktreesBaseRoot: worktreesRoot,
      });
      expect(existsSync(result.worktreePath)).toBe(false);
    });

    it.skip("detects jagentdesk-owned worktrees across realpath differences (macOS /var vs /private/var)", async () => {
      // Intentionally create repo using the non-realpath tmpdir() variant (often /var/... on macOS).
      const varTempDir = mkdtempSync(join(tmpdir(), "worktree-realpath-test-"));
      const privateTempDir = realpathSync(varTempDir);
      const varRepoDir = join(varTempDir, "test-repo");
      const varJAgentDeskHome = join(varTempDir, "jagentdesk-home");
      mkdirSync(varRepoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: varRepoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: varRepoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: varRepoDir });
      writeFileSync(join(varRepoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: varRepoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: varRepoDir,
      });

      await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: varRepoDir,
        baseBranch: "main",
        worktreeSlug: "realpath-test",
        jagentdeskHome: varJAgentDeskHome,
      });

      const projectHash = await deriveWorktreeProjectHash(varRepoDir);
      const privateWorktreePath = join(
        privateTempDir,
        "jagentdesk-home",
        "worktrees",
        projectHash,
        "realpath-test",
      );
      expect(existsSync(privateWorktreePath)).toBe(true);

      const ownership = await isJAgentDeskOwnedWorktreeCwd(privateWorktreePath, {
        jagentdeskHome: varJAgentDeskHome,
      });
      expect(ownership.allowed).toBe(true);

      rmSync(varTempDir, { recursive: true, force: true });
    });

    it("reports repoRoot as the repository root for jagentdesk-owned worktrees", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "repo-root-check",
        jagentdeskHome,
      });

      const ownership = await isJAgentDeskOwnedWorktreeCwd(result.worktreePath, { jagentdeskHome });
      expect(ownership.allowed).toBe(true);
      expect(ownership.repoRoot).toBe(repoDir);
    });

    it("treats non-git directories as non-worktrees without throwing", async () => {
      const nonGitDir = join(tempDir, "not-a-repo");
      mkdirSync(nonGitDir, { recursive: true });

      const ownership = await isJAgentDeskOwnedWorktreeCwd(nonGitDir, { jagentdeskHome });

      expect(ownership.allowed).toBe(false);
      expect(ownership.worktreePath).toBe(realpathSync(nonGitDir));
    });

    it("creates a worktree with a new branch", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "my-feature",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/x" },
        runSetup: true,
        jagentdeskHome,
      });

      expect(result.worktreePath).toBe(join(jagentdeskHome, "worktrees", projectHash, "my-feature"));
      expect(existsSync(result.worktreePath)).toBe(true);

      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("feature/x");
      execFileSync("git", ["merge-base", "--is-ancestor", "main", "HEAD"], {
        cwd: result.worktreePath,
      });

      const metadataPath = getJAgentDeskWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ version: 1, baseRefName: "main" });
    });

    it("checks out an existing local branch that is not checked out elsewhere", async () => {
      execFileSync("git", ["branch", "dev"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "dev-worktree",
        source: { kind: "checkout-branch", branchName: "dev" },
        runSetup: true,
        jagentdeskHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("dev");

      const metadataPath = getJAgentDeskWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ version: 1, baseRefName: "dev" });
    });

    it("checks out an existing local branch whose name contains uppercase letters and dots", async () => {
      execFileSync("git", ["branch", "release/1.1.15"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "release-worktree",
        source: { kind: "checkout-branch", branchName: "release/1.1.15" },
        runSetup: true,
        jagentdeskHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("release/1.1.15");
    });

    it("throws a typed error when checking out a branch already checked out in the main repo", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "dev-worktree",
          source: { kind: "checkout-branch", branchName: "main" },
          runSetup: true,
          jagentdeskHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(BranchAlreadyCheckedOutError);
      expect((caughtError as BranchAlreadyCheckedOutError).branchName).toBe("main");
    });

    it("fetches a GitHub PR branch, checks it out, writes metadata, and runs setup", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-b", "contributor/feature"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-pr\n");
      writeFileSync(
        join(remoteCloneDir, "jagentdesk.json"),
        JSON.stringify({ worktree: { setup: ['echo "setup ran" > setup.log'] } }),
      );
      execFileSync("git", ["add", "."], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "pr branch"], {
        cwd: remoteCloneDir,
      });
      const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remoteCloneDir })
        .toString()
        .trim();
      execFileSync("git", ["push", "origin", "contributor/feature"], { cwd: remoteCloneDir });
      execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/42/head", prHead]);

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "pr-42",
        source: {
          kind: "checkout-github-pr",
          githubPrNumber: 42,
          headRef: "user/feature",
          baseRefName: "main",
        },
        runSetup: true,
        jagentdeskHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-pr\n");
      expect(readFileSync(join(result.worktreePath, "setup.log"), "utf8")).toBe("setup ran\n");
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("user/feature");

      const metadataPath = getJAgentDeskWorktreeMetadataPath(result.worktreePath);
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
      expect(metadata).toMatchObject({ baseRefName: "main" });
    });

    it("fetches a GitHub PR branch when the head ref contains uppercase letters and dots", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["clone", "--bare", repoDir, remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-b", "Feature.X"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-uppercase-pr\n");
      execFileSync("git", ["add", "file.txt"], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "uppercase pr branch"], {
        cwd: remoteCloneDir,
      });
      const prHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: remoteCloneDir })
        .toString()
        .trim();
      execFileSync("git", ["push", "origin", "Feature.X"], { cwd: remoteCloneDir });
      execFileSync("git", [`--git-dir=${remoteDir}`, "update-ref", "refs/pull/43/head", prHead]);

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "pr-43",
        source: {
          kind: "checkout-github-pr",
          githubPrNumber: 43,
          headRef: "Feature.X",
          baseRefName: "main",
        },
        runSetup: true,
        jagentdeskHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe(
        "from-uppercase-pr\n",
      );
      const currentBranch = execFileSync("git", ["branch", "--show-current"], {
        cwd: result.worktreePath,
      })
        .toString()
        .trim();
      expect(currentBranch).toBe("Feature.X");
    });

    it("uses the selected local or origin ref when both exist", async () => {
      const remoteDir = join(tempDir, "remote.git");
      const remoteCloneDir = join(tempDir, "remote-clone");
      execFileSync("git", ["init", "--bare", remoteDir]);
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir });
      execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repoDir });

      execFileSync("git", ["clone", remoteDir, remoteCloneDir]);
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: remoteCloneDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: remoteCloneDir });
      execFileSync("git", ["checkout", "-B", "main", "origin/main"], { cwd: remoteCloneDir });
      writeFileSync(join(remoteCloneDir, "file.txt"), "from-origin\n");
      execFileSync("git", ["add", "file.txt"], { cwd: remoteCloneDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance origin main"], {
        cwd: remoteCloneDir,
      });
      execFileSync("git", ["push", "origin", "main"], { cwd: remoteCloneDir });

      writeFileSync(join(repoDir, "file.txt"), "from-local\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "advance local main"], {
        cwd: repoDir,
      });

      execFileSync("git", ["fetch", "origin"], { cwd: repoDir });

      const localResult = await createLegacyWorktreeForTest({
        branchName: "prefer-local-feature",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "prefer-local-feature",
        runSetup: false,
        jagentdeskHome,
      });
      const originResult = await createLegacyWorktreeForTest({
        branchName: "prefer-origin-feature",
        cwd: repoDir,
        baseBranch: "refs/remotes/origin/main",
        worktreeSlug: "prefer-origin-feature",
        runSetup: false,
        jagentdeskHome,
      });

      expect(readFileSync(join(localResult.worktreePath, "file.txt"), "utf8")).toBe("from-local\n");
      expect(readFileSync(join(originResult.worktreePath, "file.txt"), "utf8")).toBe(
        "from-origin\n",
      );
      expect(
        JSON.parse(readFileSync(getJAgentDeskWorktreeMetadataPath(originResult.worktreePath), "utf8")),
      ).toMatchObject({ baseRefName: "main" });
    });

    it("uses a local branch when origin/{branch} does not exist", async () => {
      writeFileSync(join(repoDir, "file.txt"), "from-local-only\n");
      execFileSync("git", ["add", "file.txt"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "advance local main only"],
        {
          cwd: repoDir,
        },
      );

      const result = await createLegacyWorktreeForTest({
        branchName: "prefer-local-fallback-feature",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "prefer-local-fallback-feature",
        runSetup: false,
        jagentdeskHome,
      });

      expect(readFileSync(join(result.worktreePath, "file.txt"), "utf8")).toBe("from-local-only\n");
    });

    it("throws when neither origin/{branch} nor local {branch} exists", async () => {
      await expect(
        createLegacyWorktreeForTest({
          branchName: "missing-base-feature",
          cwd: repoDir,
          baseBranch: "does-not-exist",
          worktreeSlug: "missing-base-feature",
          runSetup: false,
          jagentdeskHome,
        }),
      ).rejects.toThrow("Base branch not found: does-not-exist");
    });

    it("fails with invalid branch name", async () => {
      await expect(
        createLegacyWorktreeForTest({
          branchName: "INVALID_UPPERCASE",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "test",
        }),
      ).rejects.toThrow("Invalid branch name");
    });

    it("throws a typed error when checking out an invalid existing branch name", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "invalid-existing-branch",
          source: { kind: "checkout-branch", branchName: "bad..name" },
          runSetup: true,
          jagentdeskHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(InvalidGitBranchNameError);
      expect((caughtError as InvalidGitBranchNameError).branchName).toBe("bad..name");
    });

    it("throws a typed error when checking out a ref that is valid but not a branch name", async () => {
      let caughtError: unknown;
      try {
        await createLegacyWorktreeForTest({
          cwd: repoDir,
          worktreeSlug: "invalid-option-like-branch",
          source: { kind: "checkout-branch", branchName: "-bad" },
          runSetup: true,
          jagentdeskHome,
        });
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(InvalidGitBranchNameError);
      expect((caughtError as InvalidGitBranchNameError).branchName).toBe("-bad");
    });

    it("handles branch name collision by adding suffix", async () => {
      const projectHash = await deriveWorktreeProjectHash(repoDir);
      // Create a branch named "hello" first
      execFileSync("git", ["branch", "hello"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello",
        jagentdeskHome,
      });

      // Should create branch "hello-1" since "hello" exists
      expect(result.worktreePath).toBe(join(jagentdeskHome, "worktrees", projectHash, "hello"));
      expect(existsSync(result.worktreePath)).toBe(true);

      const branches = execFileSync("git", ["branch"], { cwd: repoDir }).toString();
      expect(branches).toContain("hello-1");
    });

    it("handles multiple collisions", async () => {
      // Create branches "hello" and "hello-1"
      execFileSync("git", ["branch", "hello"], { cwd: repoDir });
      execFileSync("git", ["branch", "hello-1"], { cwd: repoDir });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "hello",
        jagentdeskHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);

      const branches = execFileSync("git", ["branch"], { cwd: repoDir }).toString();
      expect(branches).toContain("hello-2");
    });

    it("runs setup commands from jagentdesk.json", async () => {
      // Create jagentdesk.json with setup commands
      const jagentdeskConfig = {
        worktree: {
          setup: [
            'echo "source=$JAGENTDESK_SOURCE_CHECKOUT_PATH" > setup.log',
            'echo "root_alias=$JAGENTDESK_ROOT_PATH" >> setup.log',
            'echo "worktree=$JAGENTDESK_WORKTREE_PATH" >> setup.log',
            'echo "branch=$JAGENTDESK_BRANCH_NAME" >> setup.log',
            'echo "port=$JAGENTDESK_WORKTREE_PORT" >> setup.log',
          ],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add jagentdesk.json"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "setup-test",
        jagentdeskHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);

      // Verify setup ran and env vars were available
      const setupLog = readFileSync(join(result.worktreePath, "setup.log"), "utf8");
      expect(setupLog).toContain(`source=${repoDir}`);
      expect(setupLog).toContain(`root_alias=${repoDir}`);
      expect(setupLog).toContain(`worktree=${result.worktreePath}`);
      expect(setupLog).toContain("branch=setup-test");
      const portLine = setupLog.split("\n").find((line) => line.startsWith("port="));
      expect(portLine).toBeDefined();
      const portValue = Number(portLine?.slice("port=".length));
      expect(Number.isInteger(portValue)).toBe(true);
      expect(portValue).toBeGreaterThan(0);
    });

    it("runs string setup scripts from jagentdesk.json as a single shell command", async () => {
      const jagentdeskConfig = {
        worktree: {
          setup: 'greeting="hello from string setup"\necho "$greeting" > setup.log',
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add string setup"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "string-setup-test",
        jagentdeskHome,
      });

      expect(getWorktreeSetupCommands(result.worktreePath)).toEqual([
        'greeting="hello from string setup"\necho "$greeting" > setup.log',
      ]);
      expect(readFileSync(join(result.worktreePath, "setup.log"), "utf8").trim()).toBe(
        "hello from string setup",
      );
    });

    it("runs setup commands with the daemon PATH instead of login profile PATH", async () => {
      const home = join(tempDir, "host-home");
      const binDir = join(tempDir, "daemon-bin");
      mkdirSync(home);
      mkdirSync(binDir);

      const shimPath = join(binDir, "jagentdesk-shim");
      writeFileSync(shimPath, "#!/bin/sh\nprintf 'shim:%s\\n' \"$1\"\n");
      chmodSync(shimPath, 0o755);
      writeFileSync(join(home, ".bash_profile"), "export PATH=/usr/bin:/bin\n");
      const bashEnvPath = join(home, "bash-env");
      writeFileSync(bashEnvPath, "export PATH=/usr/bin:/bin\n");
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({
          worktree: {
            setup: "command -v jagentdesk-shim >/dev/null && jagentdesk-shim ok > setup-path.log",
          },
        }),
      );

      const originalHome = process.env.HOME;
      const originalPath = process.env.PATH;
      const originalBashEnv = process.env.BASH_ENV;
      process.env.HOME = home;
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? "/usr/bin:/bin"}`;
      process.env.BASH_ENV = bashEnvPath;

      try {
        await runWorktreeSetupCommands({
          worktreePath: repoDir,
          branchName: "main",
          cleanupOnFailure: false,
          runtimeEnv: {
            JAGENTDESK_SOURCE_CHECKOUT_PATH: repoDir,
            JAGENTDESK_ROOT_PATH: repoDir,
            JAGENTDESK_WORKTREE_PATH: repoDir,
            JAGENTDESK_BRANCH_NAME: "main",
            JAGENTDESK_WORKTREE_PORT: "12345",
          },
        });
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
        if (originalBashEnv === undefined) {
          delete process.env.BASH_ENV;
        } else {
          process.env.BASH_ENV = originalBashEnv;
        }
      }

      expect(readFileSync(join(repoDir, "setup-path.log"), "utf8").trim()).toBe("shim:ok");
    });

    it("treats blank lifecycle strings as empty", () => {
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({
          worktree: {
            setup: " \n\t ",
            teardown: " \n ",
          },
        }),
      );

      expect(getWorktreeSetupCommands(repoDir)).toEqual([]);
      expect(getWorktreeTeardownCommands(repoDir)).toEqual([]);
    });

    it("filters non-string and blank entries from lifecycle arrays", () => {
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({
          worktree: {
            setup: [
              'echo "first" > setup-array.log',
              null,
              "   ",
              'echo "second" >> setup-array.log',
            ],
            teardown: [
              'echo "first" > "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown-array.log"',
              null,
              "",
              'echo "second" >> "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown-array.log"',
            ],
          },
        }),
      );

      expect(getWorktreeSetupCommands(repoDir)).toEqual([
        'echo "first" > setup-array.log',
        'echo "second" >> setup-array.log',
      ]);
      expect(getWorktreeTeardownCommands(repoDir)).toEqual([
        'echo "first" > "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown-array.log"',
        'echo "second" >> "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown-array.log"',
      ]);
    });

    it("does not run setup commands when runSetup=false", async () => {
      const jagentdeskConfig = {
        worktree: {
          setup: ['echo "setup ran" > setup.log'],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add jagentdesk.json"], {
        cwd: repoDir,
      });

      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "no-setup-test",
        runSetup: false,
        jagentdeskHome,
      });

      expect(existsSync(result.worktreePath)).toBe(true);
      expect(existsSync(join(result.worktreePath, "setup.log"))).toBe(false);
    });

    it("streams setup command progress events while commands are executing", async () => {
      const jagentdeskConfig = {
        worktree: {
          setup: ['echo "first line"; echo "second line" 1>&2'],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add streaming setup"], {
        cwd: repoDir,
      });

      const progressEvents: WorktreeSetupCommandProgressEvent[] = [];
      const results = await runWorktreeSetupCommands({
        worktreePath: repoDir,
        branchName: "main",
        cleanupOnFailure: false,
        onEvent: (event) => {
          progressEvents.push(event);
        },
      });

      expect(results).toHaveLength(1);
      expect(progressEvents.some((event) => event.type === "command_started")).toBe(true);
      expect(progressEvents.some((event) => event.type === "output")).toBe(true);
      expect(progressEvents.some((event) => event.type === "command_completed")).toBe(true);
    });

    it("reuses persisted worktree runtime port across resolutions", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "runtime-env-port-reuse",
        runSetup: false,
        jagentdeskHome,
      });

      const first = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      const second = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });

      expect(second.JAGENTDESK_WORKTREE_PORT).toBe(first.JAGENTDESK_WORKTREE_PORT);
    });

    it("fails runtime env resolution when persisted port is in use", async () => {
      const result = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "runtime-env-port-conflict",
        runSetup: false,
        jagentdeskHome,
      });

      const env = await resolveWorktreeRuntimeEnv({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
      const port = Number(env.JAGENTDESK_WORKTREE_PORT);

      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => resolve());
      });

      await expect(
        resolveWorktreeRuntimeEnv({
          worktreePath: result.worktreePath,
          branchName: result.branchName,
        }),
      ).rejects.toThrow(`Persisted worktree port ${port} is already in use`);

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    it("cleans up worktree if setup command fails", async () => {
      // Create jagentdesk.json with failing setup command
      const jagentdeskConfig = {
        worktree: {
          setup: ["exit 1"],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add jagentdesk.json"], {
        cwd: repoDir,
      });

      const expectedWorktreePath = join(jagentdeskHome, "worktrees", "test-repo", "fail-test");

      await expect(
        createLegacyWorktreeForTest({
          branchName: "main",
          cwd: repoDir,
          baseBranch: "main",
          worktreeSlug: "fail-test",
          jagentdeskHome,
        }),
      ).rejects.toThrow("Worktree setup command failed");

      // Verify worktree was cleaned up
      expect(existsSync(expectedWorktreePath)).toBe(false);
    });

    it("reads worktree terminal specs from jagentdesk.json with optional name", async () => {
      const jagentdeskConfig = {
        worktree: {
          terminals: [
            { name: "Dev Server", command: "npm run dev" },
            { command: "cd packages/app && npm run dev" },
          ],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));

      expect(getWorktreeTerminalSpecs(repoDir)).toEqual([
        { name: "Dev Server", command: "npm run dev" },
        { command: "cd packages/app && npm run dev" },
      ]);
    });

    it("filters invalid worktree terminal specs", async () => {
      const jagentdeskConfig = {
        worktree: {
          terminals: [
            null,
            {},
            { name: "   ", command: "   " },
            { name: " Watch ", command: "npm run watch", cwd: "packages/app" },
            { name: 123, command: "npm run test" },
          ],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));

      expect(getWorktreeTerminalSpecs(repoDir)).toEqual([
        { name: "Watch", command: "npm run watch" },
        { command: "npm run test" },
      ]);
    });

    it("parses omitted script type as a plain script", async () => {
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({
          scripts: {
            typecheck: {
              command: " npm run typecheck ",
            },
          },
        }),
      );

      const scriptConfigs = getScriptConfigs(loadConfigForTest(repoDir));
      const typecheck = scriptConfigs.get("typecheck");

      expect(typecheck).toEqual({
        command: "npm run typecheck",
      });
      expect(typecheck).toBeDefined();
      expect(isServiceScript(typecheck!)).toBe(false);
    });

    it("parses service scripts and preserves optional port", async () => {
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({
          scripts: {
            server: {
              type: "service",
              command: "npm run dev",
              port: 4321,
            },
          },
        }),
      );

      const scriptConfigs = getScriptConfigs(loadConfigForTest(repoDir));
      const server = scriptConfigs.get("server");

      expect(server).toEqual({
        type: "service",
        command: "npm run dev",
        port: 4321,
      });
      expect(server).toBeDefined();
      expect(isServiceScript(server!)).toBe(true);
    });

    it("ignores invalid script entries gracefully", async () => {
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({
          scripts: {
            valid: {
              command: "npm run valid",
            },
            invalidType: {
              type: "worker",
              command: "npm run worker",
            },
            missingCommand: {
              type: "service",
            },
            blankCommand: {
              command: "   ",
            },
            nonObject: "npm run nope",
            invalidPort: {
              type: "service",
              command: "npm run dev",
              port: "3000",
            },
          },
        }),
      );

      expect(getScriptConfigs(loadConfigForTest(repoDir))).toEqual(
        new Map([
          ["valid", { command: "npm run valid" }],
          ["invalidType", { command: "npm run worker" }],
          ["invalidPort", { type: "service", command: "npm run dev" }],
        ]),
      );
    });

    it("seeds an uncommitted jagentdesk.json from the main repo into a new worktree", async () => {
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({ scripts: { dev: { command: "echo hi" } } }),
      );

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "seed-uncommitted",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/seed" },
        runSetup: false,
        jagentdeskHome,
      });

      const worktreeConfigPath = join(result.worktreePath, "jagentdesk.json");
      expect(existsSync(worktreeConfigPath)).toBe(true);
      expect(JSON.parse(readFileSync(worktreeConfigPath, "utf8"))).toEqual({
        scripts: { dev: { command: "echo hi" } },
      });
    });

    it("does not overwrite a committed jagentdesk.json with uncommitted edits in the main repo", async () => {
      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({ scripts: { dev: { command: "committed" } } }),
      );
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add jagentdesk.json"], {
        cwd: repoDir,
      });

      writeFileSync(
        join(repoDir, "jagentdesk.json"),
        JSON.stringify({ scripts: { dev: { command: "uncommitted" } } }),
      );

      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "preserve-committed",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/preserve" },
        runSetup: false,
        jagentdeskHome,
      });

      const worktreeConfigPath = join(result.worktreePath, "jagentdesk.json");
      expect(JSON.parse(readFileSync(worktreeConfigPath, "utf8"))).toEqual({
        scripts: { dev: { command: "committed" } },
      });
    });

    it("creates a worktree without error when no jagentdesk.json exists in the main repo", async () => {
      const result = await createLegacyWorktreeForTest({
        cwd: repoDir,
        worktreeSlug: "no-config",
        source: { kind: "branch-off", baseBranch: "main", branchName: "feature/no-config" },
        runSetup: false,
        jagentdeskHome,
      });

      expect(existsSync(join(result.worktreePath, "jagentdesk.json"))).toBe(false);
    });
  });

  describe("jagentdesk worktree manager", () => {
    let tempDir: string;
    let repoDir: string;
    let jagentdeskHome: string;

    beforeEach(() => {
      tempDir = realpathSync(mkdtempSync(join(tmpdir(), "worktree-manager-test-")));
      repoDir = join(tempDir, "test-repo");
      jagentdeskHome = join(tempDir, "jagentdesk-home");

      mkdirSync(repoDir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
      writeFileSync(join(repoDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "."], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
        cwd: repoDir,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("isolates worktree roots for repositories that share the same directory name", async () => {
      const repoA = join(tempDir, "team-a", "test-repo");
      const repoB = join(tempDir, "team-b", "test-repo");

      for (const repo of [repoA, repoB]) {
        mkdirSync(repo, { recursive: true });
        execFileSync("git", ["init", "-b", "main"], { cwd: repo });
        execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
        execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
        writeFileSync(join(repo, "file.txt"), "hello\n");
        execFileSync("git", ["add", "."], { cwd: repo });
        execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"], {
          cwd: repo,
        });
      }

      const fromRepoA = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoA,
        baseBranch: "main",
        worktreeSlug: "alpha",
        jagentdeskHome,
      });
      const fromRepoB = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoB,
        baseBranch: "main",
        worktreeSlug: "alpha",
        jagentdeskHome,
      });

      expect(dirname(fromRepoA.worktreePath)).not.toBe(dirname(fromRepoB.worktreePath));
      expect(fromRepoA.worktreePath.endsWith("alpha-1")).toBe(false);
      expect(fromRepoB.worktreePath.endsWith("alpha-1")).toBe(false);

      const repoAWorktrees = await listJAgentDeskWorktrees({ cwd: repoA, jagentdeskHome });
      const repoBWorktrees = await listJAgentDeskWorktrees({ cwd: repoB, jagentdeskHome });

      expect(repoAWorktrees.map((entry) => entry.path)).toEqual([fromRepoA.worktreePath]);
      expect(repoBWorktrees.map((entry) => entry.path)).toEqual([fromRepoB.worktreePath]);
    });

    it("lists and deletes jagentdesk worktrees under ~/.jagentdesk/worktrees/{hash}", async () => {
      const first = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "alpha",
        jagentdeskHome,
      });
      const second = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "beta",
        jagentdeskHome,
      });

      const worktrees = await listJAgentDeskWorktrees({ cwd: repoDir, jagentdeskHome });
      const paths = worktrees.map((worktree) => worktree.path).sort();
      expect(paths).toEqual([first.worktreePath, second.worktreePath].sort());

      await deleteJAgentDeskWorktree({ cwd: repoDir, worktreePath: first.worktreePath, jagentdeskHome });
      expect(existsSync(first.worktreePath)).toBe(false);

      const remaining = await listJAgentDeskWorktrees({ cwd: repoDir, jagentdeskHome });
      expect(remaining.map((worktree) => worktree.path)).toEqual([second.worktreePath]);
    });

    it("deletes a jagentdesk worktree even when given a subdirectory path", async () => {
      const created = await createLegacyWorktreeForTest({
        branchName: "main",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "alpha",
        jagentdeskHome,
      });

      const nestedDir = join(created.worktreePath, "nested", "dir");
      mkdirSync(nestedDir, { recursive: true });

      await deleteJAgentDeskWorktree({ cwd: repoDir, worktreePath: nestedDir, jagentdeskHome });
      expect(existsSync(created.worktreePath)).toBe(false);

      const remaining = await listJAgentDeskWorktrees({ cwd: repoDir, jagentdeskHome });
      expect(remaining.some((worktree) => worktree.path === created.worktreePath)).toBe(false);
    });

    it("runs teardown commands from jagentdesk.json before deleting a worktree", async () => {
      const jagentdeskConfig = {
        worktree: {
          teardown: [
            'echo "source=$JAGENTDESK_SOURCE_CHECKOUT_PATH" > "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "root_alias=$JAGENTDESK_ROOT_PATH" >> "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "worktree=$JAGENTDESK_WORKTREE_PATH" >> "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "branch=$JAGENTDESK_BRANCH_NAME" >> "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown.log"',
            'echo "port=$JAGENTDESK_WORKTREE_PORT" >> "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown.log"',
          ],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add teardown commands"], {
        cwd: repoDir,
      });

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-test",
        jagentdeskHome,
      });
      const runtimeEnv = await resolveWorktreeRuntimeEnv({
        worktreePath: created.worktreePath,
        branchName: created.branchName,
      });

      await deleteJAgentDeskWorktree({ cwd: repoDir, worktreePath: created.worktreePath, jagentdeskHome });
      expect(existsSync(created.worktreePath)).toBe(false);

      const teardownLog = readFileSync(join(repoDir, "teardown.log"), "utf8");
      expect(teardownLog).toContain(`source=${repoDir}`);
      expect(teardownLog).toContain(`root_alias=${repoDir}`);
      expect(teardownLog).toContain(`worktree=${created.worktreePath}`);
      expect(teardownLog).toContain("branch=teardown-branch");
      expect(teardownLog).toContain(`port=${runtimeEnv.JAGENTDESK_WORKTREE_PORT}`);
    });

    it("runs string teardown scripts from jagentdesk.json as a single shell command", async () => {
      const jagentdeskConfig = {
        worktree: {
          teardown:
            'cleanup_message="teardown string"\necho "$cleanup_message" > "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown.log"',
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "add string teardown"], {
        cwd: repoDir,
      });

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-string-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-string-test",
        jagentdeskHome,
      });

      await deleteJAgentDeskWorktree({ cwd: repoDir, worktreePath: created.worktreePath, jagentdeskHome });

      expect(getWorktreeTeardownCommands(repoDir)).toEqual([
        'cleanup_message="teardown string"\necho "$cleanup_message" > "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown.log"',
      ]);
      expect(readFileSync(join(repoDir, "teardown.log"), "utf8").trim()).toBe("teardown string");
    });

    it("omits JAGENTDESK_WORKTREE_PORT from teardown env when runtime metadata is missing", async () => {
      const jagentdeskConfig = {
        worktree: {
          teardown: [
            'echo "port=${JAGENTDESK_WORKTREE_PORT-unset}" > "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown-port.log"',
          ],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add teardown port logging"],
        { cwd: repoDir },
      );

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-port-missing-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-port-missing-test",
        jagentdeskHome,
      });

      await deleteJAgentDeskWorktree({ cwd: repoDir, worktreePath: created.worktreePath, jagentdeskHome });

      expect(readFileSync(join(repoDir, "teardown-port.log"), "utf8").trim()).toBe("port=unset");
      expect(existsSync(created.worktreePath)).toBe(false);
    });

    it("does not remove worktree when a teardown command fails", async () => {
      const jagentdeskConfig = {
        worktree: {
          teardown: [
            'echo "started" > "$JAGENTDESK_SOURCE_CHECKOUT_PATH/teardown-start.log"',
            "echo boom 1>&2; exit 9",
          ],
        },
      };
      writeFileSync(join(repoDir, "jagentdesk.json"), JSON.stringify(jagentdeskConfig));
      execFileSync("git", ["add", "jagentdesk.json"], { cwd: repoDir });
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "commit", "-m", "add failing teardown commands"],
        { cwd: repoDir },
      );

      const created = await createLegacyWorktreeForTest({
        branchName: "teardown-failure-branch",
        cwd: repoDir,
        baseBranch: "main",
        worktreeSlug: "teardown-failure-test",
        jagentdeskHome,
      });

      await expect(
        deleteJAgentDeskWorktree({ cwd: repoDir, worktreePath: created.worktreePath, jagentdeskHome }),
      ).rejects.toThrow("Worktree teardown command failed");

      expect(existsSync(created.worktreePath)).toBe(true);
      expect(existsSync(join(repoDir, "teardown-start.log"))).toBe(true);
    });
  });
});
