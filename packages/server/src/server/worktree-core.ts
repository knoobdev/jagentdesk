import { runGitCommand } from "../utils/run-git-command.js";
import type {
  PluginWorktreeCreateInput,
  PluginWorktreeCreateRequest,
} from "@jagentdesk/plugin/server";
import type { PluginLifecycle } from "./plugins/lifecycle/index.js";
import type { PluginWorktreeManagerRuntime } from "./plugins/runtime.js";
import { createNameId } from "mnemonic-id";

import type { ForgeService } from "../services/forge-service.js";
import {
  createWorktree,
  resolveDefaultWorktreePath,
  resolveExistingWorktreeForSlug,
  fetchFirstAvailableRef,
  prepareWorktreeBranchOff,
  type PreparedWorktreeBranchOff,
  runPluginWorktreeManagerCheckout,
  slugify,
  validateBranchSlug,
  type CreatedWorktree,
} from "../utils/worktree.js";
import {
  resolveWorktreeCreationIntent,
  type ResolveWorktreeCreationIntentInput,
  UnsupportedForgeCheckoutTargetError,
  type WorktreeCreationIntent,
  worktreeUntrustedSource,
} from "./resolve-worktree-creation-intent.js";
import type { ChangeRequestCheckoutSource, FirstAgentContext } from "@jagentdesk/protocol/messages";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import {
  normalizeBaseRefName,
  readJAgentDeskWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import { runWithRepositoryRoot } from "../utils/git-repository-discovery.js";
import type { UntrustedWorkspaceSource } from "./workspace-automation-gate.js";

export interface CreateWorktreeCoreInput {
  cwd: string;
  worktreeSlug?: string;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
  checkoutSource?: ChangeRequestCheckoutSource;
  githubPrNumber?: number;
  firstAgentContext?: FirstAgentContext;
  jagentdeskHome?: string;
  worktreesRoot?: string;
  runSetup?: boolean;
}

export interface CreateWorktreeCoreDeps {
  lifecycle?: Pick<PluginLifecycle, "before">;
  worktreeManagers?: Pick<
    PluginWorktreeManagerRuntime,
    "hasWorktreeManager" | "createWorktree" | "removeWorktree"
  >;
  github: ForgeService;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "resolveRepoRoot" | "resolveDefaultBranch" | "resolveForge"
  >;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
}

export interface CreateWorktreeCoreResult {
  worktree: CreatedWorktree;
  intent: WorktreeCreationIntent;
  untrustedSource?: UntrustedWorkspaceSource;
  repoRoot: string;
  created: boolean;
}

export async function createWorktreeCore(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
): Promise<CreateWorktreeCoreResult> {
  const repoRoot = await resolveWorktreeRepoRoot(input, deps.workspaceGitService);
  return runWithRepositoryRoot(repoRoot, () =>
    createWorktreeAtRepositoryRoot(input, deps, repoRoot),
  );
}

async function createWorktreeAtRepositoryRoot(
  input: CreateWorktreeCoreInput,
  deps: CreateWorktreeCoreDeps,
  repoRoot: string,
): Promise<CreateWorktreeCoreResult> {
  const requestedWorktreeSlug = input.worktreeSlug
    ? normalizeWorktreeSlug(input.worktreeSlug)
    : undefined;
  const requestedBranchName = input.branchName
    ? validateWorktreeSlug(input.branchName.trim())
    : undefined;

  let intentInput: ResolveWorktreeCreationIntentInput;
  if (input.action === "checkout") {
    intentInput = {
      action: "checkout",
      refName: input.refName,
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else if (
    input.action !== "branch-off" &&
    (input.checkoutSource !== undefined || input.githubPrNumber !== undefined)
  ) {
    // A change request with no action is checked out, as clients did before `action` existed.
    intentInput = {
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      refName: input.refName,
      worktreeSlug: requestedWorktreeSlug,
    };
  } else {
    const worktreeSlug = requestedWorktreeSlug ?? normalizeWorktreeSlug(createNameId());
    intentInput = {
      action: "branch-off",
      refName: input.refName,
      checkoutSource: input.checkoutSource,
      githubPrNumber: input.githubPrNumber,
      branchName: requestedBranchName,
      worktreeSlug,
    };
  }

  const forge = await resolveForge(repoRoot, deps, intentInput);
  let intent = await resolveWorktreeCreationIntent(intentInput, repoRoot, {
    forge: forge.forge,
    forgeService: forge.service,
    resolveDefaultBranch: (root) => resolveDefaultBranch(root, deps),
    fetchRef: ({ repoRoot: cwd, sources, destination }) =>
      fetchFirstAvailableRef({ cwd, sources, destination }),
  });
  let normalizedSlug = requestedWorktreeSlug ?? defaultWorktreeSlugForIntent(intent);

  const existingWorktree = await resolveExistingWorktreeForSlug({
    slug: normalizedSlug,
    repoRoot,
    jagentdeskHome: input.jagentdeskHome,
    worktreesRoot: input.worktreesRoot,
  });
  if (existingWorktree) {
    return {
      worktree: {
        ...existingWorktree,
        comparisonBaseRef: await resolveReusedWorktreeComparisonBase(
          intent,
          existingWorktree.worktreePath,
        ),
      },
      intent,
      repoRoot,
      created: false,
    };
  }

  const defaultPath = await resolveDefaultWorktreePath({
    cwd: repoRoot,
    jagentdeskHome: input.jagentdeskHome,
    worktreesRoot: input.worktreesRoot,
    worktreeSlug: normalizedSlug,
  });
  const { stdout: sourceRoot } = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: input.cwd,
  });
  const sourceCheckout = sourceRoot.trim();
  const request = describeCreationRequest(intent, {
    repoRoot,
    sourceCheckout,
    slug: normalizedSlug,
    path: defaultPath,
  });
  const transformed = deps.lifecycle
    ? await deps.lifecycle.before("worktree.create.before", request)
    : request;
  const originalUntrustedSource = worktreeUntrustedSource(intent);
  normalizedSlug = validateWorktreeSlug(transformed.slug);
  intent = creationIntentFromRequest(transformed, intent);
  const untrustedSource = originalUntrustedSource ?? worktreeUntrustedSource(intent);

  const { worktree: managedWorktree, preparedBranchOff } = await tryCreateWithWorktreeManager({
    repoRoot,
    transformed,
    intent,
    untrusted: Boolean(untrustedSource),
    input,
    deps,
  });
  if (managedWorktree) {
    return {
      worktree: managedWorktree,
      intent,
      untrustedSource,
      repoRoot,
      created: true,
    };
  }

  return {
    worktree: await createWorktree({
      cwd: repoRoot,
      worktreeSlug: normalizedSlug,
      worktreePath: transformed.path,
      source: intent,
      runSetup: input.runSetup ?? true,
      preparedBranchOff,
      jagentdeskHome: input.jagentdeskHome,
      worktreesRoot: input.worktreesRoot,
    }),
    intent,
    untrustedSource,
    repoRoot,
    created: true,
  };
}

function defaultWorktreeSlugForIntent(intent: WorktreeCreationIntent): string {
  switch (intent.kind) {
    case "branch-off":
    case "checkout-branch":
      return normalizeWorktreeSlug(intent.branchName);
    case "checkout-change-request":
    case "checkout-github-pr":
      return normalizeWorktreeSlug(intent.localBranchName ?? intent.headRef);
  }
}

async function tryCreateWithWorktreeManager(options: {
  repoRoot: string;
  transformed: PluginWorktreeCreateRequest;
  intent: WorktreeCreationIntent;
  untrusted: boolean;
  input: Pick<CreateWorktreeCoreInput, "jagentdeskHome" | "worktreesRoot">;
  deps: Pick<CreateWorktreeCoreDeps, "worktreeManagers">;
}): Promise<{ worktree: CreatedWorktree | null; preparedBranchOff?: PreparedWorktreeBranchOff }> {
  const { repoRoot, transformed, intent, untrusted, input, deps } = options;
  let preparedBranchOff: PreparedWorktreeBranchOff | undefined;
  const worktree = await runPluginWorktreeManagerCheckout({
    cwd: repoRoot,
    source: intent,
    operation: "create",
    untrusted,
    jagentdeskHome: input.jagentdeskHome,
    worktreesBaseRoot: input.worktreesRoot,
    worktreeManagers: deps.worktreeManagers,
    run: async ({ changeRequestHeadSha }) => {
      let request: PluginWorktreeCreateInput = {
        ...transformed,
        untrusted,
        ...(changeRequestHeadSha ? { headSha: changeRequestHeadSha } : {}),
      };
      if (request.kind === "branch-off" && intent.kind === "branch-off") {
        preparedBranchOff = await prepareWorktreeBranchOff(repoRoot, intent);
        request = { ...request, baseRef: preparedBranchOff.baseRef };
      }
      return deps.worktreeManagers!.createWorktree(request);
    },
  });
  return { worktree, preparedBranchOff };
}

function describeCreationRequest(
  intent: WorktreeCreationIntent,
  placement: Pick<PluginWorktreeCreateRequest, "repoRoot" | "sourceCheckout" | "slug" | "path">,
): PluginWorktreeCreateRequest {
  if (intent.kind === "branch-off")
    return {
      ...placement,
      kind: intent.kind,
      branch: intent.branchName,
      baseRef: intent.baseBranch,
      ...(intent.startPoint ? { startPoint: intent.startPoint } : {}),
    };
  if (intent.kind === "checkout-branch")
    return { ...placement, kind: intent.kind, branch: intent.branchName };
  const { localBranchName, baseRefName, ...facts } = intent;
  return {
    ...placement,
    ...facts,
    branch: localBranchName ?? intent.headRef,
    baseRef: baseRefName,
  };
}

function creationIntentFromRequest(
  request: PluginWorktreeCreateRequest,
  original: WorktreeCreationIntent,
): WorktreeCreationIntent {
  if (request.kind === "branch-off") {
    return {
      kind: request.kind,
      branchName: request.branch,
      baseBranch: request.baseRef,
      // PR heads can differ from their comparison base. A hook that changes only
      // placement or branch keeps the fetched head; a new base replaces it.
      ...(original.kind === "branch-off" &&
      original.baseBranch === request.baseRef &&
      original.startPoint
        ? { startPoint: original.startPoint }
        : {}),
    };
  }
  if (request.kind === "checkout-branch") {
    return {
      kind: request.kind,
      branchName: request.branch,
    };
  }
  const {
    repoRoot: _repoRoot,
    sourceCheckout: _checkout,
    slug: _slug,
    path: _path,
    branch,
    baseRef,
    ...facts
  } = request;
  const keepLocalBranchName =
    branch !== request.headRef ||
    ((original.kind === "checkout-change-request" || original.kind === "checkout-github-pr") &&
      original.localBranchName !== undefined);
  return {
    ...facts,
    ...(keepLocalBranchName ? { localBranchName: branch } : {}),
    baseRefName: baseRef,
  };
}

async function resolveForge(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
  intentInput: ResolveWorktreeCreationIntentInput,
): Promise<{ forge: string; service: ForgeService }> {
  const resolution = await deps.workspaceGitService?.resolveForge(repoRoot);
  if (!resolution) {
    if (intentInput.checkoutSource?.forge && intentInput.checkoutSource.forge !== "github") {
      throw new UnsupportedForgeCheckoutTargetError(intentInput.checkoutSource.forge);
    }
    // No recognized remote: fall back to GitHub, the wire-default forge.
    return { forge: "github", service: deps.github };
  }
  return { forge: resolution.forge, service: resolution.service };
}

async function resolveDefaultBranch(
  repoRoot: string,
  deps: CreateWorktreeCoreDeps,
): Promise<string> {
  const baseBranch = deps.resolveDefaultBranch
    ? await deps.resolveDefaultBranch(repoRoot)
    : await deps.workspaceGitService?.resolveDefaultBranch(repoRoot);
  if (!baseBranch) {
    throw new Error("Unable to resolve repository default branch");
  }
  return baseBranch;
}

export async function resolveWorktreeRepoRoot(
  input: Pick<CreateWorktreeCoreInput, "cwd" | "jagentdeskHome">,
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<string> {
  if (!workspaceGitService) {
    throw new Error("Create worktree requires WorkspaceGitService");
  }

  return workspaceGitService.resolveRepoRoot(input.cwd);
}

function validateWorktreeSlug(slug: string): string {
  const validation = validateBranchSlug(slug);
  if (!validation.valid) {
    throw new Error(`Invalid worktree name: ${validation.error}`);
  }
  return slug;
}

function normalizeWorktreeSlug(value: string): string {
  return validateWorktreeSlug(slugify(value));
}

// A reused worktree keeps the comparison base recorded when it was created; a worktree
// without JAgentDesk metadata falls back to the base the request named.
async function resolveReusedWorktreeComparisonBase(
  intent: WorktreeCreationIntent,
  worktreePath: string,
): Promise<string | null> {
  if (intent.kind === "checkout-branch") return null;
  const metadata = await readJAgentDeskWorktreeMetadata(worktreePath);
  if (metadata) return metadata.baseRef ?? metadata.baseRefName;
  return normalizeBaseRefName(
    intent.kind === "branch-off" ? intent.baseBranch : intent.baseRefName,
  );
}
