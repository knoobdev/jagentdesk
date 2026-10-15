import { execFile } from "child_process";
import { promisify } from "util";
import { realpath, rmSync } from "fs";
import pLimit from "p-limit";
import { copyFile, mkdir, rm, stat } from "fs/promises";
import { join, basename, dirname, isAbsolute, resolve, sep } from "path";
import net from "node:net";
import { createHash } from "node:crypto";
import stripAnsi from "strip-ansi";
import {
  buildStringCommandShellInvocation,
  createStringCommandShellEnv,
} from "./string-command-shell.js";
import { readJAgentDeskConfig } from "./jagentdesk-config-file.js";
export {
  JAgentDeskConfigRawSchema,
  JAgentDeskLifecycleCommandRawSchema,
  JAgentDeskScriptEntryRawSchema,
  JAgentDeskWorktreeConfigRawSchema,
  JAgentDeskConfigSchema,
  type JAgentDeskConfig,
  type JAgentDeskConfigRaw,
} from "@jagentdesk/protocol/jagentdesk-config-schema";
import type { JAgentDeskConfig } from "@jagentdesk/protocol/jagentdesk-config-schema";
import {
  createJAgentDeskWorktreeChangeRequestHint,
  normalizeBaseRefName,
  isQualifiedRef,
  type JAgentDeskWorktreeChangeRequestHint,
  readJAgentDeskWorktreeMetadata,
  readJAgentDeskWorktreeRuntimePort,
  writeJAgentDeskWorktreeMetadata,
  writeJAgentDeskWorktreeRuntimeMetadata,
} from "./worktree-metadata.js";
import { runGitCommand } from "./run-git-command.js";
import { getCurrentBranch, resolveRepositoryDefaultBranch } from "./checkout-git.js";
import { spawnProcess } from "./spawn.js";
import { resolveJAgentDeskHome } from "../server/jagentdesk-home.js";
import { createExternalProcessEnv } from "../server/jagentdesk-env.js";
import { parseGitRevParsePath, resolveGitRevParsePath } from "./git-rev-parse-path.js";
import { validateBranchSlug } from "@jagentdesk/protocol/branch-slug";
import {
  expandTilde,
  getRealpathAwareRelativePath,
  getRelativePathInsideRoot,
  isPathInsideRoot,
} from "./path.js";

export { slugify, validateBranchSlug } from "@jagentdesk/protocol/branch-slug";

const execFileAsync = promisify(execFile);
const READ_ONLY_GIT_ENV = {
  GIT_OPTIONAL_LOCKS: "0",
} as const;

export interface WorktreeConfig {
  branchName: string;
  worktreePath: string;
}

export interface CreatedWorktree extends WorktreeConfig {
  comparisonBaseRef: string | null;
}

export interface WorktreeRuntimeEnv {
  [key: string]: string;
  JAGENTDESK_SOURCE_CHECKOUT_PATH: string;
  JAGENTDESK_ROOT_PATH: string;
  JAGENTDESK_WORKTREE_PATH: string;
  JAGENTDESK_BRANCH_NAME: string;
  JAGENTDESK_WORKTREE_PORT: string;
}

export interface WorktreeSetupCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export type WorktreeSetupCommandProgressEvent =
  | {
      type: "command_started";
      index: number;
      total: number;
      command: string;
      cwd: string;
    }
  | {
      type: "output";
      index: number;
      total: number;
      command: string;
      cwd: string;
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      type: "command_completed";
      index: number;
      total: number;
      command: string;
      cwd: string;
      exitCode: number | null;
      durationMs: number;
      stdout: string;
      stderr: string;
    };

export interface WorktreeTerminalConfig {
  name?: string;
  command: string;
}

export interface PlainScriptConfig {
  type?: undefined;
  command: string;
  port?: undefined;
}

export interface ServiceScriptConfig {
  type: "service";
  command: string;
  port?: number; // explicit port override, otherwise auto-assigned
}

export type ScriptConfig = PlainScriptConfig | ServiceScriptConfig;

export function isServiceScript(config: ScriptConfig): config is ServiceScriptConfig {
  return "type" in config && config.type === "service";
}

export class WorktreeSetupError extends Error {
  readonly results: WorktreeSetupCommandResult[];

  constructor(message: string, results: WorktreeSetupCommandResult[]) {
    super(message);
    this.name = "WorktreeSetupError";
    this.results = results;
  }
}

export type WorktreeTeardownCommandResult = WorktreeSetupCommandResult;

export class WorktreeTeardownError extends Error {
  readonly results: WorktreeTeardownCommandResult[];

  constructor(message: string, results: WorktreeTeardownCommandResult[]) {
    super(message);
    this.name = "WorktreeTeardownError";
    this.results = results;
  }
}

export interface JAgentDeskWorktreeInfo {
  path: string;
  createdAt: string;
  branchName?: string;
  head?: string;
}

export interface JAgentDeskWorktreeOwnership {
  allowed: boolean;
  repoRoot?: string;
  worktreeRoot?: string;
  worktreePath?: string;
}

export interface JAgentDeskWorktreeOwnershipOptions extends WorktreeRootOptions {
  knownGitCommonDir?: string | null;
}

export interface WorktreeRootOptions {
  jagentdeskHome?: string;
  worktreesRoot?: string;
}

export interface WorktreeCheckoutRef {
  remoteName?: string;
  remoteRef: string;
}

export type WorktreeSource =
  | { kind: "branch-off"; baseBranch: string; branchName: string }
  | { kind: "checkout-branch"; branchName: string }
  | { kind: "restore"; branchName: string; baseRef: string | null }
  | { kind: "restore-from-base"; baseRef: string; branchName: string }
  | {
      kind: "checkout-change-request";
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
  | {
      kind: "checkout-github-pr";
      githubPrNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      baseRefName: string;
      checkoutRefs?: WorktreeCheckoutRef[];
      localBranchName?: string;
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    };

export interface CreateWorktreeOptions {
  cwd: string;
  worktreeSlug: string;
  source: WorktreeSource;
  runSetup: boolean;
  jagentdeskHome?: string;
  worktreesRoot?: string;
}

interface ResolveExistingWorktreeForSlugOptions {
  slug: string;
  repoRoot: string;
  jagentdeskHome?: string;
  worktreesRoot?: string;
}

export class BranchAlreadyCheckedOutError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Branch already checked out: ${branchName}`);
    this.name = "BranchAlreadyCheckedOutError";
    this.branchName = branchName;
  }
}

export class UnknownBranchError extends Error {
  readonly branchName: string;
  readonly cwd: string;

  constructor(params: { branchName: string; cwd: string }) {
    super(`Unknown branch: ${params.branchName}`);
    this.name = "UnknownBranchError";
    this.branchName = params.branchName;
    this.cwd = params.cwd;
  }
}

export class InvalidGitBranchNameError extends Error {
  readonly branchName: string;

  constructor(branchName: string) {
    super(`Invalid branch name: Git rejected ref name '${branchName}'`);
    this.name = "InvalidGitBranchNameError";
    this.branchName = branchName;
  }
}

export { readJAgentDeskConfig, type ReadJAgentDeskConfigResult } from "./jagentdesk-config-file.js";

export function jagentdeskConfigParseError(failure: { configPath: string; error: unknown }): Error {
  const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return new Error(`Failed to parse jagentdesk.json at ${failure.configPath}: ${detail}`, {
    cause: failure.error,
  });
}

async function readJAgentDeskConfigOrThrow(repoRoot: string): Promise<JAgentDeskConfig | null> {
  const result = await readJAgentDeskConfig(repoRoot);
  if (!result.ok) {
    throw jagentdeskConfigParseError(result);
  }
  return result.config;
}

export async function getWorktreeSetupCommands(repoRoot: string): Promise<string[]> {
  return (await readJAgentDeskConfigOrThrow(repoRoot))?.worktree?.setup ?? [];
}

export async function getWorktreeTeardownCommands(repoRoot: string): Promise<string[]> {
  return (await readJAgentDeskConfigOrThrow(repoRoot))?.worktree?.teardown ?? [];
}

export async function getWorktreeTerminalSpecs(
  repoRoot: string,
): Promise<WorktreeTerminalConfig[]> {
  const terminals = (await readJAgentDeskConfigOrThrow(repoRoot))?.worktree?.terminals;
  if (!Array.isArray(terminals) || terminals.length === 0) {
    return [];
  }

  const specs: WorktreeTerminalConfig[] = [];
  for (const terminal of terminals) {
    if (!terminal || typeof terminal !== "object") {
      continue;
    }

    const rawCommand = terminal.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const rawName = terminal.name;
    const name =
      typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : undefined;

    specs.push({
      ...(name ? { name } : {}),
      command,
    });
  }

  return specs;
}

export function getScriptConfigs(config: JAgentDeskConfig | null): Map<string, ScriptConfig> {
  const scripts = config?.scripts;
  if (!scripts || typeof scripts !== "object") {
    return new Map();
  }

  const result = new Map<string, ScriptConfig>();
  for (const [name, entry] of Object.entries(scripts)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const rawCommand = entry.command;
    if (typeof rawCommand !== "string") {
      continue;
    }
    const command = rawCommand.trim();
    if (!command) {
      continue;
    }

    const scriptConfig: ScriptConfig =
      entry.type === "service"
        ? {
            type: "service",
            command,
          }
        : { command };

    if (
      isServiceScript(scriptConfig) &&
      typeof entry.port === "number" &&
      Number.isFinite(entry.port)
    ) {
      scriptConfig.port = entry.port;
    }

    result.set(name, scriptConfig);
  }

  return result;
}

export function processCarriageReturns(text: string): string {
  if (!text.includes("\r")) {
    return text;
  }

  const output: string[] = [];
  let line: string[] = [];
  let cursor = 0;

  const flushLine = () => {
    output.push(line.join(""));
    line = [];
    cursor = 0;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === "\r") {
      if (text[index + 1] === "\n") {
        flushLine();
        output.push("\n");
        index += 1;
        continue;
      }
      cursor = 0;
      continue;
    }

    if (char === "\n") {
      flushLine();
      output.push("\n");
      continue;
    }

    if (cursor < line.length) {
      line[cursor] = char;
    } else {
      line.push(char);
    }
    cursor += 1;
  }

  if (line.length > 0) {
    output.push(line.join(""));
  }

  return output.join("");
}

async function execSetupCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<WorktreeSetupCommandResult> {
  const startedAt = Date.now();
  const shellInvocation = buildStringCommandShellInvocation({ command });
  try {
    const { stdout, stderr } = await execFileAsync(shellInvocation.shell, shellInvocation.args, {
      cwd: options.cwd,
      env: options.env,
    });
    return {
      command,
      cwd: options.cwd,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const execErr = error as { stdout?: string; stderr?: string; code?: unknown } | undefined;
    return {
      command,
      cwd: options.cwd,
      stdout: execErr?.stdout ?? "",
      stderr: execErr?.stderr ?? (error instanceof Error ? error.message : String(error)),
      exitCode: typeof execErr?.code === "number" ? execErr.code : null,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function execSetupCommandStreamed(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  index: number;
  total: number;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
}): Promise<WorktreeSetupCommandResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let settled = false;

    const emitOutput = (stream: "stdout" | "stderr", chunk: string) => {
      const text = stripAnsi(chunk);
      if (!text) {
        return;
      }
      if (stream === "stdout") {
        stdoutChunks.push(text);
      } else {
        stderrChunks.push(text);
      }
      options.onEvent?.({
        type: "output",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        stream,
        chunk: text,
      });
    };

    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      const result: WorktreeSetupCommandResult = {
        command: options.command,
        cwd: options.cwd,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        exitCode,
        durationMs: Date.now() - startedAt,
      };
      options.onEvent?.({
        type: "command_completed",
        index: options.index,
        total: options.total,
        command: options.command,
        cwd: options.cwd,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      resolvePromise(result);
    };

    options.onEvent?.({
      type: "command_started",
      index: options.index,
      total: options.total,
      command: options.command,
      cwd: options.cwd,
    });

    const shellInvocation = buildStringCommandShellInvocation({ command: options.command });
    const child = spawnProcess(shellInvocation.shell, shellInvocation.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      emitOutput("stdout", chunk.toString());
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      emitOutput("stderr", chunk.toString());
    });

    child.on("error", (error) => {
      emitOutput("stderr", error instanceof Error ? error.message : String(error));
      finish(null);
    });

    child.on("close", (code) => {
      finish(typeof code === "number" ? code : null);
    });
  });
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire available port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      let message: string;
      if (error?.code === "EADDRINUSE") {
        message = `Persisted worktree port ${port} is already in use`;
      } else if (error instanceof Error) {
        message = error.message;
      } else {
        message = String(error);
      }
      reject(new Error(message));
    });
    server.listen(port, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  });
}

async function inferRepoRootPathFromWorktreePath(worktreePath: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(worktreePath);
    const normalizedCommonDir = await normalizePathForOwnership(commonDir);
    // Normal repo/worktree: common dir is <repoRoot>/.git
    if (basename(normalizedCommonDir) === ".git") {
      return dirname(normalizedCommonDir);
    }
    // Bare repo: common dir is the repo dir itself
    return normalizedCommonDir;
  } catch {
    // Fallback: best-effort resolve toplevel (will be the worktree root in typical cases)
    try {
      const { stdout } = await runGitCommand(["rev-parse", "--show-toplevel"], {
        cwd: worktreePath,
        envOverlay: READ_ONLY_GIT_ENV,
      });
      const topLevel = parseGitRevParsePath(stdout);
      if (topLevel) {
        return await normalizePathForOwnership(topLevel);
      }
    } catch {
      // ignore
    }
    return await normalizePathForOwnership(worktreePath);
  }
}

export async function runWorktreeSetupCommands(options: {
  worktreePath: string;
  branchName: string;
  cleanupOnFailure: boolean;
  repoRootPath?: string;
  runtimeEnv?: WorktreeRuntimeEnv;
  onEvent?: (event: WorktreeSetupCommandProgressEvent) => void;
}): Promise<WorktreeSetupCommandResult[]> {
  // Read jagentdesk.json from the worktree (it will have the same content as the source repo)
  const setupCommands = await getWorktreeSetupCommands(options.worktreePath);
  if (setupCommands.length === 0) {
    return [];
  }

  const runtimeEnv =
    options.runtimeEnv ??
    (await resolveWorktreeRuntimeEnv({
      worktreePath: options.worktreePath,
      branchName: options.branchName,
      ...(options.repoRootPath ? { repoRootPath: options.repoRootPath } : {}),
    }));
  const setupEnv = createStringCommandShellEnv(createExternalProcessEnv(process.env, runtimeEnv));

  const results: WorktreeSetupCommandResult[] = [];
  for (const [index, cmd] of setupCommands.entries()) {
    const result = options.onEvent
      ? await execSetupCommandStreamed({
          command: cmd,
          cwd: options.worktreePath,
          env: setupEnv,
          index: index + 1,
          total: setupCommands.length,
          onEvent: options.onEvent,
        })
      : await execSetupCommand(cmd, {
          cwd: options.worktreePath,
          env: setupEnv,
        });
    results.push(result);

    if (result.exitCode !== 0) {
      if (options.cleanupOnFailure) {
        try {
          await runGitCommand(["worktree", "remove", options.worktreePath, "--force"], {
            cwd: options.worktreePath,
            timeout: 120_000,
          });
        } catch {
          rmSync(options.worktreePath, { recursive: true, force: true });
        }
      }
      throw new WorktreeSetupError(
        `Worktree setup command failed: ${cmd}\n${result.stderr}`.trim(),
        results,
      );
    }
  }

  return results;
}

async function resolveBranchNameForWorktreePath(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await runGitCommand(["branch", "--show-current"], {
      cwd: worktreePath,
      envOverlay: READ_ONLY_GIT_ENV,
    });
    const branchName = stdout.trim();
    if (branchName.length > 0) {
      return branchName;
    }
  } catch {
    // ignore
  }

  return basename(worktreePath);
}

export async function resolveWorktreeRuntimeEnv(options: {
  worktreePath: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeRuntimeEnv> {
  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));

  let worktreePort = await readJAgentDeskWorktreeRuntimePort(options.worktreePath);
  if (worktreePort === null) {
    worktreePort = await getAvailablePort();
    const metadata = await readJAgentDeskWorktreeMetadata(options.worktreePath);
    if (metadata) {
      await writeJAgentDeskWorktreeRuntimeMetadata(options.worktreePath, { worktreePort });
    }
  } else {
    await assertPortAvailable(worktreePort);
  }

  return {
    // Source checkout path is the original git repo root (shared across worktrees), not the
    // worktree itself. This allows setup scripts to copy local files (e.g. .env) from the
    // source checkout.
    JAGENTDESK_SOURCE_CHECKOUT_PATH: repoRootPath,
    // Backward-compatible alias.
    JAGENTDESK_ROOT_PATH: repoRootPath,
    JAGENTDESK_WORKTREE_PATH: options.worktreePath,
    JAGENTDESK_BRANCH_NAME: branchName,
    JAGENTDESK_WORKTREE_PORT: String(worktreePort),
  };
}

export async function runWorktreeTeardownCommands(options: {
  worktreePath: string;
  teardownCwd?: string;
  branchName?: string;
  repoRootPath?: string;
}): Promise<WorktreeTeardownCommandResult[]> {
  const teardownCwd = options.teardownCwd ?? options.worktreePath;
  if ((await getOwnershipRelativePath(options.worktreePath, teardownCwd)) === null) {
    throw new Error(`Worktree teardown cwd is outside the worktree: ${teardownCwd}`);
  }
  const teardownCommands = await getWorktreeTeardownCommands(teardownCwd);
  if (teardownCommands.length === 0) {
    return [];
  }

  const repoRootPath =
    options.repoRootPath ?? (await inferRepoRootPathFromWorktreePath(options.worktreePath));
  const branchName =
    options.branchName ?? (await resolveBranchNameForWorktreePath(options.worktreePath));
  const worktreePort = await readJAgentDeskWorktreeRuntimePort(options.worktreePath);

  const teardownEnv: NodeJS.ProcessEnv = createStringCommandShellEnv(
    createExternalProcessEnv(process.env, {
      // Source checkout path is the original git repo root (shared across worktrees), not the
      // worktree itself. This allows lifecycle scripts to copy or clean resources using paths
      // from the source checkout.
      JAGENTDESK_SOURCE_CHECKOUT_PATH: repoRootPath,
      // Backward-compatible alias.
      JAGENTDESK_ROOT_PATH: repoRootPath,
      JAGENTDESK_WORKTREE_PATH: options.worktreePath,
      JAGENTDESK_BRANCH_NAME: branchName,
      ...(worktreePort !== null ? { JAGENTDESK_WORKTREE_PORT: String(worktreePort) } : {}),
    }),
  );

  const results: WorktreeTeardownCommandResult[] = [];
  for (const cmd of teardownCommands) {
    const result = await execSetupCommand(cmd, {
      cwd: teardownCwd,
      env: teardownEnv,
    });
    results.push(result);

    if (result.exitCode !== 0) {
      throw new WorktreeTeardownError(
        `Worktree teardown command failed: ${cmd}\n${result.stderr}`.trim(),
        results,
      );
    }
  }

  return results;
}

export async function seedJAgentDeskConfigFile(options: {
  sourceCwd: string;
  targetCwd: string;
}): Promise<void> {
  const sourceConfigPath = join(options.sourceCwd, "jagentdesk.json");
  const targetConfigPath = join(options.targetCwd, "jagentdesk.json");
  try {
    await stat(targetConfigPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await copyFile(sourceConfigPath, targetConfigPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/**
 * Get the git common directory (shared across worktrees) for a given cwd.
 * This is where refs, objects, etc. are stored.
 */
export async function getGitCommonDir(cwd: string): Promise<string> {
  const { stdout } = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const commonDir = resolveGitRevParsePath(cwd, stdout);
  if (!commonDir) {
    throw new Error("Not in a git repository");
  }
  return commonDir;
}

const WORKTREE_PROJECT_HASH_LENGTH = 8;

function deriveShortAlphanumericHash(value: string): string {
  const digest = createHash("sha256").update(value).digest();
  let hashValue = 0n;
  for (let index = 0; index < 8; index += 1) {
    hashValue = (hashValue << 8n) | BigInt(digest[index] ?? 0);
  }
  return hashValue.toString(36).padStart(13, "0").slice(0, WORKTREE_PROJECT_HASH_LENGTH);
}

export async function deriveWorktreeProjectHash(cwd: string): Promise<string> {
  try {
    const commonDir = await getGitCommonDir(cwd);
    const normalizedCommonDir = await normalizePathForOwnership(commonDir);
    const repoRoot =
      basename(normalizedCommonDir) === ".git" ? dirname(normalizedCommonDir) : normalizedCommonDir;
    return deriveShortAlphanumericHash(repoRoot);
  } catch {
    return deriveShortAlphanumericHash(await normalizePathForOwnership(cwd));
  }
}

export function resolveJAgentDeskWorktreesBaseRoot(options?: WorktreeRootOptions): string {
  if (options?.worktreesRoot) {
    const expandedRoot = expandTilde(options.worktreesRoot);
    if (isAbsolute(expandedRoot)) {
      return resolve(expandedRoot);
    }
    const home = options.jagentdeskHome ? resolve(options.jagentdeskHome) : resolveJAgentDeskHome();
    return resolve(home, expandedRoot);
  }

  const home = options?.jagentdeskHome ? resolve(options.jagentdeskHome) : resolveJAgentDeskHome();
  return join(home, "worktrees");
}

export async function getJAgentDeskWorktreesRoot(
  cwd: string,
  jagentdeskHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  const baseRoot = resolveJAgentDeskWorktreesBaseRoot({ jagentdeskHome, worktreesRoot });
  const projectHash = await deriveWorktreeProjectHash(cwd);
  return join(baseRoot, projectHash);
}

export async function computeWorktreePath(
  cwd: string,
  slug: string,
  jagentdeskHome?: string,
  worktreesRoot?: string,
): Promise<string> {
  const projectWorktreesRoot = await getJAgentDeskWorktreesRoot(cwd, jagentdeskHome, worktreesRoot);
  return join(projectWorktreesRoot, slug);
}

export function mapWorkspaceCwdToWorktree(input: {
  sourceWorktreePath: string;
  workspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const relativeWorkspaceCwd = getRealpathAwareRelativePath(
    input.sourceWorktreePath,
    input.workspaceCwd,
  );
  if (relativeWorkspaceCwd === null) {
    throw new Error(`Workspace cwd is outside its source worktree: ${input.workspaceCwd}`);
  }

  return mapWorkspaceRelativeCwdToWorktree({
    relativeWorkspaceCwd,
    targetWorktreePath: input.targetWorktreePath,
  });
}

export function mapWorkspaceRelativeCwdToWorktree(input: {
  relativeWorkspaceCwd: string;
  targetWorktreePath: string;
}): string {
  const mappedCwd = resolve(input.targetWorktreePath, input.relativeWorkspaceCwd);
  if (!isPathInsideRoot(input.targetWorktreePath, mappedCwd)) {
    throw new Error(`Workspace cwd escapes its target worktree: ${input.relativeWorkspaceCwd}`);
  }
  return mappedCwd;
}

// Keep the former realpathSync spelling on Windows: promises.realpath uses the
// native resolver and can return an 8.3 alias instead of the long path.
const resolveOwnershipPath = promisify(realpath);
const resolveNativeOwnershipPath = promisify(realpath.native);
const ownershipIdentityIo = pLimit(2);

async function normalizePathForOwnership(input: string): Promise<string> {
  try {
    return await ownershipIdentityIo(() => resolveOwnershipPath(input));
  } catch {
    return resolve(input);
  }
}

async function ownershipPathVariants(input: string): Promise<string[]> {
  const variants = new Set([input, await normalizePathForOwnership(input)]);
  try {
    variants.add(await ownershipIdentityIo(() => resolveNativeOwnershipPath(input)));
  } catch {
    // Missing descendants still match a lexical or established root spelling.
  }
  return [...variants];
}

// Keep lexical variants for missing paths: archive must still recognize a removed
// worktree below a symlinked worktrees root, whose full realpath no longer exists.
async function getOwnershipRelativePath(root: string, candidate: string): Promise<string | null> {
  const roots = await ownershipPathVariants(root);
  const candidates = await ownershipPathVariants(candidate);
  for (const rootPath of roots) {
    for (const candidatePath of candidates) {
      const relative = getRelativePathInsideRoot(rootPath, candidatePath);
      if (relative !== null) return relative;
    }
  }
  return null;
}

async function resolveRepoRootFromGitCommonDir(commonDir: string): Promise<string> {
  const normalizedCommonDir = await normalizePathForOwnership(commonDir);
  return basename(normalizedCommonDir) === ".git"
    ? dirname(normalizedCommonDir)
    : normalizedCommonDir;
}

export async function isJAgentDeskOwnedWorktreeCwd(
  cwd: string,
  options?: JAgentDeskWorktreeOwnershipOptions,
): Promise<JAgentDeskWorktreeOwnership> {
  const resolvedCwd = await normalizePathForOwnership(cwd);

  // repoRoot is best-effort: git may be unreachable from the worktree (e.g. a
  // previous archive attempt removed the admin dir before the working tree
  // could be fully cleaned up). We still want to allow archiving in that case.
  let repoRoot: string | undefined;
  if (options?.knownGitCommonDir) {
    repoRoot = await resolveRepoRootFromGitCommonDir(options.knownGitCommonDir);
  } else if (options?.knownGitCommonDir === undefined) {
    try {
      const gitCommonDir = await getGitCommonDir(cwd);
      repoRoot = await resolveRepoRootFromGitCommonDir(gitCommonDir);
    } catch {
      // ignore
    }
  }

  const worktreesBaseRoot = resolveJAgentDeskWorktreesBaseRoot(options);
  const relativePath = await getOwnershipRelativePath(worktreesBaseRoot, resolvedCwd);

  // Ownership is defined by the path living under <worktrees-root>/<hash>/<slug>[/...].
  // The <hash>/<slug> prefix is JAgentDesk-private — nothing else writes there — so the
  // path shape alone is sufficient proof of ownership, even when git has already
  // forgotten about the worktree.
  if (relativePath === null) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const parts = relativePath.split(sep).filter((part) => part.length > 0);
  if (parts.length < 2) {
    return {
      allowed: false,
      ...(repoRoot !== undefined ? { repoRoot } : {}),
      worktreePath: resolvedCwd,
    };
  }

  const worktreesRoot = join(worktreesBaseRoot, parts[0]);
  return {
    allowed: true,
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    worktreeRoot: worktreesRoot,
    worktreePath: join(worktreesRoot, parts[1]),
  };
}

type ParsedJAgentDeskWorktreeInfo = Omit<JAgentDeskWorktreeInfo, "createdAt">;

function parseWorktreeList(output: string): ParsedJAgentDeskWorktreeInfo[] {
  const entries: ParsedJAgentDeskWorktreeInfo[] = [];
  let current: ParsedJAgentDeskWorktreeInfo | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current?.path) {
        entries.push(current);
      }
      current = { path: line.slice("worktree ".length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (line.trim().length === 0) {
      if (current.path) {
        entries.push(current);
      }
      current = null;
    }
  }

  if (current?.path) {
    entries.push(current);
  }

  return entries;
}

async function resolveWorktreeCreatedAtIso(worktreePath: string): Promise<string> {
  try {
    const stats = await stat(worktreePath);
    const birthtimeMs = stats.birthtimeMs;
    const createdAtMs =
      Number.isFinite(birthtimeMs) && birthtimeMs > 0 ? birthtimeMs : stats.ctimeMs;
    return new Date(createdAtMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export async function listJAgentDeskWorktrees({
  cwd,
  jagentdeskHome,
  worktreesRoot,
}: {
  cwd: string;
  jagentdeskHome?: string;
  worktreesRoot?: string;
}): Promise<JAgentDeskWorktreeInfo[]> {
  const projectWorktreesRoot = await getJAgentDeskWorktreesRoot(cwd, jagentdeskHome, worktreesRoot);
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });

  const roots = await ownershipPathVariants(projectWorktreesRoot);
  const worktrees: JAgentDeskWorktreeInfo[] = [];
  // Inspect foreign paths sequentially; a large worktree list must not consume the FS pool.
  for (const entry of parseWorktreeList(stdout)) {
    const path = await normalizePathForOwnership(entry.path);
    if (!roots.some((root) => getRelativePathInsideRoot(root, path) !== null)) continue;
    worktrees.push({ ...entry, path, createdAt: await resolveWorktreeCreatedAtIso(path) });
  }
  return worktrees;
}

export async function resolveExistingWorktreeForSlug({
  slug,
  repoRoot,
  jagentdeskHome,
  worktreesRoot,
}: ResolveExistingWorktreeForSlugOptions): Promise<WorktreeConfig | null> {
  const worktrees = await listJAgentDeskWorktrees({
    cwd: repoRoot,
    jagentdeskHome,
    worktreesRoot,
  });
  const slugSuffix = `${sep}${slug}`;
  const existingWorktree = worktrees.find((worktree) => worktree.path.endsWith(slugSuffix));
  if (!existingWorktree) {
    return null;
  }

  const { stdout } = await runGitCommand(["branch", "--show-current"], {
    cwd: existingWorktree.path,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  const branchName = stdout.trim();
  if (!branchName) {
    throw new Error(`Unable to resolve branch for existing worktree: ${existingWorktree.path}`);
  }

  return {
    branchName,
    worktreePath: existingWorktree.path,
  };
}

export interface DeleteJAgentDeskWorktreeOptions {
  cwd: string | null;
  worktreePath?: string;
  teardownCwds?: string[];
  worktreeSlug?: string;
  worktreesRoot?: string;
  jagentdeskHome?: string;
  worktreesBaseRoot?: string;
}

export async function deleteJAgentDeskWorktree({
  cwd,
  worktreePath,
  teardownCwds,
  worktreeSlug,
  worktreesRoot,
  jagentdeskHome,
  worktreesBaseRoot,
}: DeleteJAgentDeskWorktreeOptions): Promise<void> {
  if (!worktreePath && !worktreeSlug) {
    throw new Error("worktreePath or worktreeSlug is required");
  }

  // Resolve the worktrees-root. With a repo cwd we hash it the normal way; if
  // git has forgotten about the worktree we expect the caller to hand us the
  // path-derived worktreesRoot from the ownership check.
  let resolvedWorktreesRoot: string;
  if (worktreesRoot) {
    resolvedWorktreesRoot = worktreesRoot;
  } else if (cwd) {
    resolvedWorktreesRoot = await getJAgentDeskWorktreesRoot(
      cwd,
      jagentdeskHome,
      worktreesBaseRoot,
    );
  } else {
    throw new Error("cwd or worktreesRoot is required to delete a JAgentDesk worktree");
  }

  const requestedPath = worktreePath ?? join(resolvedWorktreesRoot, worktreeSlug!);
  const resolvedRequested = await normalizePathForOwnership(requestedPath);
  const ownership = await isJAgentDeskOwnedWorktreeCwd(requestedPath, {
    jagentdeskHome,
    worktreesRoot: worktreesBaseRoot,
  });
  const resolvedWorktree =
    ownership.allowed && ownership.worktreePath ? ownership.worktreePath : resolvedRequested;

  const relativeWorktreePath = await getOwnershipRelativePath(
    resolvedWorktreesRoot,
    resolvedWorktree,
  );
  if (relativeWorktreePath === null || relativeWorktreePath === "") {
    throw new Error("Refusing to delete non-JAgentDesk worktree");
  }

  if (await pathExists(resolvedWorktree)) {
    for (const teardownCwd of teardownCwds ?? [resolvedWorktree]) {
      await runWorktreeTeardownCommands({
        worktreePath: resolvedWorktree,
        teardownCwd,
      });
    }
  }

  if (cwd) {
    try {
      await runGitCommand(["worktree", "remove", resolvedWorktree, "--force"], {
        cwd,
        timeout: 120_000,
      });
    } catch {
      // `git worktree remove` fails if the admin dir is already gone (e.g. a
      // prior archive attempt removed it before the working tree could be
      // fully cleaned up), or if the repo root has moved. Fall through to the
      // rm retry loop below so the operation stays idempotent.
    }
  }

  await removeDirectoryWithRetries(resolvedWorktree);

  if (cwd) {
    try {
      await runGitCommand(["worktree", "prune"], { cwd, timeout: 30_000 });
    } catch {
      // not critical; git will prune lazily
    }
  }
}

export async function rollbackCreatedJAgentDeskWorktree(
  options: DeleteJAgentDeskWorktreeOptions,
  cause: unknown,
): Promise<never> {
  let cleanupError: unknown;
  try {
    await deleteJAgentDeskWorktree(options);
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) {
    const failure = new Error(
      `${cause instanceof Error ? cause.message : "Worktree workflow failed"}; rollback also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      { cause },
    );
    Object.assign(failure, { cleanupError });
    throw failure;
  }
  throw cause;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeDirectoryWithRetries(path: string): Promise<void> {
  if (!(await pathExists(path))) {
    return;
  }

  const delaysMs = [0, 100, 300, 700, 1500];
  let lastError: unknown = null;
  for (const delay of delaysMs) {
    if (delay > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    }
    try {
      await rm(path, { recursive: true, force: true });
      if (!(await pathExists(path))) {
        return;
      }
      lastError = new Error(`Directory still present after rm: ${path}`);
    } catch (error) {
      lastError = error;
    }
  }

  if (await pathExists(path)) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to remove worktree directory: ${path}`);
  }
}

/**
 * Create a git worktree with proper naming conventions
 */
export const createWorktree = async ({
  cwd,
  source,
  worktreeSlug,
  runSetup,
  jagentdeskHome,
  worktreesRoot,
}: CreateWorktreeOptions): Promise<CreatedWorktree> => {
  const sourcePlan = await resolveWorktreeSourcePlan({ cwd, source, desiredSlug: worktreeSlug });
  let worktreePath = join(
    await getJAgentDeskWorktreesRoot(cwd, jagentdeskHome, worktreesRoot),
    worktreeSlug,
  );
  await mkdir(dirname(worktreePath), { recursive: true });

  // Also handle worktree path collision
  let finalWorktreePath = worktreePath;
  let pathSuffix = 1;
  while (await pathExists(finalWorktreePath)) {
    finalWorktreePath = `${worktreePath}-${pathSuffix}`;
    pathSuffix++;
  }

  // Primitive owner for `git worktree add`; callers route through createWorktreeCore.
  await runGitCommand(["worktree", "add", finalWorktreePath, ...sourcePlan.addArguments], {
    cwd,
    timeout: 120_000,
  });
  worktreePath = await normalizePathForOwnership(finalWorktreePath);

  if (sourcePlan.pushRemote) {
    await configureWorktreePushRemote({
      cwd,
      branchName: sourcePlan.branchName,
      remote: sourcePlan.pushRemote,
    });
  }
  if (sourcePlan.trackingRemote) {
    await configureWorktreeTrackingRemote({
      cwd,
      branchName: sourcePlan.branchName,
      remote: sourcePlan.trackingRemote,
    });
  }

  await writeJAgentDeskWorktreeMetadata(worktreePath, {
    baseRefName: sourcePlan.metadataBaseRefName,
    ...(sourcePlan.metadataBaseRef ? { baseRef: sourcePlan.metadataBaseRef } : {}),
    ...(sourcePlan.changeRequestLookupTarget
      ? { changeRequestLookupTarget: sourcePlan.changeRequestLookupTarget }
      : {}),
  });

  await seedJAgentDeskConfigFile({ sourceCwd: cwd, targetCwd: worktreePath });

  if (runSetup) {
    await runWorktreeSetupCommands({
      worktreePath,
      branchName: sourcePlan.branchName,
      cleanupOnFailure: true,
    });
  }

  return {
    branchName: sourcePlan.branchName,
    worktreePath,
    comparisonBaseRef: sourcePlan.metadataBaseRef ?? sourcePlan.metadataBaseRefName,
  };
};

interface ResolveWorktreeSourcePlanOptions {
  cwd: string;
  source: WorktreeSource;
  desiredSlug: string;
}

interface WorktreeSourcePlan {
  branchName: string;
  // Display name and exact ref are two different facts. The name cannot round-trip to a
  // commit — "main" resolves local-first even when the worktree was cut from a fork's
  // upstream — so comparisons and actions read the ref and the UI reads the name.
  metadataBaseRefName: string;
  metadataBaseRef?: string;
  changeRequestLookupTarget?: JAgentDeskWorktreeChangeRequestHint;
  addArguments: string[];
  pushRemote?: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
  trackingRemote?: {
    name: string;
    headRef: string;
  };
}

// Restores an archived worktree on its saved branch without moving the branch: the branch
// HEAD keeps the committed work, and the recorded comparison base stays the base.
async function resolveRestoredWorktreeSourcePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "restore" }>,
): Promise<WorktreeSourcePlan> {
  await validateExistingWorktreeBranchName(cwd, source.branchName);
  await ensureLocalBranch(cwd, source.branchName);
  if (await isBranchCheckedOut(cwd, source.branchName)) {
    throw new BranchAlreadyCheckedOutError(source.branchName);
  }
  let exactBase: string | undefined;
  if (source.baseRef && isQualifiedRef(source.baseRef)) {
    try {
      exactBase = await resolveBaseBranchForWorktree(cwd, source.baseRef);
    } catch {
      // Restore the saved branch even when its comparison ref no longer exists.
    }
  }
  return {
    branchName: source.branchName,
    metadataBaseRefName: normalizeRequiredBaseBranch(source.baseRef ?? source.branchName),
    ...(exactBase ? { metadataBaseRef: exactBase } : {}),
    changeRequestLookupTarget: createJAgentDeskWorktreeChangeRequestHint({
      headRef: source.branchName,
      localBranchName: source.branchName,
    }),
    addArguments: [source.branchName],
  };
}

async function resolveRestoredWorktreeFromBasePlan(
  cwd: string,
  source: Extract<WorktreeSource, { kind: "restore-from-base" }>,
): Promise<WorktreeSourcePlan> {
  await validateExistingWorktreeBranchName(cwd, source.branchName);
  const baseRef = await resolveBaseBranchForWorktree(cwd, source.baseRef);
  const branchName = await resolveUniqueLocalBranchName(cwd, source.branchName);
  return {
    branchName,
    metadataBaseRefName: normalizeRequiredBaseBranch(source.baseRef),
    metadataBaseRef: baseRef,
    addArguments: ["-b", branchName, "--no-track", baseRef],
  };
}

async function resolveWorktreeSourcePlan({
  cwd,
  source,
  desiredSlug,
}: ResolveWorktreeSourcePlanOptions): Promise<WorktreeSourcePlan> {
  switch (source.kind) {
    case "branch-off": {
      const branchName = source.branchName;
      validateWorktreeBranchName(branchName);
      const normalizedBaseBranch = normalizeRequiredBaseBranch(source.baseBranch);
      const resolvedBaseBranch = await resolveBaseBranchForWorktree(cwd, source.baseBranch);
      const branchExists = await localBranchExists(cwd, branchName);
      const base = branchExists ? branchName : resolvedBaseBranch;
      await refreshRemoteTrackingBaseRef(cwd, base);
      const candidateBranch = branchExists ? desiredSlug : branchName;
      const newBranchName = await resolveUniqueLocalBranchName(cwd, candidateBranch);

      return {
        branchName: newBranchName,
        metadataBaseRefName: normalizedBaseBranch,
        metadataBaseRef: resolvedBaseBranch,
        addArguments: ["-b", newBranchName, "--no-track", base],
      };
    }
    case "restore":
      return resolveRestoredWorktreeSourcePlan(cwd, source);
    case "restore-from-base":
      return resolveRestoredWorktreeFromBasePlan(cwd, source);
    case "checkout-branch": {
      await validateExistingWorktreeBranchName(cwd, source.branchName);
      await ensureLocalBranch(cwd, source.branchName);
      const baseRef = await resolveCheckoutBranchBaseRef(cwd, source.branchName);
      if (await isBranchCheckedOut(cwd, source.branchName)) {
        throw new BranchAlreadyCheckedOutError(source.branchName);
      }

      return {
        branchName: source.branchName,
        metadataBaseRefName: baseRef,
        changeRequestLookupTarget: createJAgentDeskWorktreeChangeRequestHint({
          headRef: source.branchName,
          localBranchName: source.branchName,
        }),
        addArguments: [source.branchName],
      };
    }
    case "checkout-change-request":
    case "checkout-github-pr": {
      const localBranchCandidate = source.localBranchName ?? source.headRef;
      await validateExistingWorktreeBranchName(cwd, localBranchCandidate);
      const localBranchName = await resolveUniqueLocalBranchName(cwd, localBranchCandidate);
      const normalizedBaseRefName = normalizeRequiredBaseBranch(source.baseRefName);
      const changeRequestNumber =
        source.kind === "checkout-github-pr" ? source.githubPrNumber : source.changeRequestNumber;
      await fetchWorktreeCheckoutRefs({
        cwd,
        localBranchName,
        checkoutRefs: source.checkoutRefs ?? [
          { remoteName: "origin", remoteRef: `refs/pull/${changeRequestNumber}/head` },
        ],
      });
      const shouldTrackOriginHead = source.trackOriginHead === true;
      const trackingRemote = shouldTrackOriginHead
        ? await tryFetchWorktreeTrackingRemote({
            cwd,
            remoteName: "origin",
            headRef: source.headRef,
          })
        : undefined;
      const remotePlan: Pick<WorktreeSourcePlan, "pushRemote" | "trackingRemote"> = {};
      if (source.pushRemoteUrl) {
        const remoteName = `jagentdesk-pr-${changeRequestNumber}`;
        remotePlan.pushRemote = {
          name: remoteName,
          url: source.pushRemoteUrl,
          headRef: source.headRef,
          track: true,
        };
      } else if (shouldTrackOriginHead && localBranchName !== source.headRef) {
        const originUrl = await getWorktreeRemotePushUrl(cwd, "origin");
        if (originUrl) {
          remotePlan.pushRemote = {
            name: `jagentdesk-pr-${changeRequestNumber}`,
            url: originUrl,
            headRef: source.headRef,
            track: false,
          };
        }
      }
      if (trackingRemote) {
        remotePlan.trackingRemote = trackingRemote;
      }

      return {
        branchName: localBranchName,
        metadataBaseRefName: normalizedBaseRefName,
        changeRequestLookupTarget: createJAgentDeskWorktreeChangeRequestHint({
          headRef: source.headRef,
          ...(source.headRepositoryOwner
            ? { headRepositoryOwner: source.headRepositoryOwner }
            : {}),
          changeRequestNumber,
          localBranchName,
        }),
        addArguments: [localBranchName],
        ...remotePlan,
      };
    }
  }
}

async function configureWorktreePushRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    url: string;
    headRef: string;
    track: boolean;
  };
}): Promise<void> {
  await runGitCommand(["config", `remote.${options.remote.name}.url`, options.remote.url], {
    cwd: options.cwd,
  });
  await runGitCommand(
    ["config", `remote.${options.remote.name}.push`, `HEAD:refs/heads/${options.remote.headRef}`],
    { cwd: options.cwd },
  );
  await runGitCommand(["config", `branch.${options.branchName}.pushRemote`, options.remote.name], {
    cwd: options.cwd,
  });
  if (!options.remote.track) {
    return;
  }
  await runGitCommand(
    [
      "config",
      `remote.${options.remote.name}.fetch`,
      `+refs/heads/${options.remote.headRef}:refs/remotes/${options.remote.name}/${options.remote.headRef}`,
    ],
    { cwd: options.cwd },
  );
  const trackingRemote = await tryFetchWorktreeTrackingRemote({
    cwd: options.cwd,
    remoteName: options.remote.name,
    headRef: options.remote.headRef,
  });
  if (trackingRemote) {
    await configureWorktreeTrackingRemote({
      cwd: options.cwd,
      branchName: options.branchName,
      remote: trackingRemote,
    });
  }
}

async function fetchWorktreeCheckoutRefs(options: {
  cwd: string;
  localBranchName: string;
  checkoutRefs: WorktreeCheckoutRef[];
}): Promise<void> {
  let lastResult:
    | Awaited<ReturnType<typeof runGitCommand>>
    | { stderr: string; stdout: string; exitCode: number | null }
    | null = null;
  for (const checkoutRef of options.checkoutRefs) {
    lastResult = await runGitCommand(
      [
        "fetch",
        checkoutRef.remoteName ?? "origin",
        `+${checkoutRef.remoteRef}:refs/heads/${options.localBranchName}`,
        "--force",
      ],
      {
        cwd: options.cwd,
        timeout: 120_000,
        acceptExitCodes: [0, 1, 128],
      },
    );
    if (lastResult.exitCode === 0) {
      return;
    }
  }
  const attemptedRefs = options.checkoutRefs
    .map((checkoutRef) => `${checkoutRef.remoteName ?? "origin"} ${checkoutRef.remoteRef}`)
    .join(", ");
  throw new Error(
    `Unable to fetch change request refs for worktree branch ${options.localBranchName}: ${attemptedRefs}${lastResult?.stderr ? `\n${lastResult.stderr}` : ""}`,
  );
}

async function tryFetchWorktreeTrackingRemote(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<{ name: string; headRef: string } | undefined> {
  const result = await runGitCommand(
    [
      "fetch",
      options.remoteName,
      `+refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`,
    ],
    {
      cwd: options.cwd,
      timeout: 120_000,
      acceptExitCodes: [0, 1, 128],
    },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  await ensureRemoteFetchesBranch(options);
  return { name: options.remoteName, headRef: options.headRef };
}

async function ensureRemoteFetchesBranch(options: {
  cwd: string;
  remoteName: string;
  headRef: string;
}): Promise<void> {
  const configKey = `remote.${options.remoteName}.fetch`;
  const exactRefspec = `refs/heads/${options.headRef}:refs/remotes/${options.remoteName}/${options.headRef}`;
  const wildcardRefspec = `refs/heads/*:refs/remotes/${options.remoteName}/*`;
  const { stdout } = await runGitCommand(["config", "--get-all", configKey], {
    cwd: options.cwd,
    acceptExitCodes: [0, 1],
  });
  const alreadyTracked = stdout
    .split("\n")
    .map((refspec) => refspec.trim().replace(/^\+/, ""))
    .some((refspec) => refspec === exactRefspec || refspec === wildcardRefspec);
  if (alreadyTracked) {
    return;
  }
  await runGitCommand(["config", "--add", configKey, `+${exactRefspec}`], { cwd: options.cwd });
}

async function getWorktreeRemotePushUrl(
  cwd: string,
  remoteName: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await runGitCommand(["remote", "get-url", "--push", remoteName], {
      cwd,
    });
    const url = stdout.trim();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

async function configureWorktreeTrackingRemote(options: {
  cwd: string;
  branchName: string;
  remote: {
    name: string;
    headRef: string;
  };
}): Promise<void> {
  await runGitCommand(
    [
      "branch",
      "--set-upstream-to",
      `${options.remote.name}/${options.remote.headRef}`,
      options.branchName,
    ],
    { cwd: options.cwd },
  );
}

function validateWorktreeBranchName(branchName: string): void {
  const validation = validateBranchSlug(branchName);
  if (!validation.valid) {
    throw new Error(`Invalid branch name: ${validation.error}`);
  }
}

async function validateExistingWorktreeBranchName(cwd: string, branchName: string): Promise<void> {
  const result = await runGitCommand(["check-ref-format", "--branch", branchName], {
    cwd,
    timeout: 30_000,
    acceptExitCodes: [0, 1, 128],
  });
  if (result.exitCode !== 0) {
    throw new InvalidGitBranchNameError(branchName);
  }
}

function normalizeRequiredBaseBranch(baseBranch: string): string {
  const normalizedBaseBranch = normalizeBaseRefName(baseBranch);
  if (!normalizedBaseBranch) {
    throw new Error("Base branch is required when creating a JAgentDesk worktree");
  }
  if (normalizedBaseBranch === "HEAD") {
    throw new Error("Base branch cannot be HEAD when creating a JAgentDesk worktree");
  }
  return normalizedBaseBranch;
}

// The checked-out branch itself isn't a base to diff against — resolve the
// repository's default branch so the diff panel has a real comparison target.
// If the default branch can't be determined (no origin/HEAD, no local
// main/master — e.g. a local-only repo based on "develop"), fall back to
// whichever branch is currently checked out in the main repo, since that's
// almost always the branch this one was intended to be compared against.
async function resolveCheckoutBranchBaseRef(cwd: string, branchName: string): Promise<string> {
  const defaultBranch = await resolveRepositoryDefaultBranch(cwd);
  if (defaultBranch) {
    return defaultBranch;
  }
  const currentBranch = await getCurrentBranch(cwd);
  return currentBranch && currentBranch !== branchName ? currentBranch : branchName;
}

async function resolveBaseBranchForWorktree(
  cwd: string,
  requestedBaseBranch: string,
): Promise<string> {
  const requested = requestedBaseBranch.trim();
  const normalized = normalizeRequiredBaseBranch(requested);
  let exactRef: string | null = null;
  if (isQualifiedRef(requested)) {
    exactRef = requested;
  } else if (requested.startsWith("origin/")) {
    exactRef = `refs/remotes/${requested}`;
  }

  if (exactRef) {
    try {
      await runGitCommand(["rev-parse", "--verify", exactRef], { cwd });
      return exactRef;
    } catch {
      throw new Error(`Base branch not found: ${exactRef}`);
    }
  }

  const candidates = [`refs/heads/${requested}`, `refs/remotes/origin/${requested}`, requested];
  for (const candidate of candidates) {
    try {
      await runGitCommand(["rev-parse", "--verify", candidate], { cwd });
      return candidate;
    } catch {
      // Try the next unambiguous local, remote, or legacy ref candidate.
    }
  }
  throw new Error(`Base branch not found: ${normalized}`);
}

// Clients give up on a create request after 60s. A remote that accepts the connection and never
// answers (a VPN-only host while off the VPN) must fall back to the cached ref well before that.
const REMOTE_BASE_REFRESH_TIMEOUT_MS = 15_000;

// A remote-tracking base is only as fresh as the last fetch, and the background fetch only runs
// while a workspace of the repository is observed. Refresh the one base branch so the new branch
// starts at the remote tip; when the fetch fails (offline, auth) the cached ref is still usable.
async function refreshRemoteTrackingBaseRef(cwd: string, baseRef: string): Promise<void> {
  if (!baseRef.startsWith("refs/remotes/")) {
    return;
  }
  try {
    // Remote names may contain slashes, so the owning remote is looked up rather than parsed.
    const { stdout } = await runGitCommand(["remote"], { cwd });
    const remoteName = stdout
      .split("\n")
      .map((name) => name.trim())
      .find((name) => name.length > 0 && baseRef.startsWith(`refs/remotes/${name}/`));
    if (!remoteName) {
      return;
    }
    const remoteBranch = baseRef.slice(`refs/remotes/${remoteName}/`.length);
    // No refspec is added to remote.<name>.fetch: one left behind breaks later fetches once the
    // branch is deleted on the remote.
    await runGitCommand(["fetch", remoteName, `+refs/heads/${remoteBranch}:${baseRef}`], {
      cwd,
      envOverlay: { GIT_TERMINAL_PROMPT: "0" },
      timeout: REMOTE_BASE_REFRESH_TIMEOUT_MS,
      acceptExitCodes: [0, 1, 128],
    });
  } catch {
    // The fetch timed out; branch from the cached ref.
  }
}

async function ensureLocalBranch(cwd: string, branchName: string): Promise<void> {
  if (await localBranchExists(cwd, branchName)) {
    return;
  }
  try {
    await runGitCommand(["fetch", "origin", `${branchName}:${branchName}`], {
      cwd,
      timeout: 120_000,
    });
  } catch {
    throw new UnknownBranchError({ branchName, cwd });
  }
}

async function localBranchExists(cwd: string, branchName: string): Promise<boolean> {
  try {
    await runGitCommand(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveUniqueLocalBranchName(cwd: string, candidateBranch: string): Promise<string> {
  const { stdout } = await runGitCommand(
    ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"],
    { cwd, envOverlay: READ_ONLY_GIT_ENV },
  );
  const existingBranches = new Set(stdout.trim().split("\n").filter(Boolean));
  const candidateSegments = candidateBranch.split("/");
  const segments = [...candidateSegments];
  let suffix = 1;
  while (true) {
    const branchName = segments.join("/");
    const parentConflict = segments.findIndex((_, index) =>
      existingBranches.has(segments.slice(0, index + 1).join("/")),
    );
    const childConflict = [...existingBranches].some((branch) =>
      branch.startsWith(`${branchName}/`),
    );
    if (parentConflict === -1 && !childConflict) {
      return branchName;
    }
    // Git refs form a namespace: a branch cannot also be another branch's
    // parent directory. Rename the conflicting segment, preserving the rest.
    const conflictIndex = parentConflict === -1 ? segments.length - 1 : parentConflict;
    segments[conflictIndex] = `${candidateSegments[conflictIndex]}-${suffix++}`;
  }
}

async function isBranchCheckedOut(cwd: string, branchName: string): Promise<boolean> {
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain"], {
    cwd,
    envOverlay: READ_ONLY_GIT_ENV,
  });
  return parseWorktreeList(stdout).some((entry) => entry.branchName === branchName);
}
