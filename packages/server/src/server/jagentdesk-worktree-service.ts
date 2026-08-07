import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { WorkspaceGitService } from "./workspace-git-service.js";
import { getRealpathAwareRelativePath } from "../utils/path.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";
import type { WorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  createWorktreeCore,
  type CreateWorktreeCoreDeps,
  type CreateWorktreeCoreInput,
} from "./worktree-core.js";
import {
  mapWorkspaceRelativeCwdToWorktree,
  rollbackCreatedJAgentDeskWorktree,
  seedJAgentDeskConfigFile,
  validateBranchSlug,
  type WorktreeConfig,
} from "../utils/worktree.js";
import { getCurrentBranch, localBranchExists, renameCurrentBranch } from "../utils/checkout-git.js";
import {
  markJAgentDeskWorktreeFirstAgentBranchAutoNameAttempted,
  normalizeBaseRefName,
  readJAgentDeskWorktreeMetadata,
  writeJAgentDeskWorktreeFirstAgentBranchAutoNameMetadata,
} from "../utils/worktree-metadata.js";
import type { WorktreeCreationIntent } from "./resolve-worktree-creation-intent.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import type { FirstAgentContext } from "@jagentdesk/protocol/messages";

export interface CreateJAgentDeskWorktreeInput extends CreateWorktreeCoreInput {
  projectId?: string;
  title?: string;
}

export interface CreateJAgentDeskWorktreeResult {
  worktree: WorktreeConfig;
  intent: WorktreeCreationIntent;
  workspace: PersistedWorkspaceRecord;
  repoRoot: string;
  created: boolean;
}

export type CreateJAgentDeskWorktreeFn = (
  input: CreateJAgentDeskWorktreeInput,
  options?: {
    resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  },
) => Promise<CreateJAgentDeskWorktreeResult>;

export interface AttemptFirstAgentBranchAutoNameResult {
  attempted: boolean;
  renamed: boolean;
  branchName: string | null;
}

export interface CreateJAgentDeskWorktreeDeps extends CreateWorktreeCoreDeps {
  workspaceGitService: WorkspaceGitService;
  workspaceProvisioning: Pick<WorkspaceProvisioningService, "createWorkspaceForWorktree">;
}

export async function createJAgentDeskWorktree(
  input: CreateJAgentDeskWorktreeInput,
  deps: CreateJAgentDeskWorktreeDeps,
): Promise<CreateJAgentDeskWorktreeResult> {
  const workspaceCwdPlan = await planWorkspaceCwdForWorktree(input.cwd, deps.workspaceGitService);
  const createdWorktree = await createWorktreeCore(input, deps);
  try {
    maybeMarkFirstAgentBranchAutoNameEligible({ createdWorktree });
    const workspaceCwd = mapWorkspaceRelativeCwdToWorktree({
      relativeWorkspaceCwd: workspaceCwdPlan.relativeWorkspaceCwd,
      targetWorktreePath: createdWorktree.worktree.worktreePath,
    });
    if (!(await isDirectory(workspaceCwd))) {
      throw new Error(`Selected project directory is missing from the worktree: ${workspaceCwd}`);
    }

    if (createdWorktree.created) {
      await seedJAgentDeskConfigFile({
        sourceCwd: workspaceCwdPlan.inputCwd,
        targetCwd: workspaceCwd,
      });
    }
    const workspace = await deps.workspaceProvisioning.createWorkspaceForWorktree({
      sourceCwd: workspaceCwdPlan.inputCwd,
      projectId: input.projectId,
      repoRoot: createdWorktree.repoRoot,
      cwd: workspaceCwd,
      worktreeRoot: createdWorktree.worktree.worktreePath,
      branch: createdWorktree.worktree.branchName || null,
      baseBranch: resolveIntentBaseBranch(createdWorktree.intent),
      title: input.title?.trim() || resolveFirstAgentPromptTitle(input.firstAgentContext),
      expectsInitialAgent: Boolean(input.firstAgentContext),
    });

    deps.github.invalidate({ cwd: createdWorktree.worktree.worktreePath });

    return {
      worktree: createdWorktree.worktree,
      intent: createdWorktree.intent,
      workspace,
      repoRoot: createdWorktree.repoRoot,
      created: createdWorktree.created,
    };
  } catch (error) {
    if (!createdWorktree.created) {
      throw error;
    }
    return rollbackCreatedJAgentDeskWorktree(
      {
        cwd: createdWorktree.repoRoot,
        worktreePath: createdWorktree.worktree.worktreePath,
        ...(input.runSetup === false ? { teardownCwds: [] } : {}),
        jagentdeskHome: input.jagentdeskHome,
        worktreesBaseRoot: input.worktreesRoot,
      },
      error,
    );
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function planWorkspaceCwdForWorktree(
  inputCwd: string,
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout">,
): Promise<{ inputCwd: string; relativeWorkspaceCwd: string }> {
  const normalizedInputCwd = resolve(inputCwd);
  const sourceCheckout = await workspaceGitService.getCheckout(normalizedInputCwd);
  const sourceWorktreePath = sourceCheckout.worktreeRoot ?? normalizedInputCwd;
  const relativeWorkspaceCwd = getRealpathAwareRelativePath(sourceWorktreePath, normalizedInputCwd);
  if (relativeWorkspaceCwd === null) {
    throw new Error(`Workspace cwd is outside its source worktree: ${normalizedInputCwd}`);
  }
  return { inputCwd: normalizedInputCwd, relativeWorkspaceCwd };
}

export async function attemptFirstAgentBranchAutoName(options: {
  cwd: string;
  firstAgentContext: FirstAgentContext | undefined;
  generateBranchNameFromContext: (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => Promise<string | null>;
  getCurrentBranch?: typeof getCurrentBranch;
  renameCurrentBranch?: typeof renameCurrentBranch;
  localBranchExists?: typeof localBranchExists;
}): Promise<AttemptFirstAgentBranchAutoNameResult> {
  const firstAgentContext = options.firstAgentContext;
  if (!firstAgentContext || !buildAgentBranchNameSeed(firstAgentContext)) {
    return { attempted: false, renamed: false, branchName: null };
  }

  let metadata: ReturnType<typeof readJAgentDeskWorktreeMetadata>;
  try {
    metadata = readJAgentDeskWorktreeMetadata(options.cwd);
  } catch {
    return { attempted: false, renamed: false, branchName: null };
  }
  if (
    !metadata ||
    metadata.version !== 2 ||
    metadata.firstAgentBranchAutoName?.status !== "pending"
  ) {
    return { attempted: false, renamed: false, branchName: null };
  }

  const getCurrentBranchImpl = options.getCurrentBranch ?? getCurrentBranch;
  const placeholderBranchName = metadata.firstAgentBranchAutoName.placeholderBranchName;
  if ((await getCurrentBranchImpl(options.cwd)) !== placeholderBranchName) {
    markJAgentDeskWorktreeFirstAgentBranchAutoNameAttempted(options.cwd);
    return { attempted: true, renamed: false, branchName: null };
  }

  markJAgentDeskWorktreeFirstAgentBranchAutoNameAttempted(options.cwd);

  const branchName = await options.generateBranchNameFromContext({
    cwd: options.cwd,
    firstAgentContext,
  });
  if (!branchName) {
    return { attempted: true, renamed: false, branchName: null };
  }
  const validation = validateBranchSlug(branchName);
  if (!validation.valid || branchName === placeholderBranchName) {
    return { attempted: true, renamed: false, branchName: null };
  }
  if ((await getCurrentBranchImpl(options.cwd)) !== placeholderBranchName) {
    return { attempted: true, renamed: false, branchName: null };
  }

  const localBranchExistsImpl = options.localBranchExists ?? localBranchExists;
  const targetName = await findAvailableBranchName({
    cwd: options.cwd,
    desiredName: branchName,
    placeholderBranchName,
    localBranchExists: localBranchExistsImpl,
  });
  if (!targetName) {
    return { attempted: true, renamed: false, branchName: null };
  }

  const renameCurrentBranchImpl = options.renameCurrentBranch ?? renameCurrentBranch;
  const renamedBranch = await renameCurrentBranchImpl(options.cwd, targetName);
  return {
    attempted: true,
    renamed: true,
    branchName: renamedBranch.currentBranch ?? targetName,
  };
}

const MAX_BRANCH_NAME_SUFFIX_ATTEMPTS = 50;

async function findAvailableBranchName(options: {
  cwd: string;
  desiredName: string;
  placeholderBranchName: string;
  localBranchExists: (cwd: string, branchName: string) => Promise<boolean>;
}): Promise<string | null> {
  const { cwd, desiredName, placeholderBranchName } = options;
  if (!(await options.localBranchExists(cwd, desiredName))) {
    return desiredName;
  }
  for (let suffix = 2; suffix <= MAX_BRANCH_NAME_SUFFIX_ATTEMPTS; suffix++) {
    const candidate = `${desiredName}-${suffix}`;
    if (candidate === placeholderBranchName) {
      continue;
    }
    if (!(await options.localBranchExists(cwd, candidate))) {
      return candidate;
    }
  }
  return null;
}

function maybeMarkFirstAgentBranchAutoNameEligible(options: {
  createdWorktree: Awaited<ReturnType<typeof createWorktreeCore>>;
}): void {
  const { createdWorktree } = options;
  if (!createdWorktree.created || createdWorktree.intent.kind !== "branch-off") {
    return;
  }

  writeJAgentDeskWorktreeFirstAgentBranchAutoNameMetadata(createdWorktree.worktree.worktreePath, {
    placeholderBranchName: createdWorktree.worktree.branchName,
  });
}

// The base branch is normalized to match worktree.json's baseRefName (origin/
// stripped). checkout-branch worktrees have no distinct base, so they stay null.
function resolveIntentBaseBranch(intent: WorktreeCreationIntent): string | null {
  switch (intent.kind) {
    case "branch-off":
      return normalizeBaseRefName(intent.baseBranch);
    case "checkout-change-request":
      return normalizeBaseRefName(intent.baseRefName);
    case "checkout-github-pr":
      return normalizeBaseRefName(intent.baseRefName);
    case "checkout-branch":
      return null;
  }
}
