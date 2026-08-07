import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { z } from "zod";

const ChangeRequestLookupTargetSchema = z.object({
  headRef: z.string().min(1),
  headRepositoryOwner: z.string().min(1).optional(),
  changeRequestNumber: z.number().int().positive().optional(),
  localBranchName: z.string().min(1).optional(),
});

const JAgentDeskWorktreeMetadataV1Schema = z.object({
  version: z.literal(1),
  baseRefName: z.string().min(1),
  changeRequestLookupTarget: ChangeRequestLookupTargetSchema.optional(),
});

const JAgentDeskWorktreeMetadataV2Schema = z.object({
  version: z.literal(2),
  baseRefName: z.string().min(1),
  changeRequestLookupTarget: ChangeRequestLookupTargetSchema.optional(),
  firstAgentBranchAutoName: z
    .discriminatedUnion("status", [
      z.object({
        status: z.literal("pending"),
        placeholderBranchName: z.string().min(1),
      }),
      z.object({
        status: z.literal("attempted"),
        placeholderBranchName: z.string().min(1),
        attemptedAt: z.string().min(1),
      }),
    ])
    .optional(),
  runtime: z
    .object({
      worktreePort: z.number().int().positive(),
    })
    .optional(),
});

const JAgentDeskWorktreeMetadataSchema = z.union([
  JAgentDeskWorktreeMetadataV1Schema,
  JAgentDeskWorktreeMetadataV2Schema,
]);

export type JAgentDeskWorktreeMetadata = z.infer<typeof JAgentDeskWorktreeMetadataSchema>;
export type JAgentDeskWorktreeChangeRequestHint = z.infer<typeof ChangeRequestLookupTargetSchema>;

export function createJAgentDeskWorktreeChangeRequestHint(
  input: JAgentDeskWorktreeChangeRequestHint,
): JAgentDeskWorktreeChangeRequestHint {
  return ChangeRequestLookupTargetSchema.parse(input);
}

export function getJAgentDeskWorktreeChangeRequestHintForBranch(
  metadata: JAgentDeskWorktreeMetadata | null,
  currentBranch: string,
): JAgentDeskWorktreeChangeRequestHint | null {
  const target = metadata?.changeRequestLookupTarget;
  if (!target) {
    return null;
  }
  if (target.localBranchName) {
    return target.localBranchName === currentBranch ? target : null;
  }

  // COMPAT(change-request-local-branch): metadata before v0.2.5 omitted the
  // local binding; remove after 2027-07-31.
  const canonicalBranches = new Set<string>();
  if (target.headRepositoryOwner) {
    canonicalBranches.add(`${target.headRepositoryOwner}/${target.headRef}`);
    const normalizedOwner = normalizeLegacyGitHubOwnerForBranch(target.headRepositoryOwner);
    if (normalizedOwner) {
      canonicalBranches.add(`${normalizedOwner}/${target.headRef}`);
    }
  } else {
    canonicalBranches.add(target.headRef);
  }
  return canonicalBranches.has(currentBranch) ? target : null;
}

function normalizeLegacyGitHubOwnerForBranch(owner: string): string | null {
  const normalized = owner.trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(normalized) ? normalized : null;
}

export function rebindJAgentDeskWorktreeChangeRequestHint(
  worktreeRoot: string,
  previousBranch: string,
  currentBranch: string,
): boolean {
  const metadata = readJAgentDeskWorktreeMetadata(worktreeRoot);
  const target = getJAgentDeskWorktreeChangeRequestHintForBranch(metadata, previousBranch);
  if (!metadata || !target) {
    return false;
  }

  writeJAgentDeskWorktreeMetadataFile(worktreeRoot, {
    ...metadata,
    changeRequestLookupTarget: {
      ...target,
      localBranchName: currentBranch,
    },
  });
  return true;
}

function getGitDirForWorktreeRoot(worktreeRoot: string): string {
  const gitPath = join(worktreeRoot, ".git");
  if (!existsSync(gitPath)) {
    throw new Error(`Not a git repository: ${worktreeRoot}`);
  }

  // In a worktree checkout, `.git` is a file containing `gitdir: <path>`.
  // In a normal checkout, `.git` is a directory.
  try {
    const gitFileContent = readFileSync(gitPath, "utf8");
    const match = gitFileContent.match(/gitdir:\s*(.+)/);
    if (match?.[1]) {
      const raw = match[1].trim();
      return isAbsolute(raw) ? raw : resolve(worktreeRoot, raw);
    }
  } catch {
    // If `.git` is a directory, readFileSync will throw; fall through.
  }

  return gitPath;
}

export function getJAgentDeskWorktreeMetadataPath(worktreeRoot: string): string {
  const gitDir = getGitDirForWorktreeRoot(worktreeRoot);
  return join(gitDir, "jagentdesk", "worktree.json");
}

export function normalizeBaseRefName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Base branch is required");
  }
  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  if (trimmed.startsWith("refs/remotes/origin/")) {
    return trimmed.slice("refs/remotes/origin/".length);
  }
  if (trimmed.startsWith("origin/")) {
    return trimmed.slice("origin/".length);
  }
  return trimmed;
}

export function writeJAgentDeskWorktreeMetadata(
  worktreeRoot: string,
  options: {
    baseRefName: string;
    changeRequestLookupTarget?: JAgentDeskWorktreeChangeRequestHint;
  },
): void {
  const baseRefName = normalizeBaseRefName(options.baseRefName);
  if (baseRefName === "HEAD") {
    throw new Error("Base branch cannot be HEAD");
  }
  if (baseRefName.includes("..") || baseRefName.includes("@{")) {
    throw new Error(`Invalid base branch: ${baseRefName}`);
  }
  if (!/^[0-9A-Za-z._/-]+$/.test(baseRefName)) {
    throw new Error(`Invalid base branch: ${baseRefName}`);
  }

  const metadata: JAgentDeskWorktreeMetadata = {
    version: 1,
    baseRefName,
    ...(options.changeRequestLookupTarget
      ? { changeRequestLookupTarget: options.changeRequestLookupTarget }
      : {}),
  };
  writeJAgentDeskWorktreeMetadataFile(worktreeRoot, metadata);
}

export function writeJAgentDeskWorktreeRuntimeMetadata(
  worktreeRoot: string,
  options: { worktreePort: number },
): void {
  if (!Number.isInteger(options.worktreePort) || options.worktreePort <= 0) {
    throw new Error(`Invalid worktree runtime port: ${options.worktreePort}`);
  }

  const current = readJAgentDeskWorktreeMetadata(worktreeRoot);
  if (!current) {
    throw new Error("Cannot persist worktree runtime metadata: missing base metadata");
  }

  const next: JAgentDeskWorktreeMetadata = {
    version: 2,
    baseRefName: current.baseRefName,
    ...(current.changeRequestLookupTarget
      ? { changeRequestLookupTarget: current.changeRequestLookupTarget }
      : {}),
    ...(current.version === 2 && current.firstAgentBranchAutoName
      ? { firstAgentBranchAutoName: current.firstAgentBranchAutoName }
      : {}),
    runtime: {
      worktreePort: options.worktreePort,
    },
  };
  writeJAgentDeskWorktreeMetadataFile(worktreeRoot, next);
}

export function writeJAgentDeskWorktreeFirstAgentBranchAutoNameMetadata(
  worktreeRoot: string,
  options: { placeholderBranchName: string },
): void {
  const placeholderBranchName = options.placeholderBranchName.trim();
  if (!placeholderBranchName) {
    throw new Error("Placeholder branch name is required");
  }

  const current = readJAgentDeskWorktreeMetadata(worktreeRoot);
  if (!current) {
    throw new Error("Cannot persist first-agent branch auto-name metadata: missing base metadata");
  }

  writeJAgentDeskWorktreeMetadataFile(worktreeRoot, {
    version: 2,
    baseRefName: current.baseRefName,
    ...(current.changeRequestLookupTarget
      ? { changeRequestLookupTarget: current.changeRequestLookupTarget }
      : {}),
    firstAgentBranchAutoName: {
      status: "pending",
      placeholderBranchName,
    },
    ...(current.version === 2 && current.runtime ? { runtime: current.runtime } : {}),
  });
}

export function markJAgentDeskWorktreeFirstAgentBranchAutoNameAttempted(
  worktreeRoot: string,
  options: { attemptedAt?: string } = {},
): JAgentDeskWorktreeMetadata | null {
  const current = readJAgentDeskWorktreeMetadata(worktreeRoot);
  if (!current || current.version !== 2 || current.firstAgentBranchAutoName?.status !== "pending") {
    return current;
  }

  const next: JAgentDeskWorktreeMetadata = {
    version: 2,
    baseRefName: current.baseRefName,
    ...(current.changeRequestLookupTarget
      ? { changeRequestLookupTarget: current.changeRequestLookupTarget }
      : {}),
    firstAgentBranchAutoName: {
      status: "attempted",
      placeholderBranchName: current.firstAgentBranchAutoName.placeholderBranchName,
      attemptedAt: options.attemptedAt ?? new Date().toISOString(),
    },
    ...(current.runtime ? { runtime: current.runtime } : {}),
  };
  writeJAgentDeskWorktreeMetadataFile(worktreeRoot, next);
  return next;
}

export function readJAgentDeskWorktreeMetadata(worktreeRoot: string): JAgentDeskWorktreeMetadata | null {
  const metadataPath = getJAgentDeskWorktreeMetadataPath(worktreeRoot);
  if (!existsSync(metadataPath)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  return JAgentDeskWorktreeMetadataSchema.parse(parsed);
}

export function requireJAgentDeskWorktreeBaseRefName(worktreeRoot: string): string {
  const metadataPath = getJAgentDeskWorktreeMetadataPath(worktreeRoot);
  const metadata = readJAgentDeskWorktreeMetadata(worktreeRoot);
  if (!metadata) {
    throw new Error(`Missing JAgentDesk worktree base metadata: ${metadataPath}`);
  }
  return metadata.baseRefName;
}

export function readJAgentDeskWorktreeRuntimePort(worktreeRoot: string): number | null {
  const metadata = readJAgentDeskWorktreeMetadata(worktreeRoot);
  if (!metadata) {
    return null;
  }
  if (metadata.version === 2 && metadata.runtime?.worktreePort) {
    return metadata.runtime.worktreePort;
  }
  return null;
}

function writeJAgentDeskWorktreeMetadataFile(
  worktreeRoot: string,
  metadata: JAgentDeskWorktreeMetadata,
): void {
  const metadataPath = getJAgentDeskWorktreeMetadataPath(worktreeRoot);
  mkdirSync(join(getGitDirForWorktreeRoot(worktreeRoot), "jagentdesk"), { recursive: true });
  const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(tempPath, metadataPath);
}
