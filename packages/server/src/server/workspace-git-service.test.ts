import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path, { join } from "node:path";
import type pino from "pino";
import type { ForgeService } from "../services/forge-service.js";
import type {
  CheckoutSnapshotFacts,
  CheckoutStatusGit,
  PullRequestStatusResult,
} from "../utils/checkout-git.js";
import {
  BACKGROUND_GIT_FETCH_INTERVAL_MS,
  WORKSPACE_GIT_OBSERVATION_REENSURE_INTERVAL_MS,
  WorkspaceGitServiceImpl,
  WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS,
  type WorkspaceGitRuntimeSnapshot,
  workspaceFolderExists,
} from "./workspace-git-service.js";

const REPO_CWD = path.resolve("/tmp/repo");

function createLogger() {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger;
}

function createSnapshot(
  cwd: string,
  overrides?: {
    git?: Partial<WorkspaceGitRuntimeSnapshot["git"]>;
    forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]>;
  },
): WorkspaceGitRuntimeSnapshot {
  const base: WorkspaceGitRuntimeSnapshot = {
    cwd,
    git: {
      isGit: true,
      repoRoot: cwd,
      mainRepoRoot: null,
      currentBranch: "main",
      remoteUrl: "https://github.com/acme/repo.git",
      isJAgentDeskOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 0, behind: 0 },
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 1, deletions: 0 },
    },
    forge: {
      featuresEnabled: true,
      pullRequest: {
        url: "https://github.com/acme/repo/pull/123",
        title: "Update feature",
        state: "open",
        baseRefName: "main",
        headRefName: "feature",
        isMerged: false,
      },
      error: null,
    },
  };

  const featuresEnabled = overrides?.forge?.featuresEnabled ?? base.forge.featuresEnabled;
  const authState =
    overrides?.forge?.authState ?? (featuresEnabled ? "authenticated" : "no_remote");
  const forgeName = resolveSnapshotForgeName(featuresEnabled, overrides);
  return {
    cwd,
    git: {
      ...base.git,
      ...overrides?.git,
    },
    forge: {
      ...base.forge,
      ...overrides?.forge,
      featuresEnabled,
      authState,
      ...(forgeName ? { forge: forgeName } : {}),
      pullRequest: resolveSnapshotPullRequest(base, overrides),
      error: resolveSnapshotError(base, overrides),
    },
    // Every remote these fixtures use is on github.com.
    ...(forgeName ? { forgeWeb: { host: "github.com" } } : {}),
  };
}

function hasForgeOverride(
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
  key: keyof WorkspaceGitRuntimeSnapshot["forge"],
): boolean {
  return Boolean(overrides?.forge && key in overrides.forge);
}

function resolveSnapshotForgeName(
  featuresEnabled: boolean,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): string | undefined {
  if (hasForgeOverride(overrides, "forge")) {
    return overrides?.forge?.forge;
  }
  return featuresEnabled ? "github" : undefined;
}

function resolveSnapshotPullRequest(
  base: WorkspaceGitRuntimeSnapshot,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"] {
  if (hasForgeOverride(overrides, "pullRequest")) {
    return overrides?.forge?.pullRequest ?? null;
  }
  return base.forge.pullRequest;
}

function resolveSnapshotError(
  base: WorkspaceGitRuntimeSnapshot,
  overrides: { forge?: Partial<WorkspaceGitRuntimeSnapshot["forge"]> } | undefined,
): WorkspaceGitRuntimeSnapshot["forge"]["error"] {
  if (hasForgeOverride(overrides, "error")) {
    return overrides?.forge?.error ?? null;
  }
  return base.forge.error;
}

function createCheckoutStatus(
  cwd: string,
  overrides?: Partial<CheckoutStatusGit>,
): CheckoutStatusGit {
  return {
    isGit: true,
    repoRoot: cwd,
    mainRepoRoot: null,
    currentBranch: "main",
    isDirty: false,
    baseRef: "main",
    aheadBehind: { ahead: 0, behind: 0 },
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    hasRemote: true,
    remoteUrl: "https://github.com/acme/repo.git",
    isJAgentDeskOwnedWorktree: false,
    ...overrides,
  };
}

function createCheckoutSnapshotFacts(cwd: string): CheckoutSnapshotFacts {
  return {
    isGit: true,
    worktreeRoot: cwd,
    currentBranch: "main",
    remoteUrl: "https://github.com/acme/repo.git",
    absoluteGitDir: join(cwd, ".git"),
    gitCommonDir: join(cwd, ".git"),
    jagentdeskWorktree: { isJAgentDeskOwnedWorktree: false },
    storedBaseRef: null,
    resolvedBaseRef: "main",
    mainRepoRoot: null,
    comparisonBaseRef: null,
    branchRemoteName: "origin",
    branchMergeRef: "refs/heads/main",
    pullRequestLookupTarget: { headRef: "main" },
  };
}

function createPullRequestStatusResult(
  overrides?: Partial<PullRequestStatusResult>,
): PullRequestStatusResult {
  return {
    status: {
      url: "https://github.com/acme/repo/pull/123",
      title: "Update feature",
      state: "open",
      baseRefName: "main",
      headRefName: "feature",
      isMerged: false,
    },
    authState: "authenticated",
    featuresEnabled: true,
    githubFeaturesEnabled: true,
    ...overrides,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAsyncSubscription() {
  return { unsubscribe: vi.fn(() => Promise.resolve()) };
}

function createGitHubServiceStub(): ForgeService {
  return {
    listPullRequests: vi.fn(async () => []),
    listIssues: vi.fn(async () => []),
    searchIssuesAndPrs: vi.fn(async () => ({
      items: [],
      featuresEnabled: true,
      githubFeaturesEnabled: true,
    })),
    getPullRequest: vi.fn(async () => ({
      number: 1,
      title: "PR",
      url: "https://github.com/acme/repo/pull/1",
      state: "OPEN",
      body: null,
      baseRefName: "main",
      headRefName: "feature",
      labels: [],
    })),
    getPullRequestHeadRef: vi.fn(async () => "feature"),
    getPullRequestCheckoutTarget: vi.fn(async ({ number }) => ({
      number,
      baseRefName: "main",
      headRefName: "feature",
      headOwnerLogin: null,
      headRepositorySshUrl: null,
      headRepositoryUrl: null,
      isCrossRepository: false,
    })),
    getCurrentPullRequestStatus: vi.fn(async () => null),
    createPullRequest: vi.fn(async () => ({
      url: "https://github.com/acme/repo/pull/1",
      number: 1,
    })),
    mergePullRequest: vi.fn(async () => ({ success: true })),
    isAuthenticated: vi.fn(async () => true),
    authProbeCanThrow: true,
    invalidate: vi.fn(),
  };
}

interface CreateServiceTestOptions {
  subscribe?: ReturnType<typeof vi.fn>;
  getCheckoutStatus?: ReturnType<typeof vi.fn>;
  getCheckoutSnapshotFacts?: (cwd: string) => Promise<CheckoutSnapshotFacts>;
  getCheckoutShortstat?: ReturnType<typeof vi.fn>;
  getCheckoutWorktreeState?: ReturnType<typeof vi.fn>;
  getPullRequestStatus?: ReturnType<typeof vi.fn>;
  github?: ForgeService;
  resolveAbsoluteGitDir?: ReturnType<typeof vi.fn>;
  hasOriginRemote?: ReturnType<typeof vi.fn>;
  runGitFetch?: ReturnType<typeof vi.fn>;
  runGitCommand?: ReturnType<typeof vi.fn>;
  getWorkspaceGitSelfHealPhaseMs?: (cwd: string) => number;
  workspaceFolderExists?: (cwd: string) => Promise<boolean>;
  now?: () => Date;
}

function buildDefaultTestServiceDeps() {
  return {
    subscribe: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })),
    getCheckoutSnapshotFacts: vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd)),
    getCheckoutStatus: vi.fn(async (cwd: string) => createCheckoutStatus(cwd)),
    getCheckoutShortstat: vi.fn(async () => ({
      additions: 1,
      deletions: 0,
    })),
    getCheckoutWorktreeState: vi.fn(),
    getPullRequestStatus: vi.fn(async () => createPullRequestStatusResult()),
    forgeOverrides: { github: createGitHubServiceStub() },
    resolveAbsoluteGitDir: vi.fn(async () => join(REPO_CWD, ".git")),
    hasOriginRemote: vi.fn(async () => false),
    runGitFetch: vi.fn(async () => {}),
    runGitCommand: vi.fn(async () => ({
      stdout: `${REPO_CWD}\n`,
      stderr: "",
      truncated: false,
      exitCode: 0,
      signal: null,
    })),
    getWorkspaceGitSelfHealPhaseMs: vi.fn(() => 30_000),
    workspaceFolderExists: vi.fn(async () => true),
    createWatcherLivenessCanary: vi.fn(() => ({
      path: "",
      filterEvents: (events) => events,
      verify: vi.fn(async () => {}),
    })),
    now: () => new Date("2026-04-12T00:00:00.000Z"),
  };
}

// Registering a workspace reads the checkout twice: once at start and once
// when observation setup establishes watcher coverage.
function createService(options?: CreateServiceTestOptions, releaseGraceMs = 0) {
  const deps = { ...buildDefaultTestServiceDeps(), ...options };
  deps.getCheckoutWorktreeState =
    options?.getCheckoutWorktreeState ??
    vi.fn(async (cwd: string) => {
      const status = await deps.getCheckoutStatus(cwd);
      if (!status.isGit) {
        throw new Error("Expected a git checkout");
      }
      return {
        isDirty: status.isDirty,
        diffStat: await deps.getCheckoutShortstat(),
      };
    });
  return new WorkspaceGitServiceImpl({
    logger: createLogger() as unknown as pino.Logger,
    jagentdeskHome: "/tmp/jagentdesk-test",
    deps,
    releaseGraceMs,
  });
}

type WatchCallback = (error: Error | null, events: Array<{ path: string; type: "update" }>) => void;

interface FolderBackedGitOptions {
  facts?: (cwd: string) => CheckoutSnapshotFacts;
  unwatchableDirectories?: string[];
  heldWatch?: { directory: string; release: Promise<void> };
}

function createFolderBackedGit(options?: FolderBackedGitOptions) {
  const watchCallbacks = new Map<string, WatchCallback>();
  const subscribe = vi.fn(async (directory: string, callback: WatchCallback) => {
    if (!existsSync(directory) || options?.unwatchableDirectories?.includes(directory)) {
      throw new Error(`Cannot watch ${directory}`);
    }
    if (options?.heldWatch?.directory === directory) {
      await options.heldWatch.release;
    }
    watchCallbacks.set(directory, callback);
    return createAsyncSubscription();
  });
  const getCheckoutSnapshotFacts = vi.fn(
    async (cwd: string): Promise<CheckoutSnapshotFacts> =>
      existsSync(cwd) ? (options?.facts ?? createCheckoutSnapshotFacts)(cwd) : { isGit: false },
  );
  const getCheckoutStatus = vi.fn(async (cwd: string) =>
    existsSync(cwd) ? createCheckoutStatus(cwd) : ({ isGit: false } as const),
  );
  const getCheckoutShortstat = vi.fn(async (_cwd: string) => ({ additions: 1, deletions: 0 }));
  const getCheckoutWorktreeState = vi.fn(async (_cwd: string) => ({
    isDirty: false,
    diffStat: { additions: 1, deletions: 0 },
  }));
  const runGitCommand = vi.fn(async (args: string[], runOptions: { cwd: string }) => ({
    stdout: args[0] === "rev-parse" ? `${runOptions.cwd}\n` : "",
    stderr: "",
    truncated: false,
    exitCode: 0,
    signal: null,
  }));
  const runGitFetch = vi.fn(async (_cwd: string) => ({ changes: [], error: null }));
  const callsIn = (fake: ReturnType<typeof vi.fn>, cwd: string) =>
    fake.mock.calls.filter(([calledCwd]) => calledCwd === cwd).length;

  return {
    deps: {
      subscribe,
      getCheckoutSnapshotFacts,
      getCheckoutStatus,
      getCheckoutShortstat,
      getCheckoutWorktreeState,
      runGitCommand,
      runGitFetch,
      workspaceFolderExists: async (cwd: string) => existsSync(cwd),
      now: () => new Date(),
    },
    watchCallbackFor(directory: string): WatchCallback {
      const callback = watchCallbacks.get(directory);
      if (!callback) {
        throw new Error(`No watcher was started for ${directory}`);
      }
      return callback;
    },
    watchAttemptsFor: (directory: string) => callsIn(subscribe, directory),
    pollsOf: (cwd: string) => callsIn(getCheckoutShortstat, cwd),
    fetchesIn: (cwd: string) => callsIn(runGitFetch, cwd),
    gitCommandsIn(cwd: string): number {
      const cwdCommands = [
        getCheckoutSnapshotFacts,
        getCheckoutStatus,
        getCheckoutShortstat,
        getCheckoutWorktreeState,
        runGitFetch,
      ].reduce((count, fake) => count + callsIn(fake, cwd), 0);
      const commandsRunInCwd = runGitCommand.mock.calls.filter(
        ([, runOptions]) => runOptions.cwd === cwd,
      ).length;
      return cwdCommands + commandsRunInCwd;
    },
  };
}

function linkedWorktreeFacts(gitCommonDir: string) {
  return (cwd: string): CheckoutSnapshotFacts => ({
    ...createCheckoutSnapshotFacts(cwd),
    absoluteGitDir: join(gitCommonDir, "worktrees", path.basename(cwd)),
    gitCommonDir,
  });
}

const SETTLE_ATTEMPTS = 1_000;

async function settle(assertion: () => void): Promise<void> {
  let lastFailure: unknown = null;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    try {
      assertion();
      return;
    } catch (failure) {
      lastFailure = failure;
    }
    await vi.advanceTimersByTimeAsync(0);
  }
  throw lastFailure;
}

async function waitForRefreshesToSettle(service: WorkspaceGitServiceImpl): Promise<void> {
  await settle(() => {
    expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
  });
}

async function waitForObservationToSettle(
  service: WorkspaceGitServiceImpl,
  repositoryWorkspaceLinkCount: number,
): Promise<void> {
  await settle(() => {
    const metrics = service.getMetrics();
    expect(metrics.repositoryWorkspaceLinkCount).toBe(repositoryWorkspaceLinkCount);
    expect(metrics.workspaceObservationSetupInFlightCount).toBe(0);
    expect(metrics.workspaceRefreshInFlightCount).toBe(0);
  });
}

async function advanceThroughDegradedPolls(service: WorkspaceGitServiceImpl): Promise<void> {
  for (const delayMs of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    await vi.advanceTimersByTimeAsync(delayMs);
    await waitForRefreshesToSettle(service);
  }
}

async function advanceThroughWorkingTreeRecoveryAttempts(
  service: WorkspaceGitServiceImpl,
): Promise<void> {
  for (const delayMs of [30_000, 60_000, 120_000]) {
    await vi.advanceTimersByTimeAsync(delayMs);
    await waitForRefreshesToSettle(service);
  }
}

// Stalls every subscription for `watchPath` the way a CPU-starved startup scan does, until the
// service aborts it at the subscribe deadline. Other paths subscribe immediately.
function createStallingWatchSetup(watchPath: string) {
  const signals: AbortSignal[] = [];
  let acceptNext = false;
  let acceptedCallback: WatchCallback | null = null;
  const subscribe = vi.fn(
    async (directory: string, callback: WatchCallback, options?: { signal?: AbortSignal }) => {
      if (directory !== watchPath) {
        return createAsyncSubscription();
      }
      const signal = options?.signal ?? new AbortController().signal;
      signals.push(signal);
      if (acceptNext) {
        acceptNext = false;
        acceptedCallback = callback;
        return createAsyncSubscription();
      }
      return new Promise<ReturnType<typeof createAsyncSubscription>>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  );
  return {
    subscribe,
    signals,
    acceptNextAttempt() {
      acceptNext = true;
    },
    failAcceptedWatcher() {
      acceptedCallback?.(new Error("accepted watcher stopped"), []);
    },
    async expectAttemptAbortedAtDeadline() {
      const signal = signals.at(-1);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(WORKSPACE_GIT_WATCHER_SUBSCRIBE_TIMEOUT_MS);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toMatchObject({ name: "WorkspaceGitWatcherSubscriptionTimeoutError" });
    },
    async expectNextAttemptAfter(delayMs: number, service: WorkspaceGitServiceImpl) {
      const attempts = signals.length;
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      await waitForRefreshesToSettle(service);
      expect(signals).toHaveLength(attempts);
      await vi.advanceTimersByTimeAsync(1);
      await settle(() => expect(signals).toHaveLength(attempts + 1));
    },
  };
}

describe("WorkspaceGitServiceImpl", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("registerWorkspace returns a subscription without an initial snapshot contract", async () => {
    const service = createService();
    const workspaceRuntimeStore = createWorkspaceRuntimeStore();
    service.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));

    const listener = vi.fn();
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(subscription).toEqual({ unsubscribe: expect.any(Function) });
    expect("initial" in subscription).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(workspaceRuntimeStore.get(REPO_CWD)).toBeNull();

    subscription.unsubscribe();
    service.dispose();
  });

  test("shared watches publish to the runtime store before listeners and retain data after teardown", async () => {
    const subscribe = vi.fn(async () => createAsyncSubscription());
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const service = createService({ subscribe, getPullRequestStatus });
    const store = createWorkspaceRuntimeStore();
    service.onSnapshotUpdated((snapshot) => store.set(snapshot));
    const observed: WorkspaceGitRuntimeSnapshot[] = [];
    const listener = (snapshot: WorkspaceGitRuntimeSnapshot) => {
      expect(store.get(REPO_CWD)).toBe(snapshot);
      observed.push(snapshot);
    };
    const first = service.registerWorkspace({ cwd: REPO_CWD }, listener);
    const second = service.registerWorkspace({ cwd: join(REPO_CWD, ".") }, (snapshot) =>
      listener(snapshot),
    );
    await service.getSnapshot(REPO_CWD, { force: true, reason: "runtime-store" });
    await flushPromises();
    expect(observed.length).toBeGreaterThan(0);
    expect(service.getMetrics().workspaceTargetCount).toBe(1);
    const subscriptionCount = subscribe.mock.calls.length;
    const snapshot = store.get(REPO_CWD);
    expect(snapshot?.forge.pullRequest).not.toBeNull();
    first.unsubscribe();
    expect(service.getMetrics().workspaceListenerCount).toBe(1);
    second.unsubscribe();
    expect(service.getMetrics().workspaceTargetCount).toBe(0);
    const pollCount = getPullRequestStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(360_000);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(pollCount);
    expect(subscribe).toHaveBeenCalledTimes(subscriptionCount);
    expect(store.get(REPO_CWD)).toBe(snapshot);
    await service.dispose();
  });

  test("a client reconnecting within the release grace reuses the warm target", async () => {
    const getCheckoutStatus = vi.fn(buildDefaultTestServiceDeps().getCheckoutStatus);
    const service = createService({ getCheckoutStatus }, 90_000);
    try {
      const first = service.registerWorkspace({ cwd: REPO_CWD }, () => {});
      const snapshot = await service.getSnapshot(REPO_CWD);
      await waitForObservationToSettle(service, 1);
      first.unsubscribe();
      expect(service.getMetrics().workspaceTargetCount).toBe(1);
      const reads = getCheckoutStatus.mock.calls.length;

      const second = service.registerWorkspace({ cwd: REPO_CWD }, () => {});
      await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(snapshot);
      expect(getCheckoutStatus).toHaveBeenCalledTimes(reads);
      second.unsubscribe();

      await vi.advanceTimersByTimeAsync(90_000);
      expect(service.getMetrics().workspaceTargetCount).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  test("onSnapshotUpdated delivers without workspace subscribers and can unsubscribe", async () => {
    const service = createService();
    const snapshots: WorkspaceGitRuntimeSnapshot[] = [];
    const subscription = service.onSnapshotUpdated((snapshot) => snapshots.push(snapshot));
    try {
      const initial = await service.getSnapshot(REPO_CWD);
      expect(snapshots).toEqual([initial]);
      expect(service.getMetrics().workspaceListenerCount).toBe(0);

      await service.getSnapshot(REPO_CWD);
      expect(snapshots).toEqual([initial]);

      const refreshed = await service.getSnapshot(REPO_CWD, {
        force: true,
        reason: "unobserved-refresh",
      });
      expect(snapshots).toEqual([initial, refreshed]);

      subscription.unsubscribe();
      await service.getSnapshot(REPO_CWD, { force: true, reason: "after-unsubscribe" });
      expect(snapshots).toEqual([initial, refreshed]);
    } finally {
      await service.dispose();
    }
  });

  test("a retired target's late refresh cannot overwrite the runtime store's newer snapshot", async () => {
    const retiredRead = createDeferred<PullRequestStatusResult>();
    const retiredReadStarted = createDeferred<void>();
    const merged = createPullRequestStatusResult();
    if (!merged.status) throw new Error("Expected pull request status");
    merged.status = { ...merged.status, state: "merged", isMerged: true };
    let reads = 0;
    const service = new WorkspaceGitServiceImpl({
      logger: createLogger() as unknown as pino.Logger,
      jagentdeskHome: "/tmp/jagentdesk-test",
      releaseGraceMs: 0,
      deps: {
        ...buildDefaultTestServiceDeps(),
        getPullRequestStatus: async () => {
          reads += 1;
          if (reads === 1) {
            retiredReadStarted.resolve();
            return retiredRead.promise;
          }
          return merged;
        },
      },
    });
    const store = createWorkspaceRuntimeStore();
    const published: WorkspaceGitRuntimeSnapshot[] = [];
    service.onSnapshotUpdated((snapshot) => {
      store.set(snapshot);
      published.push(snapshot);
    });
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, () => {});
    const oldRefresh = service.getSnapshot(REPO_CWD, { force: true, reason: "retiring-target" });
    try {
      await retiredReadStarted.promise;
      subscription.unsubscribe();
      expect(service.getMetrics().workspaceTargetCount).toBe(0);

      const latest = await service.getSnapshot(REPO_CWD, {
        force: true,
        reason: "replacement-target",
      });
      expect(latest.forge.pullRequest).toMatchObject({ state: "merged", isMerged: true });
      expect(store.get(REPO_CWD)).toBe(latest);

      retiredRead.resolve(createPullRequestStatusResult());
      const retired = await oldRefresh;
      expect(retired.forge.pullRequest).toMatchObject({ state: "open", isMerged: false });
      expect(store.get(REPO_CWD)).toBe(latest);
      expect(published).toEqual([latest]);
    } finally {
      retiredRead.resolve(createPullRequestStatusResult());
      await oldRefresh;
      await service.dispose();
    }
  });

  test("getSnapshot populates github pull request state in the runtime snapshot", async () => {
    const getPullRequestStatus = vi.fn(async () =>
      createPullRequestStatusResult({
        status: {
          url: "https://github.com/acme/repo/pull/999",
          title: "Ship runtime centralization",
          state: "open",
          baseRefName: "main",
          headRefName: "workspace-git-service",
          isMerged: false,
        },
      }),
    );

    const service = createService({
      getPullRequestStatus,
      now: () => new Date("2026-04-12T02:03:04.000Z"),
    });

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(
      createSnapshot(REPO_CWD, {
        forge: {
          pullRequest: {
            url: "https://github.com/acme/repo/pull/999",
            title: "Ship runtime centralization",
            state: "open",
            baseRefName: "main",
            headRefName: "workspace-git-service",
            isMerged: false,
          },
        },
      }),
    );
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getSnapshot does not probe isAuthenticated for a forge adapter that never throws from it", async () => {
    const gitlabIsAuthenticated = vi.fn(async () => false);
    const gitlabStub: ForgeService = {
      ...createGitHubServiceStub(),
      isAuthenticated: gitlabIsAuthenticated,
      authProbeCanThrow: undefined,
    };
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());

    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, { remoteUrl: "https://gitlab.com/acme/repo.git" }),
      ),
      getPullRequestStatus,
      forgeOverrides: { gitlab: gitlabStub },
    });

    await service.getSnapshot(REPO_CWD);

    expect(gitlabIsAuthenticated).not.toHaveBeenCalled();
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("getSnapshot keeps plain git classification when shortstat lookup fails", async () => {
    const getCheckoutShortstat = vi.fn(async () => {
      throw new Error(
        "Missing JAgentDesk worktree base metadata: /tmp/repo/.git/worktrees/feature/jagentdesk/worktree.json",
      );
    });
    const service = createService({
      getCheckoutStatus: vi.fn(async (cwd: string) =>
        createCheckoutStatus(cwd, {
          repoRoot: cwd,
          currentBranch: "feature/worktree",
          isJAgentDeskOwnedWorktree: false,
          mainRepoRoot: "/tmp/main-repo",
        }),
      ),
      getCheckoutShortstat,
    });

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(
      createSnapshot(REPO_CWD, {
        git: {
          repoRoot: REPO_CWD,
          currentBranch: "feature/worktree",
          isJAgentDeskOwnedWorktree: false,
          mainRepoRoot: "/tmp/main-repo",
          diffStat: null,
        },
      }),
    );
  });

  test("non-forced workspace refresh does not reload GitHub or emit when state is unchanged", async () => {
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const service = createService({
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });
    const listener = vi.fn();
    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    nowMs += 3_000;
    await service.refresh(REPO_CWD);

    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    subscription.unsubscribe();
    service.dispose();
  });

  test("cold getSnapshot calls share one workspace target setup and cache the snapshot", async () => {
    const checkoutStatusDeferred = createDeferred<CheckoutStatusGit>();
    const getCheckoutStatus = vi.fn(async () => checkoutStatusDeferred.promise);
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      resolveAbsoluteGitDir,
    });

    const firstSnapshotPromise = service.getSnapshot(REPO_CWD);
    const secondSnapshotPromise = service.getSnapshot(join(REPO_CWD, "."));
    await vi.waitFor(() => {
      expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    });
    expect(getPullRequestStatus).toHaveBeenCalledTimes(0);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    checkoutStatusDeferred.resolve(createCheckoutStatus(REPO_CWD));

    await expect(Promise.all([firstSnapshotPromise, secondSnapshotPromise])).resolves.toEqual([
      createSnapshot(REPO_CWD),
      createSnapshot(REPO_CWD),
    ]);

    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    await expect(service.getSnapshot(REPO_CWD)).resolves.toEqual(createSnapshot(REPO_CWD));
    expect(getCheckoutStatus).toHaveBeenCalledTimes(1);
    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test("a refresh requested after a mutation waits for a new snapshot", async () => {
    const gate = createDeferred<CheckoutStatusGit>();
    let reads = 0;
    const service = createService({
      getCheckoutStatus: (cwd: string) => {
        reads += 1;
        return reads === 1
          ? gate.promise
          : Promise.resolve(createCheckoutStatus(cwd, { currentBranch: "new-base" }));
      },
    });
    const first = service.getSnapshot(REPO_CWD, {
      force: true,
      includeForge: false,
      reason: "before-mutation",
    });
    await vi.waitFor(() => expect(reads).toBe(1));
    const after = service.getSnapshot(REPO_CWD, {
      force: true,
      includeForge: false,
      reason: "after-mutation",
      afterInFlight: true,
    });
    gate.resolve(createCheckoutStatus(REPO_CWD, { currentBranch: "old-base" }));
    await first;
    expect((await after).git.currentBranch).toBe("new-base");
    service.dispose();
  });

  test("multiple listeners on the same workspace share one observation setup", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => createCheckoutSnapshotFacts(cwd));
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutSnapshotFacts,
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });

    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(0);
    expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("equivalent cwd strings share one workspace target across service entry points", async () => {
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getPullRequestStatus,
      resolveAbsoluteGitDir,
      now: () => new Date(nowMs),
    });
    const workspaceRuntimeStore = createWorkspaceRuntimeStore();
    service.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));

    const subscription = service.registerWorkspace({ cwd: join(REPO_CWD, ".") }, vi.fn());

    await expect(service.getSnapshot(join(REPO_CWD, "."))).resolves.toEqual(
      createSnapshot(REPO_CWD),
    );
    expect(workspaceRuntimeStore.get(REPO_CWD)).toEqual(createSnapshot(REPO_CWD));

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await expect(service.getSnapshot(join(REPO_CWD, "."))).resolves.toEqual(
      createSnapshot(REPO_CWD),
    );

    expect(getPullRequestStatus).toHaveBeenCalledTimes(1);
    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);

    subscription.unsubscribe();
    service.dispose();
  });

  test("repo-level fetch intervals are shared for workspaces in the same repo", async () => {
    const firstFetch = createDeferred<void>();
    const runGitFetch = vi.fn(() => firstFetch.promise);
    const hasOriginRemote = vi.fn(async () => true);
    const getCheckoutSnapshotFacts = vi.fn(async (cwd: string) => ({
      ...createCheckoutSnapshotFacts(cwd),
      gitCommonDir: join(REPO_CWD, ".git"),
      absoluteGitDir: join(REPO_CWD, ".git"),
    }));
    const resolveAbsoluteGitDir = vi.fn(async () => join(REPO_CWD, ".git"));

    const service = createService({
      getCheckoutSnapshotFacts,
      resolveAbsoluteGitDir,
      hasOriginRemote,
      runGitFetch,
    });

    const first = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
    const second = service.registerWorkspace(
      { cwd: join(REPO_CWD, "packages", "server") },
      vi.fn(),
    );
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(4);
      expect(runGitFetch).toHaveBeenCalledTimes(1);
      expect(service.getMetrics().workspaceRefreshInFlightCount).toBe(0);
    });

    expect(resolveAbsoluteGitDir).toHaveBeenCalledTimes(0);
    expect(hasOriginRemote).toHaveBeenCalledTimes(0);
    expect(runGitFetch).toHaveBeenCalledTimes(1);

    firstFetch.resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(getCheckoutSnapshotFacts).toHaveBeenCalledTimes(6);
    });

    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();

    expect(runGitFetch).toHaveBeenCalledTimes(2);

    first.unsubscribe();
    second.unsubscribe();
    service.dispose();
  });

  test("explicit forced snapshot refresh recomputes github state and notifies listeners", async () => {
    const getPullRequestStatus = vi
      .fn<() => Promise<PullRequestStatusResult>>()
      .mockResolvedValueOnce(
        createPullRequestStatusResult({
          status: {
            url: "https://github.com/acme/repo/pull/123",
            title: "Before refresh",
            state: "open",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        createPullRequestStatusResult({
          status: {
            url: "https://github.com/acme/repo/pull/123",
            title: "After refresh",
            state: "merged",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: true,
          },
        }),
      );

    const nowValues = [new Date("2026-04-12T00:00:00.000Z"), new Date("2026-04-12T00:05:00.000Z")];
    const service = createService({
      getPullRequestStatus,
      now: () => nowValues.shift() ?? new Date("2026-04-12T00:05:00.000Z"),
    });

    const listener = vi.fn();
    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(initialSnapshot.forge.pullRequest?.title).toBe("Before refresh");

    await service.getSnapshot(REPO_CWD, {
      force: true,
      reason: "test-force-github-refresh",
    });
    await flushPromises();

    expect(getPullRequestStatus).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        forge: {
          pullRequest: {
            url: "https://github.com/acme/repo/pull/123",
            title: "After refresh",
            state: "merged",
            baseRefName: "main",
            headRefName: "feature",
            isMerged: true,
          },
        },
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("unchanged runtime snapshots do not emit duplicate updates", async () => {
    const getCheckoutStatus = vi
      .fn<() => Promise<CheckoutStatusGit>>()
      .mockResolvedValueOnce(createCheckoutStatus(REPO_CWD, { remoteUrl: null }))
      .mockResolvedValueOnce(
        createCheckoutStatus(REPO_CWD, {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        }),
      )
      .mockResolvedValueOnce(
        createCheckoutStatus(REPO_CWD, {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        }),
      );
    const getPullRequestStatus = vi.fn<() => Promise<PullRequestStatusResult>>().mockResolvedValue(
      createPullRequestStatusResult({
        status: {
          url: "https://github.com/acme/repo/pull/123",
          title: "Runtime payloads",
          state: "open",
          baseRefName: "main",
          headRefName: "feature/runtime-payloads",
          isMerged: false,
        },
      }),
    );

    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });

    const listener = vi.fn();
    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    expect(initialSnapshot.git.currentBranch).toBe("main");

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await flushPromises();

    nowMs += 3_000;
    await service.refresh(REPO_CWD);
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        git: {
          currentBranch: "feature/runtime-payloads",
          remoteUrl: null,
          aheadBehind: { ahead: 2, behind: 0 },
          aheadOfOrigin: 2,
        },
        forge: {
          featuresEnabled: false,
          pullRequest: null,
        },
      }),
    );

    subscription.unsubscribe();
    service.dispose();
  });

  test("forced snapshot refresh emits even when the fingerprint matches", async () => {
    const getCheckoutStatus = vi.fn(async () => createCheckoutStatus(REPO_CWD));
    const getPullRequestStatus = vi.fn(async () => createPullRequestStatusResult());
    let nowMs = Date.parse("2026-04-12T00:00:00.000Z");
    const service = createService({
      getCheckoutStatus,
      getPullRequestStatus,
      now: () => new Date(nowMs),
    });

    const listener = vi.fn();
    await service.getSnapshot(REPO_CWD);
    const subscription = service.registerWorkspace({ cwd: REPO_CWD }, listener);

    await service.getSnapshot(REPO_CWD, {
      force: true,
      reason: "test-force-emit",
    });
    await flushPromises();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(createSnapshot(REPO_CWD));

    subscription.unsubscribe();
    service.dispose();
  });

  test("watches nested repository changes through one recursive checkout subscription", async () => {
    const unsubscribe = vi.fn(async () => {});
    const subscribe = vi.fn(async () => ({ unsubscribe }));
    const service = createService({ subscribe });

    const subscription = await service.requestWorkingTreeWatch(
      path.join(REPO_CWD, "packages", "server"),
      vi.fn(),
    );

    expect(subscription.repoRoot).toBe(REPO_CWD);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith(REPO_CWD, expect.any(Function), {
      ignore: [join(REPO_CWD, ".git")],
      signal: expect.any(AbortSignal),
    });

    subscription.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  test("requestWorkingTreeWatch reference-counts watchers by cwd", async () => {
    const unsubscribe = vi.fn(async () => {});
    const subscribe = vi.fn(async () => ({ unsubscribe }));
    const service = createService({ subscribe });

    const firstListener = vi.fn();
    const secondListener = vi.fn();
    const first = await service.requestWorkingTreeWatch(REPO_CWD, firstListener);
    const second = await service.requestWorkingTreeWatch(join(REPO_CWD, "."), secondListener);

    expect(first.repoRoot).toBe(REPO_CWD);
    expect(second.repoRoot).toBe(REPO_CWD);
    expect(subscribe).toHaveBeenCalledTimes(1);

    first.unsubscribe();
    expect(unsubscribe).not.toHaveBeenCalled();

    second.unsubscribe();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  test.each(["repository metadata", "working tree"])(
    "aborts each timed-out %s watcher setup and backs retries off toward an hour",
    async (kind) => {
      const watchPath = kind === "repository metadata" ? join(REPO_CWD, ".git") : REPO_CWD;
      const setup = createStallingWatchSetup(watchPath);
      const getCheckoutStatus = vi.fn(async (cwd: string) => createCheckoutStatus(cwd));
      const service = createService({ subscribe: setup.subscribe, getCheckoutStatus });
      const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
      try {
        await settle(() => expect(setup.signals).toHaveLength(1));
        await setup.expectAttemptAbortedAtDeadline();
        await waitForObservationToSettle(service, 1);
        for (const delayMs of [
          30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
        ]) {
          await setup.expectNextAttemptAfter(delayMs, service);
          await setup.expectAttemptAbortedAtDeadline();
        }
        // Degraded polling keeps the checkout fresh while the watcher waits out an hour.
        const readsBeforeCappedWait = getCheckoutStatus.mock.calls.length;
        await setup.expectNextAttemptAfter(3_600_000, service);
        expect(getCheckoutStatus.mock.calls.length).toBeGreaterThanOrEqual(
          readsBeforeCappedWait + 59,
        );
      } finally {
        subscription.unsubscribe();
        await service.dispose();
      }
    },
    30_000,
  );

  test.each(["repository metadata", "working tree"])(
    "an accepted %s watcher subscription resets the setup-timeout backoff",
    async (kind) => {
      const watchPath = kind === "repository metadata" ? join(REPO_CWD, ".git") : REPO_CWD;
      const setup = createStallingWatchSetup(watchPath);
      const service = createService({ subscribe: setup.subscribe });
      const subscription = service.registerWorkspace({ cwd: REPO_CWD }, vi.fn());
      try {
        await settle(() => expect(setup.signals).toHaveLength(1));
        await setup.expectAttemptAbortedAtDeadline();
        for (const delayMs of [30_000, 60_000, 120_000, 240_000, 480_000]) {
          await setup.expectNextAttemptAfter(delayMs, service);
          await setup.expectAttemptAbortedAtDeadline();
        }
        setup.acceptNextAttempt();
        await setup.expectNextAttemptAfter(960_000, service);
        setup.failAcceptedWatcher();
        // The ordinary recovery ladder's ceiling applies again, not the 32-minute timeout step.
        await setup.expectNextAttemptAfter(300_000, service);
        await setup.expectAttemptAbortedAtDeadline();
        await setup.expectNextAttemptAfter(300_000, service);
      } finally {
        subscription.unsubscribe();
        await service.dispose();
      }
    },
    30_000,
  );

  test("sets a bounded polling fallback when recursive observation is unavailable", async () => {
    const subscribe = vi.fn(async () => {
      throw new Error("watcher unavailable");
    });
    const service = createService({ subscribe });
    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());

    expect(vi.getTimerCount()).toBe(2);

    subscription.unsubscribe();
    service.dispose();
  });

  test("non-git directories fall back to watching cwd with polling", async () => {
    const subscribe = vi.fn(async () => createAsyncSubscription());
    const runGitCommand = vi.fn(async () => {
      throw new Error("not a git repository");
    });
    const resolveAbsoluteGitDir = vi.fn(async () => null);
    const service = createService({
      subscribe,
      runGitCommand,
      resolveAbsoluteGitDir,
    });

    const plainCwd = path.join(os.tmpdir(), "plain");
    const subscription = await service.requestWorkingTreeWatch(plainCwd, vi.fn());

    expect(subscription.repoRoot).toBeNull();
    expect(subscribe).toHaveBeenCalledWith(plainCwd, expect.any(Function), {
      ignore: [join(plainCwd, ".git")],
      signal: expect.any(AbortSignal),
    });
    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("working tree changes notify watch listeners immediately", async () => {
    const watchCallbacks: Array<
      (error: Error | null, events: Array<{ path: string; type: "update" }>) => void
    > = [];
    const subscribe = vi.fn(async (_path: string, callback: (typeof watchCallbacks)[number]) => {
      watchCallbacks.push(callback);
      return createAsyncSubscription();
    });
    const service = createService({ subscribe });
    const listener = vi.fn();

    const subscription = await service.requestWorkingTreeWatch(REPO_CWD, listener);
    expect(watchCallbacks).toHaveLength(1);

    watchCallbacks[0]?.(null, [{ path: join(REPO_CWD, "file.ts"), type: "update" }]);

    expect(listener).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    service.dispose();
  });

  test("working tree changes force a fresh diff stat for workspace subscribers", async () => {
    const watchCallbacks: Array<{
      path: string;
      callback: (error: Error | null, events: Array<{ path: string; type: "update" }>) => void;
    }> = [];
    const subscribe = vi.fn(
      async (watchPath: string, callback: (typeof watchCallbacks)[number]["callback"]) => {
        watchCallbacks.push({ path: watchPath, callback });
        return createAsyncSubscription();
      },
    );
    const getCheckoutWorktreeState = vi.fn(async () => ({
      isDirty: true,
      diffStat: { additions: 8, deletions: 3 },
    }));
    const backgroundFetch = createDeferred<void>();
    const service = createService({
      getCheckoutWorktreeState,
      runGitFetch: vi.fn(() => backgroundFetch.promise),
      subscribe,
    });
    const workspaceListener = vi.fn();

    const initialSnapshot = await service.getSnapshot(REPO_CWD);
    const workspaceSubscription = service.registerWorkspace({ cwd: REPO_CWD }, workspaceListener);
    const diffSubscription = await service.requestWorkingTreeWatch(REPO_CWD, vi.fn());
    await vi.waitFor(() => {
      expect(service.getMetrics().repositoryWorkspaceLinkCount).toBe(1);
    });

    expect(initialSnapshot.git.diffStat).toEqual({ additions: 1, deletions: 0 });
    const repoRootWatch = watchCallbacks.find((entry) => entry.path === REPO_CWD);
    expect(repoRootWatch).toBeDefined();

    repoRootWatch?.callback(null, [{ path: join(REPO_CWD, "file.ts"), type: "update" }]);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(getCheckoutWorktreeState).toHaveBeenCalledWith(
      REPO_CWD,
      expect.objectContaining({ jagentdeskHome: "/tmp/jagentdesk-test" }),
    );
    expect(workspaceListener).toHaveBeenCalledWith(
      createSnapshot(REPO_CWD, {
        git: { isDirty: true, diffStat: { additions: 8, deletions: 3 } },
      }),
    );

    diffSubscription.unsubscribe();
    workspaceSubscription.unsubscribe();
    service.dispose();
  });

  test("checkoutDiffCache evicts least-recently-used entries past its size cap", async () => {
    vi.useRealTimers();
    const getCheckoutDiff = vi.fn(async (cwd: string) => ({
      diff: `diff for ${cwd}`,
    }));
    const service = createService({
      getCheckoutDiff: getCheckoutDiff as unknown as ReturnType<typeof vi.fn>,
    });

    const CACHE_MAX = 64;
    const OVERFLOW = 5;

    for (let i = 0; i < CACHE_MAX + OVERFLOW; i++) {
      await service.getCheckoutDiff(`/tmp/repo-${i}`, { mode: "uncommitted" });
    }
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW);

    await service.getCheckoutDiff(`/tmp/repo-${CACHE_MAX - 1}`, { mode: "uncommitted" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW);

    await service.getCheckoutDiff("/tmp/repo-0", { mode: "uncommitted" });
    expect(getCheckoutDiff).toHaveBeenCalledTimes(CACHE_MAX + OVERFLOW + 1);

    service.dispose();
  });
});

describe("WorkspaceGitServiceImpl with workspace folders that no longer exist", () => {
  const temporaryFolders: string[] = [];

  async function createTemporaryFolder(): Promise<string> {
    const folder = await mkdtemp(join(os.tmpdir(), "jagentdesk-workspace-git-"));
    temporaryFolders.push(folder);
    return folder;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      temporaryFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
    );
  });

  test("polling stops for a workspace whose folder no longer exists", async () => {
    const workspace = await createTemporaryFolder();
    const git = createFolderBackedGit();
    const service = createService(git.deps);
    const subscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);

    await rm(workspace, { recursive: true, force: true });
    const gitCommandsAtDeletion = git.gitCommandsIn(workspace);
    await advanceThroughDegradedPolls(service);

    expect(git.gitCommandsIn(workspace)).toBe(gitCommandsAtDeletion);
    expect(service.getMetrics()).toMatchObject({
      repositoryTargetCount: 0,
      workingTreeWatchTargetCount: 0,
    });
    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();
    await service.dispose();
  });

  test("a deleted worktree leaves its shared repository polling and fetch to the surviving worktree", async () => {
    const gitCommonDir = join(await createTemporaryFolder(), ".git");
    const deletedWorktree = await createTemporaryFolder();
    const survivingWorktree = await createTemporaryFolder();
    const git = createFolderBackedGit({ facts: linkedWorktreeFacts(gitCommonDir) });
    let survivingWorktreeEdits = 0;
    git.deps.getCheckoutShortstat.mockImplementation(async (cwd: string) => ({
      additions: cwd === survivingWorktree ? ++survivingWorktreeEdits : 1,
      deletions: 0,
    }));
    const service = createService(git.deps);
    const deletedSubscription = service.registerWorkspace({ cwd: deletedWorktree }, vi.fn());
    await waitForObservationToSettle(service, 1);
    const survivingSubscription = service.registerWorkspace({ cwd: survivingWorktree }, vi.fn());
    await waitForObservationToSettle(service, 2);

    await rm(deletedWorktree, { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await waitForRefreshesToSettle(service);
    const deletedWorktreeCommands = git.gitCommandsIn(deletedWorktree);

    for (let tick = 0; tick < 3; tick += 1) {
      const survivingWorktreePolls = git.pollsOf(survivingWorktree);
      await vi.advanceTimersByTimeAsync(5_000);
      await settle(() => {
        expect(git.pollsOf(survivingWorktree)).toBe(survivingWorktreePolls + 1);
      });
    }
    expect(git.gitCommandsIn(deletedWorktree)).toBe(deletedWorktreeCommands);

    const fetchesBefore = git.deps.runGitFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * BACKGROUND_GIT_FETCH_INTERVAL_MS);
    expect(git.deps.runGitFetch.mock.calls.slice(fetchesBefore).map(([cwd]) => cwd)).toEqual([
      survivingWorktree,
      survivingWorktree,
    ]);
    expect(git.gitCommandsIn(deletedWorktree)).toBe(deletedWorktreeCommands);

    deletedSubscription.unsubscribe();
    survivingSubscription.unsubscribe();
    await service.dispose();
  });

  test("deleting every worktree of a repository stops its polling and background fetch", async () => {
    const gitCommonDir = join(await createTemporaryFolder(), ".git");
    const firstWorktree = await createTemporaryFolder();
    const secondWorktree = await createTemporaryFolder();
    const git = createFolderBackedGit({ facts: linkedWorktreeFacts(gitCommonDir) });
    const service = createService(git.deps);
    const firstSubscription = service.registerWorkspace({ cwd: firstWorktree }, vi.fn());
    await waitForObservationToSettle(service, 1);
    const secondSubscription = service.registerWorkspace({ cwd: secondWorktree }, vi.fn());
    await waitForObservationToSettle(service, 2);

    await rm(firstWorktree, { recursive: true, force: true });
    await rm(secondWorktree, { recursive: true, force: true });
    const commandsAtDeletion = [
      git.gitCommandsIn(firstWorktree),
      git.gitCommandsIn(secondWorktree),
    ];
    await advanceThroughDegradedPolls(service);

    expect([git.gitCommandsIn(firstWorktree), git.gitCommandsIn(secondWorktree)]).toEqual(
      commandsAtDeletion,
    );
    expect(service.getMetrics()).toMatchObject({
      repositoryTargetCount: 0,
      workingTreeWatchTargetCount: 0,
    });
    expect(vi.getTimerCount()).toBe(2);

    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
    await service.dispose();
  });

  test("working tree fallback polling and watcher recovery stop for a workspace whose folder no longer exists", async () => {
    const workspace = await createTemporaryFolder();
    await mkdir(join(workspace, ".git"));
    const git = createFolderBackedGit();
    const service = createService(git.deps);
    const subscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);

    await rm(workspace, { recursive: true, force: true });
    git.watchCallbackFor(workspace)(new Error("watched directory was deleted"), []);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForRefreshesToSettle(service);
    const commandsAfterWatcherError = git.gitCommandsIn(workspace);
    const watchAttemptsAfterWatcherError = git.watchAttemptsFor(workspace);
    await advanceThroughDegradedPolls(service);

    expect(git.gitCommandsIn(workspace)).toBe(commandsAfterWatcherError);
    expect(git.watchAttemptsFor(workspace)).toBe(watchAttemptsAfterWatcherError);
    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();
    await service.dispose();
  });

  test("a workspace whose folder comes back resumes polling on its next subscription", async () => {
    const workspace = await createTemporaryFolder();
    const git = createFolderBackedGit();
    const service = createService(git.deps);
    const firstSubscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);
    await rm(workspace, { recursive: true, force: true });
    const commandsWhileMissing = git.gitCommandsIn(workspace);
    await advanceThroughDegradedPolls(service);
    expect(git.gitCommandsIn(workspace)).toBe(commandsWhileMissing);

    await mkdir(workspace);
    const secondSubscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);
    const pollsAfterResume = git.pollsOf(workspace);
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForRefreshesToSettle(service);

    expect(git.pollsOf(workspace)).toBe(pollsAfterResume + 1);

    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
    await service.dispose();
  });

  test("a suspended workspace costs no git while its folder is missing, even when a refresh is requested", async () => {
    const workspace = await createTemporaryFolder();
    const git = createFolderBackedGit();
    const service = createService(git.deps);
    const subscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);
    await rm(workspace, { recursive: true, force: true });
    await advanceThroughDegradedPolls(service);
    const commandsWhileMissing = git.gitCommandsIn(workspace);

    for (let probe = 0; probe < 10; probe += 1) {
      await vi.advanceTimersByTimeAsync(WORKSPACE_GIT_OBSERVATION_REENSURE_INTERVAL_MS);
      await waitForRefreshesToSettle(service);
    }
    service.scheduleRefreshForCwd(workspace);
    service.onWorkspaceStateMayHaveChanged(workspace);
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForRefreshesToSettle(service);

    expect(git.gitCommandsIn(workspace)).toBe(commandsWhileMissing);
    expect(vi.getTimerCount()).toBe(1);

    subscription.unsubscribe();
    await service.dispose();
  });

  test("a suspended worktree resumes polling and its repository fetch once its folder is back, without a new subscription", async () => {
    const gitCommonDir = join(await createTemporaryFolder(), ".git");
    const worktree = await createTemporaryFolder();
    const git = createFolderBackedGit({ facts: linkedWorktreeFacts(gitCommonDir) });
    const service = createService(git.deps);
    const subscription = service.registerWorkspace({ cwd: worktree }, vi.fn());
    await waitForObservationToSettle(service, 1);
    await rm(worktree, { recursive: true, force: true });
    await advanceThroughDegradedPolls(service);
    await waitForObservationToSettle(service, 0);

    await mkdir(worktree);
    const fetchesBeforeRestore = git.fetchesIn(worktree);
    await vi.advanceTimersByTimeAsync(WORKSPACE_GIT_OBSERVATION_REENSURE_INTERVAL_MS);
    await waitForObservationToSettle(service, 1);
    expect(git.fetchesIn(worktree)).toBe(fetchesBeforeRestore + 1);

    const pollsAfterRestore = git.pollsOf(worktree);
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForRefreshesToSettle(service);
    expect(git.pollsOf(worktree)).toBe(pollsAfterRestore + 1);

    subscription.unsubscribe();
    await service.dispose();
  });

  test("a forced snapshot resumes a suspended workspace whose folder is back", async () => {
    const workspace = await createTemporaryFolder();
    const git = createFolderBackedGit();
    const service = createService(git.deps);
    const subscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);
    await rm(workspace, { recursive: true, force: true });
    await advanceThroughDegradedPolls(service);
    await waitForObservationToSettle(service, 0);

    await mkdir(workspace);
    const snapshot = await service.getSnapshot(workspace, {
      force: true,
      reason: "refresh-button",
    });
    await waitForObservationToSettle(service, 1);

    expect(snapshot.git.isGit).toBe(true);

    subscription.unsubscribe();
    await service.dispose();
  });

  test("a resumed workspace rebuilds observation from fresh facts, not the non-git facts cached while its folder was gone", async () => {
    const workspace = await createTemporaryFolder();
    const git = createFolderBackedGit();
    const service = createService(git.deps);
    const firstSubscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);
    await rm(workspace, { recursive: true, force: true });
    service.onWorkspaceStateMayHaveChanged(workspace);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForRefreshesToSettle(service);
    expect((await service.getSnapshot(workspace)).git.isGit).toBe(false);
    await advanceThroughDegradedPolls(service);
    await waitForObservationToSettle(service, 0);

    await mkdir(workspace);
    const secondSubscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);

    expect((await service.getSnapshot(workspace)).git.isGit).toBe(true);

    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
    await service.dispose();
  });

  test("resuming waits for an observation setup that was still running when the folder vanished", async () => {
    const workspace = await createTemporaryFolder();
    const gitDir = join(workspace, ".git");
    await mkdir(gitDir);
    const metadataWatchRelease = createDeferred<void>();
    const git = createFolderBackedGit({
      unwatchableDirectories: [workspace],
      heldWatch: { directory: gitDir, release: metadataWatchRelease.promise },
    });
    const service = createService(git.deps);
    const firstSubscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await settle(() => {
      expect(git.watchAttemptsFor(gitDir)).toBe(1);
    });

    await rm(workspace, { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => {
      expect(service.getMetrics()).toMatchObject({
        repositoryTargetCount: 0,
        workingTreeWatchTargetCount: 0,
      });
    });
    await mkdir(workspace);
    const secondSubscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    metadataWatchRelease.resolve();
    await waitForObservationToSettle(service, 1);

    expect(service.getMetrics().workingTreeWatchTargetCount).toBe(1);

    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
    await service.dispose();
  });

  test("an open working tree watch neither notifies nor recovers while its folder is missing, and picks up once it is back", async () => {
    const workspace = await createTemporaryFolder();
    await mkdir(join(workspace, ".git"));
    const git = createFolderBackedGit();
    const service = createService(git.deps);
    const workspaceSubscription = service.registerWorkspace({ cwd: workspace }, vi.fn());
    await waitForObservationToSettle(service, 1);
    const diffListener = vi.fn();
    const diffWatch = await service.requestWorkingTreeWatch(workspace, diffListener);

    await rm(workspace, { recursive: true, force: true });
    git.watchCallbackFor(workspace)(new Error("watched directory was deleted"), []);
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForRefreshesToSettle(service);
    const commandsAfterWatcherError = git.gitCommandsIn(workspace);
    const notificationsAfterWatcherError = diffListener.mock.calls.length;
    const watchAttemptsAfterWatcherError = git.watchAttemptsFor(workspace);
    await advanceThroughWorkingTreeRecoveryAttempts(service);

    expect(git.gitCommandsIn(workspace)).toBe(commandsAfterWatcherError);
    expect(diffListener.mock.calls.length).toBe(notificationsAfterWatcherError);
    expect(git.watchAttemptsFor(workspace)).toBe(watchAttemptsAfterWatcherError);
    expect(service.getMetrics().workingTreeWatchTargetCount).toBe(1);

    await mkdir(join(workspace, ".git"), { recursive: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await waitForRefreshesToSettle(service);
    expect(diffListener.mock.calls.length).toBe(notificationsAfterWatcherError + 1);

    await vi.advanceTimersByTimeAsync(240_000);
    await waitForRefreshesToSettle(service);
    expect(git.watchAttemptsFor(workspace)).toBe(watchAttemptsAfterWatcherError + 1);
    const notificationsAfterResubscribe = diffListener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    await waitForRefreshesToSettle(service);
    expect(diffListener.mock.calls.length).toBe(notificationsAfterResubscribe);

    diffWatch.unsubscribe();
    workspaceSubscription.unsubscribe();
    await service.dispose();
  });

  test("a refresh crossing suspension preserves the cached snapshot and drops queued work", async () => {
    const workspace = await createTemporaryFolder();
    const git = createFolderBackedGit();
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    let holdNextRead = false;
    let factsReads = 0;
    const service = createService({
      ...git.deps,
      getCheckoutSnapshotFacts: async (cwd: string) => {
        factsReads++;
        if (holdNextRead) {
          holdNextRead = false;
          started.resolve();
          await release.promise;
        }
        return git.deps.getCheckoutSnapshotFacts(cwd);
      },
    });
    const updates: WorkspaceGitRuntimeSnapshot[] = [];
    const subscription = service.registerWorkspace({ cwd: workspace }, (snapshot) =>
      updates.push(snapshot),
    );
    await waitForObservationToSettle(service, 1);
    const cached = await service.getSnapshot(workspace);
    holdNextRead = true;
    const active = service.getSnapshot(workspace, {
      force: true,
      includeForge: false,
      reason: "overlapping-refresh",
    });
    await started.promise;
    const queued = service.getSnapshot(workspace, {
      force: true,
      includeForge: true,
      reason: "queued-refresh",
    });
    await rm(workspace, { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => expect(service.getMetrics().repositoryWorkspaceLinkCount).toBe(0));
    const readsAtSuspension = factsReads;
    const updatesAtSuspension = updates.length;
    release.resolve();
    expect(await active).toEqual(cached);
    expect(await queued).toEqual(cached);
    expect(await service.getSnapshot(workspace)).toEqual(cached);
    expect(updates).toHaveLength(updatesAtSuspension);
    expect(factsReads).toBe(readsAtSuspension);
    subscription.unsubscribe();
    await service.dispose();
  });

  test("restoration settles a suspended refresh before reloading facts", async () => {
    const workspace = await createTemporaryFolder();
    const git = createFolderBackedGit();
    const staleFacts = createDeferred<CheckoutSnapshotFacts>();
    const started = createDeferred<void>();
    let holdNextRead = false;
    const service = createService({
      ...git.deps,
      getCheckoutSnapshotFacts: async (cwd: string) => {
        if (holdNextRead) {
          holdNextRead = false;
          started.resolve();
          return staleFacts.promise;
        }
        return git.deps.getCheckoutSnapshotFacts(cwd);
      },
    });
    const updates: WorkspaceGitRuntimeSnapshot[] = [];
    const subscription = service.registerWorkspace({ cwd: workspace }, (snapshot) =>
      updates.push(snapshot),
    );
    await waitForObservationToSettle(service, 1);
    const cached = await service.getSnapshot(workspace);
    holdNextRead = true;
    const active = service.getSnapshot(workspace, {
      force: true,
      includeForge: false,
      reason: "overlapping-refresh",
    });
    await started.promise;
    await rm(workspace, { recursive: true, force: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(() => expect(service.getMetrics().repositoryWorkspaceLinkCount).toBe(0));
    const updatesAtSuspension = updates.length;
    await mkdir(workspace);
    const restored = service.getSnapshot(workspace, {
      force: true,
      includeForge: false,
      reason: "folder-returned",
    });
    await vi.advanceTimersByTimeAsync(0);
    staleFacts.resolve({ isGit: false });
    expect(await active).toEqual(cached);
    expect((await restored).git.isGit).toBe(true);
    expect(updates.slice(updatesAtSuspension).every((snapshot) => snapshot.git.isGit)).toBe(true);
    await waitForObservationToSettle(service, 1);
    subscription.unsubscribe();
    await service.dispose();
  });

  test("workspaceFolderExists reports a missing folder and a path under a file as missing", async () => {
    const folder = await createTemporaryFolder();
    const file = join(folder, "file.txt");
    await writeFile(file, "");

    expect(await workspaceFolderExists(folder)).toBe(true);
    expect(await workspaceFolderExists(join(folder, "missing"))).toBe(false);
    expect(await workspaceFolderExists(join(file, "nested"))).toBe(false);
  });
});
