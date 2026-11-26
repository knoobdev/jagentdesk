import { flushGitCommandTrace } from "../utils/git-command-trace.js";
import {
  runWithGitCommandPriority,
  startGitCommandMetrics,
  stopGitCommandMetrics,
  waitForGitCommandMetricsIdle,
} from "../utils/run-git-command.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { type CheckoutSnapshotFacts, type CheckoutStatusGit } from "../utils/checkout-git.js";
import { createGitHubService, GitHubCommandError } from "../services/github-service.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { createFileObserver } from "./file-observer/index.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import type { FileChange, FileObserver, SubscribeToFileChanges } from "./file-observer/index.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as pino.Logger;
}

function createFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: null,
    absoluteGitDir: path.join(cwd, ".git"),
    gitCommonDir: path.join(cwd, ".git"),
    jagentdeskWorktree: { isJAgentDeskOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: null,
    branchMergeRef: null,
    upstreamStatus: { state: "none" },
    firstPushRemote: null,
    pullRequestLookupTarget: { headRef: "main" },
  };
}

function createStatus(cwd: string): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: null,
    behindOfOrigin: null,
    hasRemote: false,
    remoteUrl: null,
    isJAgentDeskOwnedWorktree: false,
  };
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

test("a fresh checkout read makes a newly initialized repository available to cached readers", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jagentdesk-checkout-init-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(root, "home"),
  });
  cleanup.push(async () => {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  expect((await service.getSnapshot(repo, { includeForge: false })).git.isGit).toBe(false);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });

  expect((await service.getCheckout(repo)).isGit).toBe(true);
  const repoRoot = await service.resolveRepoRoot(repo);
  expect(realpathSync.native(repoRoot)).toBe(realpathSync.native(repo));
}, 30_000);

test("recursive observation updates tracked state and prunes ignored storms", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "jagentdesk-git-observation-")));
  const repoDir = path.join(tempDir, "repo");
  const trackedPath = path.join(repoDir, "src", "tracked.txt");
  const ignoredDir = path.join(repoDir, "build");
  const remainingIgnoredDir = path.join(repoDir, "cache");
  const newlyTrackedPath = path.join(ignoredDir, "tracked.txt");
  mkdirSync(path.join(repoDir, ".git"), { recursive: true });
  mkdirSync(path.dirname(trackedPath), { recursive: true });
  mkdirSync(ignoredDir, { recursive: true });
  mkdirSync(remainingIgnoredDir, { recursive: true });
  writeFileSync(trackedPath, "base\n");
  writeFileSync(newlyTrackedPath, "base\n");

  let activeWatcherCount = 0;
  const observer = createFileObserver();
  let watcherStartCount = 0;
  let onWorkingTreeIgnoreUpdated: (() => void) | null = null;
  const deliveredEvents: Array<{
    directory: string;
    events: FileChange[];
  }> = [];
  const subscribe: SubscribeToFileChanges = async (directory, callback, options) => {
    const subscription = await observer.subscribe(
      directory,
      (error, events) => {
        deliveredEvents.push({ directory, events });
        callback(error, events);
      },
      options,
    );
    activeWatcherCount += 1;
    watcherStartCount += 1;
    return {
      updateIgnore: async (paths) => {
        await subscription.updateIgnore(paths);
        if (directory === repoDir) {
          const onUpdated = onWorkingTreeIgnoreUpdated;
          onWorkingTreeIgnoreUpdated = null;
          onUpdated?.();
        }
      },
      unsubscribe: async () => {
        await subscription.unsubscribe();
        activeWatcherCount -= 1;
      },
    };
  };
  const fileObserver = {
    subscribe,
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  let observedPath = trackedPath;
  let observedRelativePath = "src/tracked.txt";
  const readObservedState = () => {
    const contents = readFileSync(observedPath, "utf8");
    const isDirty = contents !== "base\n";
    return {
      isDirty,
      additions: isDirty ? contents.trim().split("\n").length : 0,
    };
  };
  const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createFacts(cwd));
  const getCheckoutStatus = vi.fn(async (cwd: string) => ({
    ...createStatus(cwd),
    isDirty: readObservedState().isDirty,
  }));
  const getCheckoutShortstat = vi.fn(async () => ({
    additions: readObservedState().additions,
    deletions: 0,
  }));
  const getCheckoutWorktreeState = vi.fn(async () => {
    const additions = readObservedState().additions;
    return { isDirty: true, diffStat: { additions, deletions: 0 } };
  });
  const getCheckoutDiff = vi.fn(async () => {
    const additions = readObservedState().additions;
    return {
      diff: "",
      structured: [
        { path: observedRelativePath, additions, deletions: 0, status: "modified" as const },
      ],
    };
  });
  let buildIgnored = true;
  const runGitCommand = vi.fn(async (args: string[]) => {
    if (args[0] === "rev-parse") {
      return {
        stdout: `${repoDir}\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    if (args[0] === "ls-files") {
      return {
        stdout: `${buildIgnored ? "build/\n" : ""}cache/\n`,
        stderr: "",
        truncated: false,
        exitCode: 0,
        signal: null,
      };
    }
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  });
  const service = new WorkspaceGitServiceImpl({
    logger: createLogger(),
    jagentdeskHome: path.join(tempDir, "jagentdesk-home"),
    fileObserver,
    deps: {
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutWorktreeState,
      getCheckoutDiff,
      runGitCommand,
    } as never,
  });
  const workspaceRuntimeStore = createWorkspaceRuntimeStore();
  service.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));
  const diffManager = new CheckoutDiffManager({
    workspaceRuntimeStore: workspaceRuntimeStore,
    logger: createLogger(),
    jagentdeskHome: path.join(tempDir, "jagentdesk-home"),
    workspaceGitService: service,
  });
  const summaryListener = vi.fn();
  const diffListener = vi.fn();
  const summarySubscription = service.registerWorkspace({ cwd: repoDir }, summaryListener);
  const diffSubscription = await diffManager.subscribe(
    { cwd: repoDir, compare: { mode: "uncommitted" } },
    diffListener,
  );

  cleanup.push(async () => {
    diffSubscription.unsubscribe();
    summarySubscription.unsubscribe();
    diffManager.dispose();
    await service.dispose();
    expect(activeWatcherCount).toBe(0);
    rmSync(tempDir, { recursive: true, force: true });
  });

  await vi.waitFor(
    () => {
      expect(activeWatcherCount).toBe(2);
      expect(workspaceRuntimeStore.get(repoDir)).not.toBeNull();
      // The initial read, then the checkout read that follows watcher coverage.
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(2);
      expect(service.getMetrics()).toMatchObject({
        workspaceObservationSetupInFlightCount: 0,
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "base\n");
  await vi.waitFor(
    () => {
      const events = deliveredEvents.flatMap((batch) => batch.events);
      expect(events.map((event) => event.path)).toContain(trackedPath);
      expect(getCheckoutWorktreeState).toHaveBeenCalled();
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  deliveredEvents.length = 0;

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff, JSON.stringify(deliveredEvents)).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(ignoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);

  writeFileSync(trackedPath, "first\nsecond\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "src/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
    },
    { timeout: 5_000 },
  );

  writeFileSync(trackedPath, "first\nsecond\nthird\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            diffStat: { additions: 3, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          files: [expect.objectContaining({ additions: 3 })],
        }),
      );
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();

  buildIgnored = false;
  observedPath = newlyTrackedPath;
  observedRelativePath = "build/tracked.txt";
  let editedDuringIgnoreUpdate = false;
  onWorkingTreeIgnoreUpdated = () => {
    editedDuringIgnoreUpdate = true;
    writeFileSync(newlyTrackedPath, "first\nsecond\n");
  };
  writeFileSync(path.join(repoDir, ".gitignore"), "cache/\n");
  await vi.waitFor(
    () => {
      expect(editedDuringIgnoreUpdate).toBe(true);
      expect(watcherStartCount).toBe(2);
      expect(activeWatcherCount).toBe(2);
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 2, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 2,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 8_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();
  summaryListener.mockClear();
  diffListener.mockClear();

  writeFileSync(newlyTrackedPath, "first\nsecond\nthird\nfourth\n");
  await vi.waitFor(
    () => {
      expect(summaryListener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          git: expect.objectContaining({
            isDirty: true,
            diffStat: { additions: 4, deletions: 0 },
          }),
        }),
      );
      expect(diffListener).toHaveBeenLastCalledWith({
        cwd: repoDir,
        files: [
          {
            path: "build/tracked.txt",
            additions: 4,
            deletions: 0,
            status: "modified",
          },
        ],
        error: null,
      });
      expect(service.getMetrics()).toMatchObject({
        workspaceRefreshInFlightCount: 0,
        workspaceRefreshQueuedCount: 0,
      });
    },
    { timeout: 5_000 },
  );

  getCheckoutSnapshotFacts.mockClear();
  getCheckoutStatus.mockClear();
  getCheckoutShortstat.mockClear();
  getCheckoutWorktreeState.mockClear();
  getCheckoutDiff.mockClear();
  runGitCommand.mockClear();

  for (let index = 0; index < 100; index += 1) {
    writeFileSync(path.join(remainingIgnoredDir, `artifact-${index}.txt`), `${index}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, 750));

  expect(runGitCommand).not.toHaveBeenCalled();
  expect(getCheckoutSnapshotFacts).not.toHaveBeenCalled();
  expect(getCheckoutStatus).not.toHaveBeenCalled();
  expect(getCheckoutShortstat).not.toHaveBeenCalled();
  expect(getCheckoutWorktreeState).not.toHaveBeenCalled();
  expect(getCheckoutDiff).not.toHaveBeenCalled();
  expect(service.getMetrics().workspaceRefreshQueuedCount).toBe(0);
}, 30_000);

test("a late Git-ignored tree is pruned while tracked changes still notify consumers", async () => {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "jagentdesk-real-ignore-")));
  const repoDir = path.join(tempDir, "repo");
  mkdirSync(repoDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n");
  const trackedPath = path.join(repoDir, "tracked.txt");
  writeFileSync(trackedPath, "before\n");
  git("add", ".gitignore", "tracked.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "fixture");

  const observer = createFileObserver();
  const ignoredDir = path.join(repoDir, "node_modules");
  const completedIgnoreUpdates: string[][] = [];
  let notifications = 0;
  let expectTrackedEdit = false;
  let trackedBatchReachedConsumer = false;
  // Observe the real subscription without replacing Git, filesystem, or watcher behavior.
  const fileObserver: FileObserver = {
    subscribe: async (directory, callback, options) => {
      const realSubscription = await observer.subscribe(
        directory,
        (error, events) => {
          const includesTrackedEdit =
            expectTrackedEdit && events.some((e) => e.path === trackedPath);
          const before = notifications;
          callback(error, events);
          if (includesTrackedEdit && notifications > before) trackedBatchReachedConsumer = true;
        },
        options,
      );
      return {
        updateIgnore: async (paths) => {
          await realSubscription.updateIgnore(paths);
          completedIgnoreUpdates.push([...paths]);
        },
        unsubscribe: () => realSubscription.unsubscribe(),
      };
    },
    getDiagnostics: () => observer.getDiagnostics(),
    close: () => observer.close(),
  };
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(tempDir, "home"),
    fileObserver,
  });
  let subscription: Awaited<ReturnType<typeof service.requestWorkingTreeWatch>> | undefined;
  try {
    subscription = await service.requestWorkingTreeWatch(repoDir, () => {
      notifications += 1;
    });
    for (let index = 0; index < 20; index += 1) {
      const directory = path.join(ignoredDir, `dependency-${index}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "index.js"), "first");
    }
    expect(git("ls-files", "-o", "-i", "--directory", "--exclude-standard")).toBe("node_modules/");
    await expect
      .poll(() => completedIgnoreUpdates.some((paths) => paths.includes(ignoredDir)), {
        timeout: 5_000,
      })
      .toBe(true);

    const atIgnoreBoundary = observer.getDiagnostics();
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(path.join(ignoredDir, `dependency-${index}`, "second.js"), "second");
    }
    expectTrackedEdit = true;
    writeFileSync(trackedPath, "after\n");
    await expect.poll(() => trackedBatchReachedConsumer, { timeout: 5_000 }).toBe(true);
    const afterTrackedEdit = observer.getDiagnostics();
    expect(afterTrackedEdit.nativeHandleCount).toBe(atIgnoreBoundary.nativeHandleCount);
    expect(afterTrackedEdit.nativeTrackedFileCount).toBe(atIgnoreBoundary.nativeTrackedFileCount);
    expect(
      afterTrackedEdit.nativeClassificationCount - atIgnoreBoundary.nativeClassificationCount,
    ).toBeLessThanOrEqual(1);
  } finally {
    subscription?.unsubscribe();
    await service.dispose();
    await observer.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}, 15_000);

test("Git refresh, command tracing and 10,000 ignored alias events do no synchronous IO", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const source = `
    import assert from 'node:assert/strict';
    import { write } from 'node:fs';
    import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { setImmediate as tick } from 'node:timers/promises';
    import { createHook } from 'node:async_hooks';
    import pino from 'pino';
    import { WorkspaceGitServiceImpl } from './packages/server/src/server/workspace-git-service.ts';
    import { runGitCommand } from './packages/server/src/utils/run-git-command.ts';
    import { writeJAgentDeskWorktreeMetadata } from './packages/server/src/utils/worktree-metadata.ts';
    const root = await mkdtemp(join(tmpdir(), 'git-async-contract-'));
    const home = join(root, 'home');
    const repo = join(root, 'repo');
    const worktree = join(home, 'worktrees', 'project', 'topic');
    const alias = join(root, 'alias');
    const logger = pino({ level: 'trace' }, { write() {} });
    // Async descriptor writes avoid Windows stderr's synchronous stream API.
    const marker = (label) => new Promise((resolve, reject) => {
      write(2, label + '\\n', (error) => error ? reject(error) : resolve());
    });
    let callback;
    let notifications = 0;
    const service = new WorkspaceGitServiceImpl({ logger, jagentdeskHome: home, deps: {
      subscribe: async (_root, onChange) => {
        callback = onChange;
        return { updateIgnore: async () => {}, unsubscribe: async () => {} };
      }
    } });
    try {
      await mkdir(repo);
      await runGitCommand(['init', '-b', 'main'], { cwd: repo });
      await runGitCommand(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'base'], { cwd: repo });
      await mkdir(join(home, 'worktrees', 'project'), { recursive: true });
      await runGitCommand(['worktree', 'add', '-b', 'topic', worktree], { cwd: repo });
      await writeJAgentDeskWorktreeMetadata(worktree, { baseRefName: 'main' });
      await writeFile(join(worktree, '.gitignore'), 'ignored/\\n');
      await mkdir(join(worktree, 'ignored'));
      await writeFile(join(worktree, 'ignored', 'noise'), 'noise');
      await symlink(worktree, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const subscription = await service.requestWorkingTreeWatch(alias, () => { notifications++; });
      const events = Array.from({ length: process.env.GIT_IO_TRACE ? 2 : 10000 }, (_, i) => ({ type: 'update', path: join(i % 2 ? alias : worktree, 'ignored', 'noise') }));
      // A shared CI runner can deschedule the child during a wall-clock sample.
      // Keep the 20ms gate, but take three independent batches and require one
      // responsive callback/timer pair. All batches must remain filesystem-free.
      const samples = [];
      for (let trial = 0; trial < (process.env.GIT_IO_TRACE ? 1 : 3); trial++) {
        await tick();
        let fsCalls = 0;
        const hook = createHook({ init(_id, type) { if (type.startsWith('FSREQ')) fsCalls++; } });
        await marker('FILTER_START');
        hook.enable();
        const started = performance.now();
        const pulse = new Promise((resolve) => setTimeout(() => resolve(performance.now() - started), 0));
        callback(null, events);
        const filterMs = performance.now() - started;
        hook.disable();
        const loopGapMs = await pulse;
        await marker('FILTER_END');
        assert.equal(fsCalls, 0, "filesystem calls");
        assert.equal(notifications, 0, "ignored event notification");
        samples.push({ filterMs, loopGapMs, fsCalls });
      }
      console.log(JSON.stringify({ ...samples[0], samples }));
      assert.ok(process.env.GIT_IO_TRACE || samples.some(({ filterMs, loopGapMs }) => filterMs < 20 && loopGapMs < 20), 'no responsive filter sample: ' + JSON.stringify(samples));
      // Alias identity remains useful after deletion: no per-event realpath can recover this file.
      callback(null, [{ type: 'delete', path: join(worktree, 'tracked.txt') }]);
      assert.equal(notifications, 1);
      await marker('REFRESH_START');
      const snapshot = await service.getSnapshot(worktree);
      assert.equal(snapshot.git.isGit, true);
      assert.equal(snapshot.git.isJAgentDeskOwnedWorktree, true);
      await runGitCommand(['status', '--porcelain'], { cwd: alias, logger });
      await marker('REFRESH_END');
      subscription.unsubscribe();
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  `;
  for (const tracing of [false, true]) {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        ...(tracing ? ["--trace-sync-io"] : []),
        "--input-type=module",
        "--eval",
        source,
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, GIT_IO_TRACE: tracing ? "1" : "" },
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).catch((error) => {
      throw new Error(String(error.stderr).replaceAll(/at .*/g, "[child stack omitted]"));
    });
    for (const phase of ["FILTER", "REFRESH"]) {
      const output = stderr.split(`${phase}_START\n`)[1]?.split(`${phase}_END\n`)[0];
      expect(output, `${phase}: synchronous filesystem IO`).toBe("");
    }
    expect(JSON.parse(stdout.trim().split("\n")[0])).toMatchObject({ fsCalls: 0 });
  }
}, 60_000);

test("Git event identity preserves Windows namespace, case and subtree boundaries", async () => {
  const { GitObservationPaths } = await import("./git-observation-paths.js");
  const paths = await GitObservationPaths.create("C:\\jagentdesk-observation-contract");
  const accept = paths.createEventFilter(["C:\\jagentdesk-observation-contract\\Build"]);
  expect(paths.relative("\\\\?\\C:\\JAGENTDESK-OBSERVATION-CONTRACT\\refs\\heads\\MixedCase")).toBe(
    "refs/heads/MixedCase",
  );
  expect(accept("\\\\?\\C:\\jagentdesk-observation-contract\\build\\noise")).toBe(false);
  expect(accept("C:\\jagentdesk-observation-contract\\BuildSibling\\file")).toBe(true);
});

test("concurrent alias requests establish one working-tree subscription", async () => {
  const { symlink } = await import("node:fs/promises");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "git-observation-concurrent-")));
  const repo = path.join(root, "repo");
  const alias = path.join(root, "alias");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  await symlink(repo, alias, process.platform === "win32" ? "junction" : "dir");
  let subscriptions = 0;
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(root, "home"),
    deps: {
      subscribe: async () => {
        subscriptions++;
        return { updateIgnore: async () => {}, unsubscribe: async () => {} };
      },
    },
  });
  try {
    const watches = await Promise.all([
      service.requestWorkingTreeWatch(repo, () => {}),
      service.requestWorkingTreeWatch(alias, () => {}),
    ]);
    expect(subscriptions).toBe(1);
    for (const watch of watches) watch.unsubscribe();
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git event identity retains a symlink's literal target before canonicalizing its parent", async () => {
  const { mkdir, symlink } = await import("node:fs/promises");
  const { GitObservationPaths } = await import("./git-observation-paths.js");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "git-observation-literal-target-")));
  const repository = path.join(root, "repository");
  const parentAlias = path.join(root, "parent-alias");
  const workspaceAlias = path.join(root, "workspace-alias");
  const literalTarget = path.join(parentAlias, "repository");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  try {
    await mkdir(repository);
    await symlink(root, parentAlias, linkType);
    await symlink(literalTarget, workspaceAlias, linkType);
    const paths = await GitObservationPaths.create(workspaceAlias);
    const accept = paths.createEventFilter([path.join(workspaceAlias, "ignored")]);
    for (const spelling of [workspaceAlias, literalTarget, repository]) {
      expect(paths.relative(path.join(spelling, "deleted.txt"))).toBe("deleted.txt");
      expect(accept(path.join(spelling, "ignored", "deleted.txt"))).toBe(false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "missing folders stop degraded Git polling and explicit refreshes, then recover",
  async () => {
    const artifacts = path.resolve(".artifacts");
    mkdirSync(artifacts, { recursive: true });
    const root = mkdtempSync(path.join(artifacts, "workspace-git-missing-"));
    const cwd = path.join(root, "repo");
    const initializeRepo = (branch: string) => {
      mkdirSync(cwd);
      execFileSync("git", ["init", "-b", branch], { cwd, stdio: "pipe" });
      writeFileSync(path.join(cwd, "README.md"), "fixture\n");
      execFileSync("git", ["add", "."], { cwd, stdio: "pipe" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "fixture",
        ],
        { cwd, stdio: "pipe" },
      );
    };
    initializeRepo("main");
    // Exceed the real Linux observer's directory limit to enter degraded polling.
    // No watcher errors or Git responses are injected.
    for (let index = 0; index < 5100; index++) {
      mkdirSync(path.join(cwd, `generated-${index}`));
    }
    const trace = path.join(root, "git.jsonl");
    writeFileSync(trace, "");
    const previousTrace = process.env.JAGENTDESK_GIT_TRACE_FILE;
    process.env.JAGENTDESK_GIT_TRACE_FILE = trace;
    let degraded = false;
    let suspended = false;
    const logger = pino(
      { level: "warn" },
      {
        write(line) {
          const message = JSON.parse(line).msg;
          if (message === "Failed to start working tree watcher; using degraded polling")
            degraded = true;
          if (
            message ===
            "Workspace folder no longer exists; suspended git observation until it is back"
          )
            suspended = true;
        },
      },
    );
    const service = new WorkspaceGitServiceImpl({
      logger,
      jagentdeskHome: path.join(root, "home"),
    });
    const subscription = service.registerWorkspace({ cwd }, () => {});
    const commandCount = async () => {
      await flushGitCommandTrace();
      return readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length;
    };
    try {
      await expect
        .poll(() => degraded && service.getMetrics().workspaceRefreshInFlightCount === 0, {
          timeout: 15_000,
        })
        .toBe(true);
      rmSync(cwd, { recursive: true, force: true });
      await expect.poll(() => suspended, { timeout: 15_000 }).toBe(true);
      await expect.poll(() => service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
      const commandsWhileMissing = await commandCount();
      await service.getSnapshot(cwd, {
        force: true,
        includeForge: false,
        reason: "refresh-button",
      });
      await service.refresh(cwd);
      expect(await commandCount()).toBe(commandsWhileMissing);
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      expect(await commandCount()).toBe(commandsWhileMissing);

      initializeRepo("restored");
      const snapshot = await service.getSnapshot(cwd, {
        force: true,
        includeForge: false,
        reason: "refresh-button",
      });
      expect(snapshot.git).toMatchObject({ isGit: true, currentBranch: "restored" });
      await expect.poll(() => service.getMetrics().repositoryWorkspaceLinkCount).toBe(1);
    } finally {
      subscription.unsubscribe();
      await service.dispose();
      if (previousTrace === undefined) delete process.env.JAGENTDESK_GIT_TRACE_FILE;
      else process.env.JAGENTDESK_GIT_TRACE_FILE = previousTrace;
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test("observation-driven refreshes run their Git work in the background lane", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jagentdesk-git-priority-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(root, "home"),
  });
  const heads: Array<string | null> = [];
  const subscription = service.registerWorkspace({ cwd: repo }, (snapshot) => {
    heads.push(snapshot.git.currentBranch);
  });
  cleanup.push(async () => {
    subscription.unsubscribe();
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  // Registration, observation setup and the first refresh settle before the
  // measured change.
  startGitCommandMetrics();
  await service.getSnapshot(repo, { includeForge: false });
  await waitForGitCommandMetricsIdle({ quietMs: 500, timeoutMs: 10_000 });
  stopGitCommandMetrics();

  startGitCommandMetrics();
  const deliveredBefore = heads.length;
  git("switch", "-c", "feature");
  await expect.poll(() => heads.slice(deliveredBefore), { timeout: 10_000 }).toContain("feature");
  await waitForGitCommandMetricsIdle({ quietMs: 300, timeoutMs: 10_000 });
  const observed = stopGitCommandMetrics().submissions;
  expect(observed.length).toBeGreaterThan(0);
  expect(new Set(observed.map((command) => command.priority))).toEqual(new Set(["background"]));

  startGitCommandMetrics();
  await service.getSnapshot(repo, { force: true, reason: "test-demand", includeForge: false });
  await service.getCheckout(repo, { priority: "background" });
  await waitForGitCommandMetricsIdle({ quietMs: 0, timeoutMs: 10_000 });
  const demand = stopGitCommandMetrics().submissions;
  const checkoutStart = demand.findIndex((command) => command.priority === "background");
  expect(checkoutStart).toBeGreaterThan(0);
  expect(new Set(demand.slice(0, checkoutStart).map((command) => command.priority))).toEqual(
    new Set(["normal"]),
  );
  expect(new Set(demand.slice(checkoutStart).map((command) => command.priority))).toEqual(
    new Set(["background"]),
  );

  startGitCommandMetrics();
  await runWithGitCommandPriority("high", () =>
    service.getSnapshot(repo, { force: true, reason: "test-user-action", includeForge: false }),
  );
  await waitForGitCommandMetricsIdle({ quietMs: 0, timeoutMs: 10_000 });
  const userAction = stopGitCommandMetrics().submissions;
  expect(userAction.length).toBeGreaterThan(0);
  expect(new Set(userAction.map((command) => command.priority))).toEqual(new Set(["high"]));
}, 30_000);

test("an edit made before the working-tree watcher starts still reaches the cached snapshot", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jagentdesk-git-coverage-gap-")));
  const repo = path.join(root, "repo");
  const trackedPath = path.join(repo, "src", "tracked.txt");
  mkdirSync(path.dirname(trackedPath), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(trackedPath, "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const observer = createFileObserver();
  const workingTreeWatchGate = Promise.withResolvers<void>();
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(root, "home"),
    deps: {
      subscribe: async (directory, callback, options) => {
        if (directory === repo) await workingTreeWatchGate.promise;
        return observer.subscribe(directory, callback, options);
      },
    },
  });
  const subscription = service.registerWorkspace({ cwd: repo }, () => {});
  cleanup.push(async () => {
    workingTreeWatchGate.resolve();
    subscription.unsubscribe();
    await service.dispose();
    await observer.close();
    rmSync(root, { recursive: true, force: true });
  });

  expect((await service.getSnapshot(repo, { includeForge: false })).git.isDirty).toBe(false);
  writeFileSync(trackedPath, "edited before the watcher started\n");
  workingTreeWatchGate.resolve();

  await expect
    .poll(async () => (await service.getSnapshot(repo, { includeForge: false })).git.isDirty, {
      timeout: 10_000,
    })
    .toBe(true);
}, 30_000);

test("a branch switch made before the Git metadata watcher starts still reaches the cached snapshot", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jagentdesk-git-metadata-gap-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  const observer = createFileObserver();
  const metadataWatchGate = Promise.withResolvers<void>();
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(root, "home"),
    deps: {
      subscribe: async (directory, callback, options) => {
        if (directory !== repo) await metadataWatchGate.promise;
        return observer.subscribe(directory, callback, options);
      },
    },
  });
  const subscription = service.registerWorkspace({ cwd: repo }, () => {});
  cleanup.push(async () => {
    metadataWatchGate.resolve();
    subscription.unsubscribe();
    await service.dispose();
    await observer.close();
    rmSync(root, { recursive: true, force: true });
  });

  expect((await service.getSnapshot(repo, { includeForge: false })).git.currentBranch).toBe("main");
  git("switch", "-c", "feature");
  metadataWatchGate.resolve();

  await expect
    .poll(
      async () => (await service.getSnapshot(repo, { includeForge: false })).git.currentBranch,
      { timeout: 10_000 },
    )
    .toBe("feature");
}, 30_000);

function createCheckoutWithOrigin(origin: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "jagentdesk-forge-web-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("remote", "add", "origin", origin);
  cleanup.push(async () =>
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  );
  return repo;
}

// The GitHub adapter runs for real; only the `gh` binary it spawns is scripted.
function createGitHubWithRepositoryView(repositoryView: object) {
  return createGitHubService({
    resolveGhPath: async () => "gh",
    resolveRepoHost: async () => null,
    runner: async (args) => {
      if (args[0] === "repo" && args[1] === "view") {
        return { stdout: JSON.stringify(repositoryView), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
}

async function snapshotOf(
  repo: string,
  deps: ConstructorParameters<typeof WorkspaceGitServiceImpl>[0]["deps"],
) {
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps,
  });
  cleanup.push(() => service.dispose());
  return {
    service,
    snapshot: await service.getSnapshot(repo, { force: true, reason: "forge-web-test" }),
  };
}

async function expectForgeWebEventually(
  service: WorkspaceGitServiceImpl,
  repo: string,
  expected: { host: string; referenceRepository?: string },
) {
  await expect
    .poll(async () => (await service.getSnapshot(repo, { includeForge: false })).forgeWeb, {
      timeout: 10_000,
    })
    .toEqual(expected);
}

test("an SSH config alias remote publishes the web host the alias resolves to", async () => {
  const repo = createCheckoutWithOrigin("git@github.com-work:acme/repo.git");

  const { snapshot } = await snapshotOf(repo, {
    resolveSshHostname: async (host) => (host === "github.com-work" ? "github.com" : null),
    forgeOverrides: { github: createGitHubWithRepositoryView({}) },
  });

  expect(snapshot.forgeWeb).toEqual({ host: "github.com" });
});

test("a cloud SSH host publishes the forge's web host", async () => {
  const repo = createCheckoutWithOrigin("ssh://git@ssh.github.com/acme/repo.git");

  const { snapshot } = await snapshotOf(repo, {
    forgeOverrides: { github: createGitHubWithRepositoryView({}) },
  });

  expect(snapshot.forgeWeb).toEqual({ host: "github.com" });
});

test("a fork checkout publishes its parent as the repository that owns issue and pull request numbers", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");

  const { service, snapshot } = await snapshotOf(repo, {
    forgeOverrides: {
      github: createGitHubWithRepositoryView({
        owner: { login: "fork-owner" },
        name: "repo",
        parent: { owner: { login: "main-owner" }, name: "repo" },
      }),
    },
  });

  // The host is available with the first snapshot; the parent follows in a background update.
  expect(snapshot.forgeWeb).toEqual({ host: "github.com" });
  await expectForgeWebEventually(service, repo, {
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });
});

test("a plain remote publishes no separate reference repository", async () => {
  const repo = createCheckoutWithOrigin("https://github.com/acme/repo.git");

  const { service, snapshot } = await snapshotOf(repo, {
    forgeOverrides: {
      github: createGitHubWithRepositoryView({ owner: { login: "acme" }, name: "repo" }),
    },
  });

  expect(snapshot.forgeWeb).toEqual({ host: "github.com" });
  await expectForgeWebEventually(service, repo, { host: "github.com" });
});

test("a remote on no forge publishes no web location", async () => {
  const repo = createCheckoutWithOrigin("git@bitbucket.org:acme/repo.git");

  const { snapshot } = await snapshotOf(repo, { resolveSshHostname: async () => null });

  expect(snapshot.forgeWeb).toBeUndefined();
});

test("changing the origin remote publishes the new remote's web location, not the previous one", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps: {
      resolveSshHostname: async (host) => (host === "github.com-work" ? "github.com" : null),
      forgeOverrides: {
        github: createGitHubService({
          resolveGhPath: async () => "gh",
          resolveRepoHost: async () => null,
          runner: async (args) => {
            if (args[0] === "repo" && args[1] === "view") {
              const isFork = args[2] === "fork-owner/repo";
              return {
                stdout: JSON.stringify(
                  isFork
                    ? {
                        owner: { login: "fork-owner" },
                        name: "repo",
                        parent: { owner: { login: "main-owner" }, name: "repo" },
                      }
                    : { owner: { login: "acme" }, name: "other" },
                ),
                stderr: "",
              };
            }
            return { stdout: "", stderr: "" };
          },
        }),
      },
    },
  });
  cleanup.push(() => service.dispose());
  const before = await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  await expectForgeWebEventually(service, repo, {
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });

  execFileSync("git", ["remote", "set-url", "origin", "git@github.com-work:acme/other.git"], {
    cwd: repo,
  });
  // The refresh a `.git/config` change schedules does not ask for forge data.
  const after = await service.getSnapshot(repo, {
    force: true,
    includeForge: false,
    reason: "forge-web-test",
  });

  expect(after.git.remoteUrl).toBe("git@github.com-work:acme/other.git");
  expect(after.forgeWeb).toEqual({ host: "github.com" });
  expect(before.forgeWeb).toEqual({ host: "github.com" });
}, 30_000);

test("a failed parent lookup is retried by the pull request status poll, keeping the host an SSH alias resolves to", async () => {
  const repo = createCheckoutWithOrigin("git@github.com-work:fork-owner/repo.git");
  let nowMs = Date.parse("2026-01-01T00:00:00Z");
  let ghAnswers = false;
  let lookups = 0;
  let pollStatus: ((status: null) => void) | undefined;
  const github = createGitHubService({
    resolveGhPath: async () => "gh",
    resolveRepoHost: async () => null,
    runner: async (args) => {
      // The reference lookup names the origin repository; the PR status load asks for the cwd repo.
      if (args[0] === "repo" && args[1] === "view" && args[2] === "fork-owner/repo") {
        lookups += 1;
        if (!ghAnswers) {
          throw new GitHubCommandError({
            args,
            cwd: repo,
            exitCode: 1,
            stderr: "error connecting to api.github.com",
          });
        }
        return {
          stdout: JSON.stringify({
            owner: { login: "fork-owner" },
            name: "repo",
            parent: { owner: { login: "main-owner" }, name: "repo" },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
  });
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps: {
      now: () => new Date(nowMs),
      resolveSshHostname: async (host) => (host === "github.com-work" ? "github.com" : null),
      forgeOverrides: {
        // The adapter is real; only the poll is driven by the test instead of a timer.
        github: Object.assign(Object.create(github), {
          retainCurrentPullRequestStatusPoll: (options: { onStatus?: (status: null) => void }) => {
            pollStatus = options.onStatus;
            return { unsubscribe: () => {} };
          },
        }),
      },
    },
  });
  const subscription = service.registerWorkspace({ cwd: repo }, () => {});
  cleanup.push(async () => {
    subscription.unsubscribe();
    await service.dispose();
  });

  const failed = await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  expect(failed.forgeWeb).toEqual({ host: "github.com" });
  await expect.poll(() => pollStatus, { timeout: 10_000 }).toBeDefined();
  await expect.poll(() => lookups, { timeout: 10_000 }).toBe(1);
  // Let the failed lookup record its retry time before advancing the clock.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  ghAnswers = true;
  nowMs += 61_000;
  pollStatus?.(null);

  await expectForgeWebEventually(service, repo, {
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });
  const forced = await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  expect(forced.forgeWeb).toEqual({ host: "github.com", referenceRepository: "main-owner/repo" });
}, 30_000);

test("a successful parent lookup is reused across forced refreshes of the same remote", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");
  let repositoryViews = 0;
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps: {
      forgeOverrides: {
        github: createGitHubService({
          resolveGhPath: async () => "gh",
          resolveRepoHost: async () => null,
          runner: async (args) => {
            if (args[0] === "repo" && args[1] === "view") {
              // The parent lookup is the one that names the origin repository.
              if (args[2] === "fork-owner/repo") repositoryViews += 1;
              return {
                stdout: JSON.stringify({
                  owner: { login: "fork-owner" },
                  name: "repo",
                  parent: { owner: { login: "main-owner" }, name: "repo" },
                }),
                stderr: "",
              };
            }
            return { stdout: "", stderr: "" };
          },
        }),
      },
    },
  });
  cleanup.push(() => service.dispose());

  await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });

  await expectForgeWebEventually(service, repo, {
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });
  expect(repositoryViews).toBe(1);
});

test("a fork checked out at a detached HEAD still publishes its parent", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");
  execFileSync("git", ["checkout", "--detach"], { cwd: repo, stdio: "pipe" });

  const { service, snapshot } = await snapshotOf(repo, {
    forgeOverrides: {
      github: createGitHubWithRepositoryView({
        owner: { login: "fork-owner" },
        name: "repo",
        parent: { owner: { login: "main-owner" }, name: "repo" },
      }),
    },
  });

  expect(snapshot.forgeWeb).toEqual({ host: "github.com" });
  await expectForgeWebEventually(service, repo, {
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });
});

test("a parent lookup that finishes during a refresh keeps its answer", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const statusLoadStarted = Promise.withResolvers<void>();
  const releaseStatusLoad = Promise.withResolvers<void>();
  let holdNextStatusLoad = false;
  let repositoryViews = 0;
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps: {
      forgeOverrides: {
        github: createGitHubService({
          resolveGhPath: async () => "gh",
          resolveRepoHost: async () => null,
          runner: async (args) => {
            if (args[0] === "auth" && args[1] === "status" && holdNextStatusLoad) {
              holdNextStatusLoad = false;
              statusLoadStarted.resolve();
              await releaseStatusLoad.promise;
            }
            if (args[0] === "repo" && args[1] === "view" && args[2] === "fork-owner/repo") {
              repositoryViews += 1;
              if (repositoryViews === 1) {
                lookupStarted.resolve();
                await releaseLookup.promise;
              }
              return {
                stdout: JSON.stringify({
                  owner: { login: "fork-owner" },
                  name: "repo",
                  parent: { owner: { login: "main-owner" }, name: "repo" },
                }),
                stderr: "",
              };
            }
            return { stdout: "", stderr: "" };
          },
        }),
      },
    },
  });
  cleanup.push(() => service.dispose());

  await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  await lookupStarted.promise;

  holdNextStatusLoad = true;
  const second = service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  await statusLoadStarted.promise;

  // The first refresh's lookup finishes while the second refresh is still loading the PR status.
  releaseLookup.resolve();
  await expectForgeWebEventually(service, repo, {
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });
  releaseStatusLoad.resolve();

  const snapshot = await second;
  expect(snapshot.forgeWeb).toEqual({
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });
  expect(repositoryViews).toBe(1);
}, 30_000);

test("disposal waits for a background parent lookup", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps: {
      forgeOverrides: {
        github: createGitHubService({
          resolveGhPath: async () => "gh",
          resolveRepoHost: async () => null,
          runner: async (args) => {
            if (args[0] === "repo" && args[1] === "view" && args[2] === "fork-owner/repo") {
              lookupStarted.resolve();
              await releaseLookup.promise;
              return {
                stdout: JSON.stringify({
                  owner: { login: "fork-owner" },
                  name: "repo",
                  parent: { owner: { login: "main-owner" }, name: "repo" },
                }),
                stderr: "",
              };
            }
            return { stdout: "", stderr: "" };
          },
        }),
      },
    },
  });

  try {
    await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
    await lookupStarted.promise;

    let disposed = false;
    const disposal = service.dispose().then(() => {
      disposed = true;
      return undefined;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(disposed).toBe(false);

    releaseLookup.resolve();
    await disposal;
    expect(disposed).toBe(true);
  } finally {
    releaseLookup.resolve();
    await service.dispose();
  }
}, 30_000);

test("the first snapshot publishes git state and pull request status without waiting for the parent lookup", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");
  writeFileSync(path.join(repo, "changed.txt"), "dirty\n");
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const pullRequestStatusLoaded = Promise.withResolvers<void>();
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps: {
      forgeOverrides: {
        github: createGitHubService({
          resolveGhPath: async () => "gh",
          resolveRepoHost: async () => null,
          runner: async (args) => {
            if (args[0] === "repo" && args[1] === "view" && args[2] === "fork-owner/repo") {
              lookupStarted.resolve();
              await releaseLookup.promise;
              return {
                stdout: JSON.stringify({
                  owner: { login: "fork-owner" },
                  name: "repo",
                  parent: { owner: { login: "main-owner" }, name: "repo" },
                }),
                stderr: "",
              };
            }
            if (args[0] === "pr" && args[1] === "view") {
              pullRequestStatusLoaded.resolve();
              return {
                stdout: JSON.stringify({
                  number: 42,
                  url: "https://github.com/fork-owner/repo/pull/42",
                  title: "Already known pull request",
                  state: "OPEN",
                  baseRefName: "main",
                  headRefName: "main",
                  mergedAt: null,
                }),
                stderr: "",
              };
            }
            return { stdout: "", stderr: "" };
          },
        }),
      },
    },
  });
  cleanup.push(() => service.dispose());

  let snapshot: Awaited<ReturnType<typeof service.getSnapshot>> | null = null;
  const pending = service
    .getSnapshot(repo, { force: true, reason: "forge-web-test" })
    .then((value) => {
      snapshot = value;
      return value;
    });

  await pullRequestStatusLoaded.promise;
  // The forge lookup is still held here; the snapshot must not wait for it.
  await expect.poll(() => snapshot !== null, { timeout: 5_000 }).toBe(true);
  expect(snapshot).not.toBeNull();
  expect(snapshot!.git.currentBranch).toBe("main");
  expect(snapshot!.git.isDirty).toBe(true);
  expect(snapshot!.forge.pullRequest?.number).toBe(42);
  expect(snapshot!.forgeWeb).toEqual({ host: "github.com" });

  await lookupStarted.promise;
  releaseLookup.resolve();
  await pending;
  await expectForgeWebEventually(service, repo, {
    host: "github.com",
    referenceRepository: "main-owner/repo",
  });
}, 30_000);

test("a failed parent lookup is not repeated by forced refreshes before the retry delay", async () => {
  const repo = createCheckoutWithOrigin("git@github.com:fork-owner/repo.git");
  let lookups = 0;
  const service = new WorkspaceGitServiceImpl({
    logger: pino({ enabled: false }),
    jagentdeskHome: path.join(path.dirname(repo), "home"),
    deps: {
      forgeOverrides: {
        github: createGitHubService({
          resolveGhPath: async () => "gh",
          resolveRepoHost: async () => null,
          runner: async (args) => {
            if (args[0] === "repo" && args[1] === "view" && args[2] === "fork-owner/repo") {
              lookups += 1;
              throw new GitHubCommandError({
                args,
                cwd: repo,
                exitCode: 1,
                stderr: "error connecting to api.github.com",
              });
            }
            return { stdout: "", stderr: "" };
          },
        }),
      },
    },
  });
  cleanup.push(() => service.dispose());

  await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  await expect.poll(() => lookups, { timeout: 10_000 }).toBe(1);
  // Let the failed lookup record its retry time.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });
  await service.getSnapshot(repo, { force: true, reason: "forge-web-test" });

  expect(lookups).toBe(1);
}, 30_000);
