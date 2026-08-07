import { join } from "node:path";

import { getJAgentDeskWorktreesRoot, isJAgentDeskOwnedWorktreeCwd } from "../../utils/worktree.js";
import {
  archiveByScope,
  resolveWorkspaceIdAtPath,
  type ArchiveDependencies,
  type ArchiveScope,
} from "../workspace-archive-service.js";
import type {
  CreateJAgentDeskWorktreeInput,
  CreateJAgentDeskWorktreeResult,
} from "../jagentdesk-worktree-service.js";
import { toWorktreeWireError, type WorktreeWireError } from "../worktree-errors.js";
import type { WorkspaceGitService, WorkspaceGitWorktreeInfo } from "../workspace-git-service.js";

export interface ListJAgentDeskWorktreesCommandDependencies {
  workspaceGitService: Pick<WorkspaceGitService, "listWorktrees">;
}

export interface ListJAgentDeskWorktreesCommandInput {
  cwd: string;
  reason?: string;
}

export async function listJAgentDeskWorktreesCommand(
  dependencies: ListJAgentDeskWorktreesCommandDependencies,
  input: ListJAgentDeskWorktreesCommandInput,
): Promise<WorkspaceGitWorktreeInfo[]> {
  if (input.reason) {
    return dependencies.workspaceGitService.listWorktrees(input.cwd, { reason: input.reason });
  }
  return dependencies.workspaceGitService.listWorktrees(input.cwd);
}

type CreateJAgentDeskWorktreeWorkflow<Result extends CreateJAgentDeskWorktreeResult> = (
  input: CreateJAgentDeskWorktreeInput,
) => Promise<Result>;

export interface CreateJAgentDeskWorktreeCommandDependencies<
  Result extends CreateJAgentDeskWorktreeResult = CreateJAgentDeskWorktreeResult,
> {
  jagentdeskHome?: string;
  worktreesRoot?: string;
  createJAgentDeskWorktreeWorkflow?: CreateJAgentDeskWorktreeWorkflow<Result>;
}

export type CreateJAgentDeskWorktreeCommandInput = Omit<
  CreateJAgentDeskWorktreeInput,
  "jagentdeskHome" | "runSetup"
> & {
  jagentdeskHome?: string;
  worktreesRoot?: string;
};

export type CreateJAgentDeskWorktreeCommandResult<Result extends CreateJAgentDeskWorktreeResult> =
  | {
      ok: true;
      createdWorktree: Result;
    }
  | {
      ok: false;
      error: WorktreeWireError;
      cause: unknown;
    };

export async function createJAgentDeskWorktreeCommand<Result extends CreateJAgentDeskWorktreeResult>(
  dependencies: CreateJAgentDeskWorktreeCommandDependencies<Result>,
  input: CreateJAgentDeskWorktreeCommandInput,
): Promise<CreateJAgentDeskWorktreeCommandResult<Result>> {
  try {
    if (!dependencies.createJAgentDeskWorktreeWorkflow) {
      throw new Error("JAgentDesk worktree service is not configured");
    }

    const createdWorktree = await dependencies.createJAgentDeskWorktreeWorkflow({
      ...input,
      runSetup: false,
      jagentdeskHome: input.jagentdeskHome ?? dependencies.jagentdeskHome,
      worktreesRoot: input.worktreesRoot ?? dependencies.worktreesRoot,
    });
    return { ok: true, createdWorktree };
  } catch (error) {
    return {
      ok: false,
      error: toWorktreeWireError(error),
      cause: error,
    };
  }
}

export interface ArchiveCommandDependencies extends Omit<
  ArchiveDependencies,
  "workspaceGitService"
> {
  workspaceGitService: Pick<WorkspaceGitService, "getSnapshot" | "listWorktrees">;
}

export interface ArchiveCommandInput {
  requestId: string;
  repoRoot?: string | null;
  worktreePath?: string;
  worktreeSlug?: string;
  branchName?: string;
  workspaceId?: string;
  scope?: ArchiveScope["kind"];
}

export type ArchiveCommandResult =
  | {
      ok: true;
      removedAgents: string[];
    }
  | {
      ok: false;
      code: "NOT_ALLOWED";
      message: string;
      removedAgents: [];
    };

export async function archiveCommand(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
): Promise<ArchiveCommandResult> {
  const targetPath = await resolveArchiveTarget(dependencies, input);
  const scope = input.scope ?? "workspace";
  const ownership = await isJAgentDeskOwnedWorktreeCwd(targetPath, {
    jagentdeskHome: dependencies.jagentdeskHome,
    worktreesRoot: dependencies.jagentdeskWorktreesBaseRoot,
  });

  if (scope === "worktree") {
    if (!ownership.allowed) {
      return {
        ok: false,
        code: "NOT_ALLOWED",
        message: "Worktree is not a JAgentDesk-owned worktree",
        removedAgents: [],
      };
    }

    const result = await archiveByScope(dependencies, {
      scope: { kind: "worktree", targetPath },
      requestId: input.requestId,
    });

    return {
      ok: true,
      removedAgents: result.archivedAgentIds,
    };
  }

  const workspaceId =
    input.workspaceId ?? (await resolveWorkspaceIdAtPath(dependencies, targetPath));

  if (!workspaceId) {
    dependencies.sessionLogger?.warn(
      { targetPath },
      "Could not resolve workspace for archive; skipping",
    );
    return {
      ok: true,
      removedAgents: [],
    };
  }

  const result = await archiveByScope(dependencies, {
    scope: { kind: "workspace", workspaceId },
    requestId: input.requestId,
  });

  return {
    ok: true,
    removedAgents: result.archivedAgentIds,
  };
}

async function resolveArchiveTarget(
  dependencies: ArchiveCommandDependencies,
  input: ArchiveCommandInput,
): Promise<string> {
  const repoRoot = input.repoRoot ?? null;
  if (input.worktreePath) {
    return input.worktreePath;
  }

  if (input.worktreeSlug) {
    if (!repoRoot) {
      throw new Error("repoRoot is required when worktreeSlug is supplied");
    }
    return resolveWorktreeSlugPath(dependencies, repoRoot, input.worktreeSlug);
  }

  if (repoRoot && input.branchName) {
    const worktrees = await dependencies.workspaceGitService.listWorktrees(repoRoot);
    const match = worktrees.find((entry) => entry.branchName === input.branchName);
    if (!match) {
      throw new Error(`JAgentDesk worktree not found for branch ${input.branchName}`);
    }
    return match.path;
  }

  throw new Error("worktreePath, worktreeSlug, or repoRoot+branchName is required");
}

async function resolveWorktreeSlugPath(
  dependencies: ArchiveCommandDependencies,
  repoRoot: string,
  worktreeSlug: string,
): Promise<string> {
  const worktreesRoot = await getJAgentDeskWorktreesRoot(
    repoRoot,
    dependencies.jagentdeskHome,
    dependencies.jagentdeskWorktreesBaseRoot,
  );
  return join(worktreesRoot, worktreeSlug);
}
