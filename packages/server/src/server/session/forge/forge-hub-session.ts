import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  ForgeConnection,
  ForgeRepo,
  ForgeChangeRequestSummary,
  ForgeChangeRequestFile,
  ForgeBranch,
  ForgeCommit,
  ForgeTreeEntry,
  ForgePipelineRun,
  ForgePipelineDetail,
  ForgePipelineJob,
  ForgeReviewAction,
  ForgeMergeMethod,
  ForgeArtifact,
  ForgeRelease,
  ForgeReleaseAsset,
  ForgeTag,
  ForgeIssue,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@jagentdesk/protocol/messages";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { execCommand, spawnProcess } from "../../../utils/spawn.js";
import { detectCliStatus, installCli } from "./forge-cli-installer.js";
import { ForgeDeviceLogin } from "./forge-device-login.js";
import type { SecretStore } from "../../database/secret-store.js";

/**
 * Forge Hub — Milestone A (spec 19 / ADR-0015). Repo-scoped remote-forge reads that
 * are NOT workspace-attached (they address repos by forge+owner+name, never a cwd),
 * so they live here rather than in the cwd-scoped CheckoutSession. Milestone A ships
 * GitHub via the `gh` CLI; GitLab (`glab`) and a Bitbucket REST adapter follow.
 *
 * Token connections (method "token", for Bitbucket / self-hosted without a CLI) keep
 * their secret in the daemon SecretStore (AES-256-GCM) and never cross the wire.
 */

type ForgeHubInbound = Extract<
  SessionInboundMessage,
  {
    type:
      | "forge.connection.list.request"
      | "forge.connection.add.request"
      | "forge.connection.remove.request"
      | "forge.repo.list.request"
      | "forge.change_request.list.request"
      | "forge.change_request.files.request"
      | "forge.branch.list.request"
      | "forge.commit.list.request"
      | "forge.commit.compare.request"
      | "forge.tree.list.request"
      | "forge.file.get.request"
      | "forge.change_request.review.request"
      | "forge.change_request.merge.request"
      | "forge.pipeline.list.request"
      | "forge.pipeline.get.request"
      | "forge.job.log.request"
      | "forge.pipeline.rerun.request"
      | "forge.pipeline.cancel.request"
      | "forge.job.play.request"
      | "forge.change_request.set_auto_merge.request"
      | "forge.artifact.list.request"
      | "forge.artifact.download.request"
      | "forge.release.list.request"
      | "forge.tag.list.request"
      | "forge.issue.list.request"
      | "forge.issue.create.request"
      | "forge.issue.comment.request"
      | "forge.issue.close.request"
      | "forge.change_request.create.request"
      | "forge.change_request.close.request"
      | "forge.release.create.request"
      | "forge.release.get.request"
      | "forge.cli.status.request"
      | "forge.cli.install.request"
      | "forge.connection.login.request"
      | "forge.connection.login.cancel.request";
  }
>;

export interface ForgeHubSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  /** Daemon secret store for method:"token" connections (id → token). */
  secretStore: SecretStore;
  /**
   * Directory the token secret store lives in. Token-connection metadata is
   * persisted alongside the secrets as `connections.json` so token connections
   * (Bitbucket / self-hosted) survive restarts and can be enumerated. When
   * omitted (tests with a MemorySecretStore), token connections are not
   * persisted and do not enumerate.
   */
  secretStoreDir?: string;
  logger?: { warn?: (msg: string, meta?: unknown) => void };
}

const GH_TIMEOUT_MS = 20_000;
const BB_TIMEOUT_MS = 20_000;
const SECRET_PREFIX = "forge.connection.token:";
const BITBUCKET_API = "https://api.bitbucket.org/2.0";
/** Files larger than this are returned as { content: null, truncated: true }. */
const MAX_FILE_BYTES = 512 * 1024;

// ---- gh JSON shapes (loose; we only read what we map) --------------------------
const GhRepoSchema = z.object({
  nameWithOwner: z.string(),
  description: z.string().nullable().optional(),
  defaultBranchRef: z.object({ name: z.string() }).nullable().optional(),
  visibility: z.string().optional(),
  isPrivate: z.boolean().optional(),
  updatedAt: z.string().optional(),
  url: z.string(),
});
const GhPrSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean().optional(),
  headRefName: z.string().optional(),
  baseRefName: z.string().optional(),
  labels: z.array(z.object({ name: z.string() })).optional(),
  updatedAt: z.string().optional(),
  author: z.object({ login: z.string() }).nullable().optional(),
  reviewDecision: z.string().nullable().optional(),
  statusCheckRollup: z
    .array(
      z.object({ status: z.string().optional(), conclusion: z.string().nullable().optional() }),
    )
    .nullable()
    .optional(),
});
const GhFileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
});

function isoToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function mapVisibility(
  v: string | undefined,
  isPrivate: boolean | undefined,
): ForgeRepo["visibility"] {
  const s = (v ?? (isPrivate ? "private" : "")).toLowerCase();
  if (s === "public" || s === "private" || s === "internal") return s;
  return "unknown";
}

/** Percent-encode each path segment while keeping "/" separators intact. */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** Shape returned by every getFile*() (before the requestId is attached). */
type ForgeFileResult = {
  path: string;
  content: string | null;
  isBinary: boolean;
  size: number | null;
  truncated: boolean;
};

/**
 * Turn raw file bytes into a ForgeFileResult: over the size cap → truncated; a NUL
 * byte → binary; otherwise a utf8 string. `reportedSize` is the forge-reported size
 * when known (github/gitlab), else the byte length is used (bitbucket raw read).
 */
function decodeForgeFile(path: string, buf: Buffer, reportedSize?: number | null): ForgeFileResult {
  const size = reportedSize ?? buf.byteLength;
  if (buf.byteLength > MAX_FILE_BYTES) {
    return { path, content: null, isBinary: false, size, truncated: true };
  }
  if (buf.includes(0)) {
    return { path, content: null, isBinary: true, size, truncated: false };
  }
  return { path, content: buf.toString("utf8"), isBinary: false, size, truncated: false };
}

function rollupToChecks(
  rollup: z.infer<typeof GhPrSchema>["statusCheckRollup"],
): ForgeChangeRequestSummary["checksStatus"] {
  if (!rollup || rollup.length === 0) return "none";
  let pending = false;
  for (const c of rollup) {
    const concl = (c.conclusion ?? "").toLowerCase();
    const status = (c.status ?? "").toLowerCase();
    if (concl === "failure" || concl === "cancelled" || concl === "timed_out") return "failure";
    if (status !== "completed" && !concl) pending = true;
  }
  return pending ? "pending" : "success";
}

function prState(state: string, isDraft: boolean | undefined): ForgeChangeRequestSummary["state"] {
  const s = state.toLowerCase();
  if (s === "merged") return "merged";
  if (s === "closed") return "closed";
  return isDraft ? "draft" : "open";
}

function mapReviewDecision(
  d: string | null | undefined,
): ForgeChangeRequestSummary["reviewDecision"] {
  const s = (d ?? "").toUpperCase();
  if (s === "APPROVED") return "approved";
  if (s === "CHANGES_REQUESTED") return "changes_requested";
  if (s === "REVIEW_REQUIRED") return "pending";
  return null;
}

function fileStatus(s: string): ForgeChangeRequestFile["status"] {
  const v = s.toLowerCase();
  if (v === "added") return "added";
  if (v === "removed") return "removed";
  if (v === "renamed") return "renamed";
  return "modified";
}

// ---- glab (GitLab REST v4) JSON shapes (loose; we only read what we map) --------
const GlRepoSchema = z.object({
  path_with_namespace: z.string(),
  description: z.string().nullable().optional(),
  default_branch: z.string().nullable().optional(),
  visibility: z.string().optional(),
  last_activity_at: z.string().optional(),
  web_url: z.string(),
});
const GlMrSchema = z.object({
  iid: z.number(),
  title: z.string(),
  web_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  labels: z.array(z.string()).optional(),
  updated_at: z.string().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
});
const GlChangeSchema = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean().optional(),
  deleted_file: z.boolean().optional(),
  renamed_file: z.boolean().optional(),
  diff: z.string().optional(),
});
const GlBranchSchema = z.object({
  name: z.string(),
  default: z.boolean().optional(),
  protected: z.boolean().optional(),
  commit: z.object({ id: z.string() }).nullable().optional(),
});
const GlCommitSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  message: z.string().optional(),
  author_name: z.string().nullable().optional(),
  authored_date: z.string().optional(),
});
const GlPipelineSchema = z.object({
  id: z.number(),
  ref: z.string().nullable().optional(),
  sha: z.string().nullable().optional(),
  status: z.string().optional(),
  source: z.string().nullable().optional(),
  web_url: z.string(),
  created_at: z.string().optional(),
});
const GlJobSchema = z.object({
  id: z.number(),
  name: z.string(),
  stage: z.string(),
  status: z.string().optional(),
  duration: z.number().nullable().optional(),
  web_url: z.string().nullable().optional(),
});

/** URL-encoded GitLab project id ("owner/name"). */
function glProjectId(owner: string, name: string): string {
  return encodeURIComponent(`${owner}/${name}`);
}

/** Count added/removed lines in a GitLab unified diff body (header lines excluded). */
function countDiffLines(diff: string | undefined): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/** Map a GitLab MR/compare change entry onto the neutral file shape. */
function glChangeToFile(c: z.infer<typeof GlChangeSchema>): ForgeChangeRequestFile {
  const status: ForgeChangeRequestFile["status"] = c.new_file
    ? "added"
    : c.deleted_file
      ? "removed"
      : c.renamed_file
        ? "renamed"
        : "modified";
  const { additions, deletions } = countDiffLines(c.diff);
  return {
    path: c.new_path,
    previousPath: c.renamed_file ? c.old_path : null,
    status,
    additions,
    deletions,
    patch: c.diff ?? null,
  };
}

/** Map a GitLab commit onto the neutral commit shape (GitLab commits carry no login). */
function glCommit(c: z.infer<typeof GlCommitSchema>): ForgeCommit {
  return {
    sha: c.id,
    subject: c.title ?? c.message?.split("\n", 1)[0] ?? "",
    authorLogin: null,
    authorName: c.author_name ?? null,
    committedAt_ms: isoToMs(c.authored_date),
  };
}

function glMrState(state: string, draft: boolean): ForgeChangeRequestSummary["state"] {
  const s = state.toLowerCase();
  if (s === "merged") return "merged";
  if (s === "closed" || s === "locked") return "closed";
  return draft ? "draft" : "open";
}

/** Normalize a GitLab pipeline/job status onto the neutral pipeline status enum. */
function glPipelineStatus(status: string | undefined): ForgePipelineRun["status"] {
  switch ((status ?? "").toLowerCase()) {
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "pending":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
      return "pending";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "skipped":
      return "skipped";
    case "manual":
      return "manual";
    case "created":
      return "created";
    default:
      return "unknown";
  }
}

/** Aggregate job statuses into one stage/pipeline status
 *  (failed > running > pending > manual > canceled > skipped > success). */
function aggregateGlStatus(statuses: ForgePipelineRun["status"][]): ForgePipelineRun["status"] {
  const precedence: ForgePipelineRun["status"][] = [
    "failed",
    "running",
    "pending",
    "manual",
    "canceled",
    "skipped",
    "success",
  ];
  for (const s of precedence) if (statuses.includes(s)) return s;
  return statuses[0] ?? "unknown";
}

// ---- token-connection index (persisted next to the secret store) ---------------
const TokenConnectionMetaSchema = z.object({
  id: z.string(),
  forge: z.string(),
  host: z.string(),
  method: z.literal("token"),
});
const TokenConnectionIndexSchema = z.array(TokenConnectionMetaSchema);
type TokenConnectionMeta = z.infer<typeof TokenConnectionMetaSchema>;

// ---- Bitbucket Cloud REST 2.0 shapes (loose; we only read what we map) ----------
// Bitbucket has no first-party CLI, so this provider talks REST directly with the
// daemon-stored token. We default to `Authorization: Bearer <token>` (Bitbucket
// access tokens / OAuth bearer). App-password auth would instead use HTTP Basic
// (`user:app_password`); we cannot e2e-verify that path here, so Bearer is the
// default and the only mode wired.
const BbRepoSchema = z.object({
  full_name: z.string(),
  description: z.string().nullable().optional(),
  is_private: z.boolean().optional(),
  updated_on: z.string().optional(),
  mainbranch: z.object({ name: z.string() }).nullable().optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});
const BbPrSchema = z.object({
  id: z.number(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  source: z.object({ branch: z.object({ name: z.string() }).nullable().optional() }).optional(),
  destination: z
    .object({ branch: z.object({ name: z.string() }).nullable().optional() })
    .optional(),
  author: z
    .object({ nickname: z.string().optional(), display_name: z.string().optional() })
    .nullable()
    .optional(),
  updated_on: z.string().optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});
const BbDiffstatSchema = z.object({
  status: z.string(),
  lines_added: z.number().optional(),
  lines_removed: z.number().optional(),
  old: z.object({ path: z.string() }).nullable().optional(),
  new: z.object({ path: z.string() }).nullable().optional(),
});
const BbBranchSchema = z.object({
  name: z.string(),
  target: z.object({ hash: z.string() }).nullable().optional(),
});
const BbCommitSchema = z.object({
  hash: z.string(),
  message: z.string().optional(),
  date: z.string().optional(),
  author: z
    .object({
      raw: z.string().optional(),
      user: z.object({ nickname: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
});
const BbPipelineSchema = z.object({
  uuid: z.string(),
  build_number: z.number().optional(),
  state: z
    .object({
      name: z.string().optional(),
      result: z.object({ name: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  target: z
    .object({
      ref_name: z.string().nullable().optional(),
      commit: z.object({ hash: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  trigger: z.object({ name: z.string().optional() }).nullable().optional(),
  created_on: z.string().optional(),
});
const BbStepSchema = z.object({
  uuid: z.string(),
  name: z.string().optional(),
  state: z
    .object({
      name: z.string().optional(),
      result: z.object({ name: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  started_on: z.string().nullable().optional(),
  completed_on: z.string().nullable().optional(),
});
const BbTagSchema = z.object({
  name: z.string(),
  target: z.object({ hash: z.string() }).nullable().optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});
const BbIssueSchema = z.object({
  id: z.number(),
  title: z.string(),
  state: z.string(),
  reporter: z.object({ nickname: z.string().optional() }).nullable().optional(),
  updated_on: z.string().optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});
function bbPaged<T>(item: z.ZodType<T>) {
  return z.object({ values: z.array(item).optional().default([]) });
}

/** Map a Bitbucket PR state (OPEN|MERGED|DECLINED|SUPERSEDED) onto the neutral enum. */
function bbPrState(state: string, draft: boolean | undefined): ForgeChangeRequestSummary["state"] {
  const s = state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "DECLINED" || s === "SUPERSEDED") return "closed";
  return draft ? "draft" : "open";
}

/** Map a Bitbucket diffstat status onto the neutral file status. */
function bbFileStatus(s: string): ForgeChangeRequestFile["status"] {
  const v = s.toLowerCase();
  if (v === "added") return "added";
  if (v === "removed") return "removed";
  if (v === "renamed") return "renamed";
  return "modified";
}

/** Map a Bitbucket pipeline/step state onto the neutral pipeline status enum. */
function bbPipelineStatus(
  name: string | undefined,
  result: string | undefined,
): ForgePipelineRun["status"] {
  const s = (name ?? "").toUpperCase();
  if (s === "COMPLETED") {
    switch ((result ?? "").toUpperCase()) {
      case "SUCCESSFUL":
        return "success";
      case "FAILED":
      case "ERROR":
        return "failed";
      case "STOPPED":
        return "canceled";
      default:
        return "unknown";
    }
  }
  if (s === "IN_PROGRESS" || s === "RUNNING") return "running";
  if (s === "PENDING") return "pending";
  if (s === "PAUSED") return "manual";
  if (s === "HALTED" || s === "STOPPED") return "canceled";
  return "unknown";
}

/** Map a Bitbucket issue state onto the neutral open/closed issue enum. */
function bbIssueState(state: string): ForgeIssue["state"] {
  const s = state.toLowerCase();
  // Bitbucket tracker states: new · open · on hold · resolved · closed · invalid · duplicate · wontfix.
  return s === "new" || s === "open" || s === "on hold" ? "open" : "closed";
}

/** Map a Bitbucket commit onto the neutral commit shape. */
function bbCommit(c: z.infer<typeof BbCommitSchema>): ForgeCommit {
  return {
    sha: c.hash,
    subject: (c.message ?? "").split("\n", 1)[0] ?? "",
    authorLogin: c.author?.user?.nickname ?? null,
    authorName: c.author?.raw ?? null,
    committedAt_ms: isoToMs(c.date),
  };
}

/** Bitbucket pipelines have no API-returned html link; build the results page URL. */
function bbPipelineUrl(owner: string, name: string, buildNumber: number): string {
  return `https://bitbucket.org/${owner}/${name}/pipelines/results/${buildNumber}`;
}

/** Parse a git-style unified diff into per-file neutral file entries (best-effort).
 *  Bitbucket compare/PR diffs come as one raw blob; split on the `diff --git` headers. */
function parseDiffToFiles(diff: string | null): ForgeChangeRequestFile[] {
  if (!diff) return [];
  const files: ForgeChangeRequestFile[] = [];
  for (const chunk of diff.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const body = `diff --git ${chunk}`;
    const m = chunk.match(/^a\/(.+?) b\/(.+?)\n/);
    const oldPath = m?.[1];
    const newPath = m?.[2] ?? oldPath ?? "";
    let status: ForgeChangeRequestFile["status"] = "modified";
    if (/^new file mode/m.test(chunk)) status = "added";
    else if (/^deleted file mode/m.test(chunk)) status = "removed";
    else if (/^rename from /m.test(chunk)) status = "renamed";
    const { additions, deletions } = countDiffLines(body);
    files.push({
      path: newPath,
      previousPath: status === "renamed" ? (oldPath ?? null) : null,
      status,
      additions,
      deletions,
      patch: body,
    });
  }
  return files;
}

/** Index per-file patch bodies from a raw unified diff, keyed by the new-side path. */
function splitUnifiedDiff(diff: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!diff) return out;
  for (const chunk of diff.split(/^diff --git /m)) {
    if (!chunk.trim()) continue;
    const m = chunk.match(/^a\/(.+?) b\/(.+?)\n/);
    const newPath = m?.[2];
    if (newPath) out.set(newPath, `diff --git ${chunk}`);
  }
  return out;
}

export class ForgeHubService {
  constructor(
    private readonly secretStore: SecretStore,
    /** Directory the secret store lives in; token-connection index is written here. */
    private readonly secretStoreDir?: string,
  ) {}

  private async ghPath(): Promise<string | null> {
    return findExecutable("gh");
  }

  /** Run `gh` and return parsed JSON stdout, or null on any failure (execCommand
   *  rejects on a non-zero exit, so a resolved result means success). */
  private async ghJson<T>(args: string[], schema: z.ZodType<T>): Promise<T | null> {
    const gh = await this.ghPath();
    if (!gh) return null;
    try {
      const res = await execCommand(gh, args, { timeout: GH_TIMEOUT_MS });
      return schema.parse(JSON.parse(res.stdout));
    } catch {
      return null;
    }
  }

  async listConnections(): Promise<ForgeConnection[]> {
    const out: ForgeConnection[] = [];
    // GitHub via gh: a connection exists when `gh api user` resolves a login.
    // `-q .login` prints a bare login (not JSON), so read stdout directly.
    let login: string | null = null;
    const gh = await this.ghPath();
    if (gh) {
      try {
        const res = await execCommand(gh, ["api", "user", "-q", ".login"], {
          timeout: GH_TIMEOUT_MS,
        });
        if (res.stdout.trim()) login = res.stdout.trim();
      } catch {
        /* gh missing or not authenticated */
      }
    }
    if (login) {
      out.push({
        id: "github:github.com",
        forge: "github",
        host: "github.com",
        account: login,
        method: "cli",
        authState: "authenticated",
      });
    }
    // GitLab via glab: a connection exists when `glab api user` resolves a username.
    let glUsername: string | null = null;
    const glab = await this.glabPath();
    if (glab) {
      try {
        const res = await execCommand(glab, ["api", "user"], { timeout: GH_TIMEOUT_MS });
        const parsed = z
          .object({ username: z.string().optional() })
          .safeParse(JSON.parse(res.stdout));
        if (parsed.success && parsed.data.username) glUsername = parsed.data.username;
      } catch {
        /* glab missing or not authenticated */
      }
    }
    if (glUsername) {
      out.push({
        id: "gitlab:gitlab.com",
        forge: "gitlab",
        host: "gitlab.com",
        account: glUsername,
        method: "cli",
        authState: "authenticated",
      });
    }
    // Token connections persisted in the secret store.
    for (const meta of await this.listTokenConnectionMeta()) {
      out.push(meta);
    }
    return out;
  }

  // ---- token-connection index -------------------------------------------------
  // SecretStore has no list(), so token connections (Bitbucket / self-hosted without
  // a CLI) are enumerated from a small JSON index written next to the secrets. Only
  // keyless metadata is stored (never the token); the token stays in the SecretStore.

  private connectionsPath(): string | null {
    return this.secretStoreDir ? path.join(this.secretStoreDir, "connections.json") : null;
  }

  private async readConnectionIndex(): Promise<TokenConnectionMeta[]> {
    const file = this.connectionsPath();
    if (!file) return [];
    try {
      const parsed = TokenConnectionIndexSchema.safeParse(
        JSON.parse(await fs.readFile(file, "utf8")),
      );
      return parsed.success ? parsed.data : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      return [];
    }
  }

  /** Atomically replace the token-connection index (temp file + rename). */
  private async writeConnectionIndex(metas: TokenConnectionMeta[]): Promise<void> {
    const file = this.connectionsPath();
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(metas, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  // Enumerate persisted token connections and probe each for account + auth state.
  // Bitbucket probes `GET /2.0/user`; other token forges have no cheap probe here, so
  // their state reflects only whether a secret is present.
  private async listTokenConnectionMeta(): Promise<ForgeConnection[]> {
    const metas = await this.readConnectionIndex();
    return Promise.all(
      metas.map(async (m): Promise<ForgeConnection> => {
        const token = await this.secretStore.get(`${SECRET_PREFIX}${m.id}`);
        if (m.forge === "bitbucket") {
          const account = token ? await this.bitbucketAccount() : null;
          return {
            id: m.id,
            forge: m.forge,
            host: m.host,
            account,
            method: "token",
            // Token missing, or present but the /user probe failed → "error".
            authState: token && account ? "authenticated" : "error",
          };
        }
        return {
          id: m.id,
          forge: m.forge,
          host: m.host,
          account: null,
          method: "token",
          authState: token ? "authenticated" : "error",
        };
      }),
    );
  }

  /**
   * Run a CLI that reads a secret from stdin (gh/glab token login), feeding the
   * token in without it ever touching argv (which would leak via the process
   * table). Rejects with the CLI's stderr on non-zero exit.
   */
  private async runCliWithStdin(bin: string, args: string[], input: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawnProcess(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.trim() || `exited with code ${code}`)),
      );
      child.stdin?.write(input);
      child.stdin?.end();
    });
  }

  async addConnection(input: {
    forge: string;
    host?: string;
    method: "cli" | "token";
    token?: string;
  }): Promise<ForgeConnection> {
    const host = input.host ?? (input.forge === "github" ? "github.com" : "");
    const id = `${input.forge}:${host || "default"}`;
    if (input.method === "token") {
      if (!input.token) throw new Error("A token is required for token authentication.");
      // GitHub/GitLab: hand the token to the CLI's own token login so every
      // existing gh/glab code path (list/repos/PRs/…) works unchanged and the
      // token lives in the CLI's store, not ours. glab's device flow is
      // unreliable (no code emitted), so a pasted token is the primary path.
      if (input.forge === "github" || input.forge === "gitlab") {
        const bin = input.forge === "github" ? await this.ghPath() : await this.glabPath();
        const cli = input.forge === "github" ? "gh" : "glab";
        if (!bin) throw new Error(`${cli} is not installed on the daemon host.`);
        const hostname = host || (input.forge === "github" ? "github.com" : "gitlab.com");
        const args =
          input.forge === "github"
            ? ["auth", "login", "--hostname", hostname, "--git-protocol", "https", "--with-token"]
            : ["auth", "login", "--hostname", hostname, "--stdin"];
        await this.runCliWithStdin(bin, args, `${input.token.trim()}\n`);
        const found = (await this.listConnections()).find((c) => c.id === id);
        if (found) return found;
        return {
          id,
          forge: input.forge,
          host: hostname,
          account: null,
          method: "cli",
          authState: "unauthenticated",
        };
      }
      await this.secretStore.set(`${SECRET_PREFIX}${id}`, input.token);
      // Persist keyless metadata so the connection enumerates after restart.
      const metas = await this.readConnectionIndex();
      const next = metas.filter((m) => m.id !== id);
      next.push({ id, forge: input.forge, host, method: "token" });
      await this.writeConnectionIndex(next);
      // Probe Bitbucket for the account label so the first list reflects it.
      const account = input.forge === "bitbucket" ? await this.bitbucketAccount() : null;
      return {
        id,
        forge: input.forge,
        host,
        account,
        method: "token",
        authState: input.forge === "bitbucket" && !account ? "error" : "authenticated",
      };
    }
    // CLI method: verify the CLI is authenticated for this forge.
    const connections = await this.listConnections();
    const found = connections.find((c) => c.id === id);
    if (found) return found;
    return {
      id,
      forge: input.forge,
      host,
      account: null,
      method: "cli",
      authState: "unauthenticated",
    };
  }

  async removeConnection(connectionId: string): Promise<boolean> {
    // A GitHub/GitLab connection is derived live from `gh/glab api user`, so
    // deleting a stored secret alone leaves it logged in and it reappears on the
    // next list. Log the CLI out of that host so removal actually sticks.
    const [forge, hostPart] = connectionId.split(":", 2);
    const host = hostPart || (forge === "github" ? "github.com" : "gitlab.com");
    if (forge === "github") {
      const gh = await this.ghPath();
      if (gh) await this.ghOk(["auth", "logout", "--hostname", host]);
    } else if (forge === "gitlab") {
      const glab = await this.glabPath();
      if (glab) await this.glabOk(["auth", "logout", "--hostname", host]);
    }
    await this.secretStore.delete(`${SECRET_PREFIX}${connectionId}`);
    const metas = await this.readConnectionIndex();
    const next = metas.filter((m) => m.id !== connectionId);
    if (next.length !== metas.length) await this.writeConnectionIndex(next);
    return true;
  }

  /**
   * List repos across the authenticated providers, tagging each repo with the
   * `connectionId` (`${forge}:${host}`, matching `listConnections`) it came from
   * so the app can browse per-account. When `connectionId` is given only that
   * provider/connection is queried; otherwise every provider is aggregated.
   */
  async listRepos(input: {
    query?: string;
    limit?: number;
    connectionId?: string;
  }): Promise<ForgeRepo[]> {
    const only = input.connectionId;
    // Guard: skip a provider entirely when a specific connection excludes it, so
    // selecting one account fetches only that account's repos.
    const wantGithub = !only || only.startsWith("github:");
    const wantGitlab = !only || only.startsWith("gitlab:");
    const wantBitbucket = !only || only.startsWith("bitbucket:");
    const [github, gitlab, bitbucket] = await Promise.all([
      wantGithub ? this.listGitHubRepos(input) : Promise.resolve<ForgeRepo[]>([]),
      wantGitlab ? this.listGitLabRepos(input) : Promise.resolve<ForgeRepo[]>([]),
      wantBitbucket ? this.listBitbucketRepos(input) : Promise.resolve<ForgeRepo[]>([]),
    ]);
    return [...github, ...gitlab, ...bitbucket];
  }

  /** Logged-in gh login, for tagging GitHub repos with a per-account label. */
  private async githubLogin(): Promise<string | null> {
    const gh = await this.ghPath();
    if (!gh) return null;
    try {
      const res = await execCommand(gh, ["api", "user", "-q", ".login"], {
        timeout: GH_TIMEOUT_MS,
      });
      return res.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** Logged-in glab username, for tagging GitLab repos with a per-account label. */
  private async gitlabUsername(): Promise<string | null> {
    const glab = await this.glabPath();
    if (!glab) return null;
    try {
      const res = await execCommand(glab, ["api", "user"], { timeout: GH_TIMEOUT_MS });
      const parsed = z
        .object({ username: z.string().optional() })
        .safeParse(JSON.parse(res.stdout));
      return parsed.success ? (parsed.data.username ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Id of the Bitbucket token connection repos are fetched through (mirrors
   *  `bitbucketToken`, which uses the first persisted Bitbucket connection). */
  private async bitbucketConnectionId(): Promise<string> {
    const metas = await this.readConnectionIndex();
    const bb = metas.find((m) => m.forge === "bitbucket");
    return bb?.id ?? "bitbucket:bitbucket.org";
  }

  private async listGitHubRepos(input: { query?: string; limit?: number }): Promise<ForgeRepo[]> {
    const limit = input.limit ?? 50;
    const args = [
      "repo",
      "list",
      "--json",
      "nameWithOwner,description,defaultBranchRef,visibility,isPrivate,updatedAt,url",
      "--limit",
      String(limit),
    ];
    const rows = await this.ghJson(args, z.array(GhRepoSchema));
    if (!rows) return [];
    const query = input.query?.trim().toLowerCase();
    const account = (await this.githubLogin()) ?? undefined;
    return rows
      .filter((r) => !query || r.nameWithOwner.toLowerCase().includes(query))
      .map((r): ForgeRepo => {
        const [owner, name] = r.nameWithOwner.split("/", 2);
        return {
          forge: "github",
          connectionId: "github:github.com",
          account,
          owner: owner ?? "",
          name: name ?? r.nameWithOwner,
          description: r.description ?? null,
          defaultBranch: r.defaultBranchRef?.name ?? null,
          visibility: mapVisibility(r.visibility, r.isPrivate),
          updatedAt_ms: isoToMs(r.updatedAt),
          url: r.url,
        };
      });
  }

  async listChangeRequests(input: {
    owner: string;
    name: string;
    state?: "open" | "draft" | "merged" | "closed" | "all";
    limit?: number;
  }): Promise<ForgeChangeRequestSummary[]> {
    const limit = input.limit ?? 50;
    // gh pr list --state: open|closed|merged|all (draft is a flag on the item, not a state).
    const ghState =
      input.state === "merged"
        ? "merged"
        : input.state === "closed"
          ? "closed"
          : input.state === "all"
            ? "all"
            : "open";
    const args = [
      "pr",
      "list",
      "--repo",
      `${input.owner}/${input.name}`,
      "--state",
      ghState,
      "--json",
      "number,title,url,state,isDraft,headRefName,baseRefName,labels,updatedAt,author,reviewDecision,statusCheckRollup",
      "--limit",
      String(limit),
    ];
    const rows = await this.ghJson(args, z.array(GhPrSchema));
    if (!rows) return [];
    return rows
      .filter((r) => (input.state === "draft" ? r.isDraft === true : true))
      .map(
        (r): ForgeChangeRequestSummary => ({
          number: r.number,
          title: r.title,
          url: r.url,
          state: prState(r.state, r.isDraft),
          authorLogin: r.author?.login ?? null,
          headRef: r.headRefName,
          baseRef: r.baseRefName,
          labels: r.labels?.map((l) => l.name) ?? [],
          reviewDecision: mapReviewDecision(r.reviewDecision),
          checksStatus: rollupToChecks(r.statusCheckRollup),
          updatedAt_ms: isoToMs(r.updatedAt),
        }),
      );
  }

  async getChangeRequestFiles(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<{ files: ForgeChangeRequestFile[]; truncated: boolean }> {
    const args = [
      "api",
      "--paginate",
      `repos/${input.owner}/${input.name}/pulls/${input.number}/files`,
    ];
    const rows = await this.ghJson(args, z.array(GhFileSchema));
    if (!rows) return { files: [], truncated: false };
    const files = rows.map(
      (f): ForgeChangeRequestFile => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: fileStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      }),
    );
    return { files, truncated: false };
  }

  // ===== Milestone B (code · review · merge · CI) — GitHub via gh ===============
  // GitHub-only for this checkpoint; other forges return empty/unsupported until the
  // glab/bitbucket providers land. Each method degrades to a safe empty result.

  /** Run gh for its side effect; resolve true on success, false on any failure. */
  private async ghOk(args: string[]): Promise<boolean> {
    const gh = await this.ghPath();
    if (!gh) return false;
    try {
      await execCommand(gh, args, { timeout: GH_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /** Run gh and return raw stdout, or null on failure. */
  private async ghText(args: string[]): Promise<string | null> {
    const gh = await this.ghPath();
    if (!gh) return null;
    try {
      const res = await execCommand(gh, args, { timeout: GH_TIMEOUT_MS });
      return res.stdout;
    } catch {
      return null;
    }
  }

  async listBranches(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeBranch[]> {
    const repo = `${input.owner}/${input.name}`;
    const def = (
      await this.ghText([
        "repo",
        "view",
        repo,
        "--json",
        "defaultBranchRef",
        "-q",
        ".defaultBranchRef.name",
      ])
    )?.trim();
    const rows = await this.ghJson(
      ["api", "--paginate", `repos/${repo}/branches?per_page=${input.limit ?? 100}`],
      z.array(
        z.object({
          name: z.string(),
          protected: z.boolean().optional(),
          commit: z.object({ sha: z.string() }).optional(),
        }),
      ),
    );
    if (!rows) return [];
    return rows.map((b) => ({
      name: b.name,
      isDefault: def ? b.name === def : undefined,
      commitSha: b.commit?.sha ?? null,
      protected: b.protected,
    }));
  }

  async listCommits(input: {
    owner: string;
    name: string;
    ref?: string;
    limit?: number;
  }): Promise<ForgeCommit[]> {
    const repo = `${input.owner}/${input.name}`;
    const per = input.limit ?? 50;
    const qs = `per_page=${per}${input.ref ? `&sha=${encodeURIComponent(input.ref)}` : ""}`;
    const rows = await this.ghJson(
      ["api", `repos/${repo}/commits?${qs}`],
      z.array(
        z.object({
          sha: z.string(),
          commit: z.object({
            message: z.string(),
            author: z
              .object({ name: z.string().optional(), date: z.string().optional() })
              .optional(),
          }),
          author: z.object({ login: z.string() }).nullable().optional(),
        }),
      ),
    );
    if (!rows) return [];
    return rows.map((c) => ({
      sha: c.sha,
      subject: c.commit.message.split("\n", 1)[0] ?? c.commit.message,
      authorLogin: c.author?.login ?? null,
      authorName: c.commit.author?.name ?? null,
      committedAt_ms: isoToMs(c.commit.author?.date),
    }));
  }

  async compareCommits(input: {
    owner: string;
    name: string;
    base: string;
    head: string;
  }): Promise<{ files: ForgeChangeRequestFile[]; commits: ForgeCommit[] }> {
    const repo = `${input.owner}/${input.name}`;
    const res = await this.ghJson(
      [
        "api",
        `repos/${repo}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`,
      ],
      z.object({
        files: z.array(GhFileSchema).optional().default([]),
        commits: z
          .array(
            z.object({
              sha: z.string(),
              commit: z.object({
                message: z.string(),
                author: z
                  .object({ name: z.string().optional(), date: z.string().optional() })
                  .optional(),
              }),
              author: z.object({ login: z.string() }).nullable().optional(),
            }),
          )
          .optional()
          .default([]),
      }),
    );
    if (!res) return { files: [], commits: [] };
    return {
      files: res.files.map((f) => ({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: fileStatus(f.status),
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      })),
      commits: res.commits.map((c) => ({
        sha: c.sha,
        subject: c.commit.message.split("\n", 1)[0] ?? c.commit.message,
        authorLogin: c.author?.login ?? null,
        authorName: c.commit.author?.name ?? null,
        committedAt_ms: isoToMs(c.commit.author?.date),
      })),
    };
  }

  async listTree(input: {
    owner: string;
    name: string;
    ref: string;
    path: string;
  }): Promise<ForgeTreeEntry[]> {
    const repo = `${input.owner}/${input.name}`;
    const enc = encodePath(input.path);
    const res = await this.ghJson(
      ["api", `repos/${repo}/contents${enc ? `/${enc}` : ""}?ref=${encodeURIComponent(input.ref)}`],
      z.union([
        z.array(
          z.object({
            name: z.string(),
            path: z.string(),
            type: z.string(),
            size: z.number().optional(),
          }),
        ),
        // A single object means `path` was a file, not a directory.
        z.object({ type: z.string() }),
      ]),
    );
    if (!res || !Array.isArray(res)) return [];
    return res.map(
      (e): ForgeTreeEntry => ({
        name: e.name,
        path: e.path,
        type: e.type === "dir" ? "dir" : "file",
        size: e.size ?? null,
      }),
    );
  }

  async getFile(input: {
    owner: string;
    name: string;
    ref: string;
    path: string;
  }): Promise<ForgeFileResult> {
    const repo = `${input.owner}/${input.name}`;
    const res = await this.ghJson(
      [
        "api",
        `repos/${repo}/contents/${encodePath(input.path)}?ref=${encodeURIComponent(input.ref)}`,
      ],
      z.object({
        content: z.string().optional(),
        encoding: z.string().optional(),
        size: z.number().optional(),
      }),
    );
    const size = res?.size ?? null;
    if (!res || res.content == null || (res.size != null && res.size > MAX_FILE_BYTES)) {
      return { path: input.path, content: null, isBinary: false, size, truncated: true };
    }
    return decodeForgeFile(input.path, Buffer.from(res.content, "base64"), size);
  }

  async reviewChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
    action: ForgeReviewAction;
    body?: string;
  }): Promise<boolean> {
    const flag =
      input.action === "approve"
        ? "--approve"
        : input.action === "request_changes"
          ? "--request-changes"
          : "--comment";
    const args = [
      "pr",
      "review",
      String(input.number),
      "--repo",
      `${input.owner}/${input.name}`,
      flag,
    ];
    if (input.body) args.push("--body", input.body);
    return this.ghOk(args);
  }

  async mergeChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
    method: ForgeMergeMethod;
  }): Promise<boolean> {
    const flag =
      input.method === "squash" ? "--squash" : input.method === "rebase" ? "--rebase" : "--merge";
    return this.ghOk([
      "pr",
      "merge",
      String(input.number),
      "--repo",
      `${input.owner}/${input.name}`,
      flag,
    ]);
  }

  async listPipelines(input: {
    owner: string;
    name: string;
    ref?: string;
    limit?: number;
  }): Promise<ForgePipelineRun[]> {
    const args = [
      "run",
      "list",
      "--repo",
      `${input.owner}/${input.name}`,
      "--json",
      "databaseId,name,displayTitle,status,conclusion,headBranch,headSha,event,createdAt,url",
      "--limit",
      String(input.limit ?? 30),
    ];
    if (input.ref) args.push("--branch", input.ref);
    const rows = await this.ghJson(
      args,
      z.array(
        z.object({
          databaseId: z.number(),
          name: z.string().optional(),
          displayTitle: z.string().optional(),
          status: z.string().optional(),
          conclusion: z.string().nullable().optional(),
          headBranch: z.string().nullable().optional(),
          headSha: z.string().nullable().optional(),
          event: z.string().nullable().optional(),
          createdAt: z.string().optional(),
          url: z.string(),
        }),
      ),
    );
    if (!rows) return [];
    return rows.map((r) => ({
      id: String(r.databaseId),
      name: r.name ?? r.displayTitle ?? "workflow",
      status: ghRunStatus(r.status, r.conclusion),
      ref: r.headBranch ?? null,
      sha: r.headSha ?? null,
      trigger: r.event ?? null,
      actor: null,
      durationSeconds: null,
      createdAt_ms: isoToMs(r.createdAt),
      url: r.url,
    }));
  }

  async getPipeline(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<ForgePipelineDetail | null> {
    const res = await this.ghJson(
      [
        "run",
        "view",
        input.runId,
        "--repo",
        `${input.owner}/${input.name}`,
        "--json",
        "status,conclusion,url,jobs",
      ],
      z.object({
        status: z.string().optional(),
        conclusion: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        jobs: z
          .array(
            z.object({
              databaseId: z.number(),
              name: z.string(),
              status: z.string().optional(),
              conclusion: z.string().nullable().optional(),
              startedAt: z.string().nullable().optional(),
              completedAt: z.string().nullable().optional(),
            }),
          )
          .optional()
          .default([]),
      }),
    );
    if (!res) return null;
    // GitHub has no stages; present a single "jobs" stage.
    const jobs: ForgePipelineJob[] = res.jobs.map((j) => ({
      id: String(j.databaseId),
      name: j.name,
      stage: "jobs",
      status: ghRunStatus(j.status, j.conclusion),
      durationSeconds:
        j.startedAt && j.completedAt
          ? Math.max(0, Math.round((Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 1000))
          : null,
      url: null,
    }));
    return {
      id: input.runId,
      status: ghRunStatus(res.status, res.conclusion),
      url: res.url ?? null,
      stages: [{ name: "jobs", status: ghRunStatus(res.status, res.conclusion), jobs }],
    };
  }

  async getJobLog(input: {
    owner: string;
    name: string;
    jobId: string;
  }): Promise<{ log: string; truncated: boolean; running: boolean }> {
    // `gh run view --job <id> --log` prints the job log; while running, gh needs
    // `--log-failed`/live logs aren't available, so a running job may return empty.
    const text = await this.ghText([
      "run",
      "view",
      "--repo",
      `${input.owner}/${input.name}`,
      "--job",
      input.jobId,
      "--log",
    ]);
    const MAX = 2 * 1024 * 1024;
    if (text == null) return { log: "", truncated: false, running: false };
    if (text.length > MAX) return { log: text.slice(0, MAX), truncated: true, running: false };
    return { log: text, truncated: false, running: false };
  }

  async rerunPipeline(input: {
    owner: string;
    name: string;
    runId: string;
    onlyFailed?: boolean;
  }): Promise<boolean> {
    const args = ["run", "rerun", input.runId, "--repo", `${input.owner}/${input.name}`];
    if (input.onlyFailed) args.push("--failed");
    return this.ghOk(args);
  }

  async cancelPipeline(input: { owner: string; name: string; runId: string }): Promise<boolean> {
    return this.ghOk(["run", "cancel", input.runId, "--repo", `${input.owner}/${input.name}`]);
  }

  // ===== GitLab provider (glab CLI, REST v4) ====================================
  // `glab api <path>` is uniform: it hits the REST v4 endpoint and rejects on a
  // non-zero exit, so a resolved result means success (mirrors the gh helpers).

  private async glabPath(): Promise<string | null> {
    return findExecutable("glab");
  }

  /** Run `glab` and return parsed JSON stdout, or null on any failure. */
  private async glabJson<T>(args: string[], schema: z.ZodType<T>): Promise<T | null> {
    const glab = await this.glabPath();
    if (!glab) return null;
    try {
      const res = await execCommand(glab, args, { timeout: GH_TIMEOUT_MS });
      return schema.parse(JSON.parse(res.stdout));
    } catch {
      return null;
    }
  }

  /** Run `glab` for its side effect; resolve true on success, false on any failure. */
  private async glabOk(args: string[]): Promise<boolean> {
    const glab = await this.glabPath();
    if (!glab) return false;
    try {
      await execCommand(glab, args, { timeout: GH_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }

  /** Run `glab` and return raw stdout, or null on failure. */
  private async glabText(args: string[]): Promise<string | null> {
    const glab = await this.glabPath();
    if (!glab) return null;
    try {
      const res = await execCommand(glab, args, { timeout: GH_TIMEOUT_MS });
      return res.stdout;
    } catch {
      return null;
    }
  }

  async listGitLabRepos(input: { query?: string; limit?: number }): Promise<ForgeRepo[]> {
    const limit = input.limit ?? 50;
    // NOTE: GitLab.com returns HTTP 500 for `order_by=last_activity_at` WITHOUT
    // an explicit `sort` — always pass `sort=desc` (verified against gitlab.com).
    const rows = await this.glabJson(
      ["api", `projects?membership=true&per_page=${limit}&order_by=last_activity_at&sort=desc`],
      z.array(GlRepoSchema),
    );
    if (!rows) return [];
    const query = input.query?.trim().toLowerCase();
    const account = (await this.gitlabUsername()) ?? undefined;
    return rows
      .filter((r) => !query || r.path_with_namespace.toLowerCase().includes(query))
      .map((r): ForgeRepo => {
        const idx = r.path_with_namespace.lastIndexOf("/");
        const owner = idx >= 0 ? r.path_with_namespace.slice(0, idx) : "";
        const name = idx >= 0 ? r.path_with_namespace.slice(idx + 1) : r.path_with_namespace;
        return {
          forge: "gitlab",
          connectionId: "gitlab:gitlab.com",
          account,
          owner,
          name,
          description: r.description ?? null,
          defaultBranch: r.default_branch ?? null,
          visibility: mapVisibility(r.visibility, undefined),
          updatedAt_ms: isoToMs(r.last_activity_at),
          url: r.web_url,
        };
      });
  }

  async listGitLabChangeRequests(input: {
    owner: string;
    name: string;
    state?: "open" | "draft" | "merged" | "closed" | "all";
    limit?: number;
  }): Promise<ForgeChangeRequestSummary[]> {
    const limit = input.limit ?? 50;
    // GitLab MR states: opened|closed|merged|all (draft is a flag, not a state).
    const glState =
      input.state === "merged"
        ? "merged"
        : input.state === "closed"
          ? "closed"
          : input.state === "all"
            ? "all"
            : "opened";
    const enc = glProjectId(input.owner, input.name);
    const rows = await this.glabJson(
      ["api", `projects/${enc}/merge_requests?state=${glState}&per_page=${limit}`],
      z.array(GlMrSchema),
    );
    if (!rows) return [];
    return rows
      .filter((r) => (input.state === "draft" ? (r.draft ?? r.work_in_progress) === true : true))
      .map((r): ForgeChangeRequestSummary => {
        const draft = (r.draft ?? r.work_in_progress) === true;
        return {
          number: r.iid,
          title: r.title,
          url: r.web_url,
          state: glMrState(r.state, draft),
          authorLogin: r.author?.username ?? null,
          headRef: r.source_branch,
          baseRef: r.target_branch,
          labels: r.labels ?? [],
          reviewDecision: null,
          checksStatus: "none",
          updatedAt_ms: isoToMs(r.updated_at),
        };
      });
  }

  async getGitLabChangeRequestFiles(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<{ files: ForgeChangeRequestFile[]; truncated: boolean }> {
    const enc = glProjectId(input.owner, input.name);
    const res = await this.glabJson(
      ["api", `projects/${enc}/merge_requests/${input.number}/changes`],
      z.object({ changes: z.array(GlChangeSchema).optional().default([]) }),
    );
    if (!res) return { files: [], truncated: false };
    return { files: res.changes.map(glChangeToFile), truncated: false };
  }

  async listGitLabBranches(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeBranch[]> {
    const enc = glProjectId(input.owner, input.name);
    const rows = await this.glabJson(
      ["api", `projects/${enc}/repository/branches?per_page=${input.limit ?? 100}`],
      z.array(GlBranchSchema),
    );
    if (!rows) return [];
    return rows.map(
      (b): ForgeBranch => ({
        name: b.name,
        isDefault: b.default,
        commitSha: b.commit?.id ?? null,
        protected: b.protected,
      }),
    );
  }

  async listGitLabCommits(input: {
    owner: string;
    name: string;
    ref?: string;
    limit?: number;
  }): Promise<ForgeCommit[]> {
    const enc = glProjectId(input.owner, input.name);
    const per = input.limit ?? 50;
    const qs = `per_page=${per}${input.ref ? `&ref_name=${encodeURIComponent(input.ref)}` : ""}`;
    const rows = await this.glabJson(
      ["api", `projects/${enc}/repository/commits?${qs}`],
      z.array(GlCommitSchema),
    );
    if (!rows) return [];
    return rows.map(glCommit);
  }

  async compareGitLabCommits(input: {
    owner: string;
    name: string;
    base: string;
    head: string;
  }): Promise<{ files: ForgeChangeRequestFile[]; commits: ForgeCommit[] }> {
    const enc = glProjectId(input.owner, input.name);
    const res = await this.glabJson(
      [
        "api",
        `projects/${enc}/repository/compare?from=${encodeURIComponent(input.base)}&to=${encodeURIComponent(input.head)}`,
      ],
      z.object({
        diffs: z.array(GlChangeSchema).optional().default([]),
        commits: z.array(GlCommitSchema).optional().default([]),
      }),
    );
    if (!res) return { files: [], commits: [] };
    return {
      files: res.diffs.map(glChangeToFile),
      commits: res.commits.map(glCommit),
    };
  }

  async listGitLabTree(input: {
    owner: string;
    name: string;
    ref: string;
    path: string;
  }): Promise<ForgeTreeEntry[]> {
    const enc = glProjectId(input.owner, input.name);
    const pathParam = input.path ? `&path=${encodeURIComponent(input.path)}` : "";
    const rows = await this.glabJson(
      [
        "api",
        `projects/${enc}/repository/tree?ref=${encodeURIComponent(input.ref)}${pathParam}&per_page=100`,
      ],
      z.array(z.object({ name: z.string(), path: z.string(), type: z.string() })),
    );
    if (!rows) return [];
    return rows.map(
      (e): ForgeTreeEntry => ({
        name: e.name,
        path: e.path,
        type: e.type === "tree" ? "dir" : "file",
        size: null, // GitLab's tree API does not report blob sizes
      }),
    );
  }

  async getGitLabFile(input: {
    owner: string;
    name: string;
    ref: string;
    path: string;
  }): Promise<ForgeFileResult> {
    const enc = glProjectId(input.owner, input.name);
    const res = await this.glabJson(
      [
        "api",
        `projects/${enc}/repository/files/${encodeURIComponent(input.path)}?ref=${encodeURIComponent(input.ref)}`,
      ],
      z.object({ content: z.string().optional(), size: z.number().optional() }),
    );
    const size = res?.size ?? null;
    if (!res || res.content == null || (res.size != null && res.size > MAX_FILE_BYTES)) {
      return { path: input.path, content: null, isBinary: false, size, truncated: true };
    }
    return decodeForgeFile(input.path, Buffer.from(res.content, "base64"), size);
  }

  async reviewGitLabChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
    action: ForgeReviewAction;
    body?: string;
  }): Promise<boolean> {
    const enc = glProjectId(input.owner, input.name);
    const mr = `projects/${enc}/merge_requests/${input.number}`;
    if (input.action === "approve") {
      return this.glabOk(["api", "-X", "POST", `${mr}/approve`]);
    }
    if (input.action === "request_changes") {
      // GitLab has no native "request changes": unapprove (best-effort) + leave a note.
      await this.glabOk(["api", "-X", "POST", `${mr}/unapprove`]);
      const body = input.body ?? "Changes requested.";
      return this.glabOk(["api", "-X", "POST", `${mr}/notes`, "-f", `body=${body}`]);
    }
    // comment
    return this.glabOk(["api", "-X", "POST", `${mr}/notes`, "-f", `body=${input.body ?? ""}`]);
  }

  async mergeGitLabChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
    method: ForgeMergeMethod;
  }): Promise<boolean> {
    const enc = glProjectId(input.owner, input.name);
    const mr = `projects/${enc}/merge_requests/${input.number}`;
    if (input.method === "rebase") {
      // GitLab merge has no rebase mode; rebase best-effort then merge.
      await this.glabOk(["api", "-X", "PUT", `${mr}/rebase`]);
      return this.glabOk(["api", "-X", "PUT", `${mr}/merge`]);
    }
    const args = ["api", "-X", "PUT", `${mr}/merge`];
    if (input.method === "squash") args.push("-f", "squash=true");
    return this.glabOk(args);
  }

  async listGitLabPipelines(input: {
    owner: string;
    name: string;
    ref?: string;
    limit?: number;
  }): Promise<ForgePipelineRun[]> {
    const enc = glProjectId(input.owner, input.name);
    const qs = `per_page=${input.limit ?? 30}${input.ref ? `&ref=${encodeURIComponent(input.ref)}` : ""}`;
    const rows = await this.glabJson(
      ["api", `projects/${enc}/pipelines?${qs}`],
      z.array(GlPipelineSchema),
    );
    if (!rows) return [];
    return rows.map(
      (r): ForgePipelineRun => ({
        id: String(r.id),
        name: `Pipeline #${r.id}`,
        status: glPipelineStatus(r.status),
        ref: r.ref ?? null,
        sha: r.sha ?? null,
        trigger: r.source ?? null,
        actor: null,
        durationSeconds: null,
        createdAt_ms: isoToMs(r.created_at),
        url: r.web_url,
      }),
    );
  }

  async getGitLabPipeline(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<ForgePipelineDetail | null> {
    const enc = glProjectId(input.owner, input.name);
    const jobs = await this.glabJson(
      ["api", `projects/${enc}/pipelines/${input.runId}/jobs`],
      z.array(GlJobSchema),
    );
    if (!jobs) return null;
    const mapped: ForgePipelineJob[] = jobs.map((j) => ({
      id: String(j.id),
      name: j.name,
      stage: j.stage,
      status: glPipelineStatus(j.status),
      durationSeconds: j.duration != null ? Math.max(0, Math.round(j.duration)) : null,
      url: j.web_url ?? null,
    }));
    // Group jobs into stages, preserving first-seen stage order.
    const order: string[] = [];
    const byStage = new Map<string, ForgePipelineJob[]>();
    for (const j of mapped) {
      let bucket = byStage.get(j.stage);
      if (!bucket) {
        bucket = [];
        byStage.set(j.stage, bucket);
        order.push(j.stage);
      }
      bucket.push(j);
    }
    const stages = order.map((name) => {
      const stageJobs = byStage.get(name) ?? [];
      return { name, status: aggregateGlStatus(stageJobs.map((j) => j.status)), jobs: stageJobs };
    });
    return {
      id: input.runId,
      // The jobs endpoint carries no pipeline-level ref/sha/url; aggregate status from jobs.
      status: aggregateGlStatus(mapped.map((j) => j.status)),
      url: null,
      stages,
    };
  }

  async getGitLabJobLog(input: {
    owner: string;
    name: string;
    jobId: string;
  }): Promise<{ log: string; truncated: boolean; running: boolean }> {
    const enc = glProjectId(input.owner, input.name);
    const text = await this.glabText(["api", `projects/${enc}/jobs/${input.jobId}/trace`]);
    const MAX = 2 * 1024 * 1024;
    if (text == null) return { log: "", truncated: false, running: false };
    if (text.length > MAX) return { log: text.slice(0, MAX), truncated: true, running: false };
    return { log: text, truncated: false, running: false };
  }

  async rerunGitLabPipeline(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<boolean> {
    // GitLab retry re-runs the pipeline's failed/canceled jobs (there is no full re-run).
    const enc = glProjectId(input.owner, input.name);
    return this.glabOk(["api", "-X", "POST", `projects/${enc}/pipelines/${input.runId}/retry`]);
  }

  async cancelGitLabPipeline(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<boolean> {
    const enc = glProjectId(input.owner, input.name);
    return this.glabOk(["api", "-X", "POST", `projects/${enc}/pipelines/${input.runId}/cancel`]);
  }

  async playGitLabJob(input: { owner: string; name: string; jobId: string }): Promise<boolean> {
    const enc = glProjectId(input.owner, input.name);
    return this.glabOk(["api", "-X", "POST", `projects/${enc}/jobs/${input.jobId}/play`]);
  }

  // ===== Milestone C — GitHub (auto-merge · artifacts · releases · tags · issues) =

  async setAutoMerge(input: {
    owner: string;
    name: string;
    number: number;
    enabled: boolean;
    method: ForgeMergeMethod;
  }): Promise<boolean> {
    const repo = `${input.owner}/${input.name}`;
    if (!input.enabled) {
      const ok = await this.ghOk([
        "pr",
        "merge",
        String(input.number),
        "--repo",
        repo,
        "--disable-auto",
      ]);
      return ok ? false : true; // on failure the prior (enabled) state is unchanged
    }
    const flag =
      input.method === "squash" ? "--squash" : input.method === "rebase" ? "--rebase" : "--merge";
    const ok = await this.ghOk([
      "pr",
      "merge",
      String(input.number),
      "--repo",
      repo,
      "--auto",
      flag,
    ]);
    return ok;
  }

  async listArtifacts(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<ForgeArtifact[]> {
    const repo = `${input.owner}/${input.name}`;
    const res = await this.ghJson(
      ["api", `repos/${repo}/actions/runs/${input.runId}/artifacts`],
      z.object({
        artifacts: z
          .array(
            z.object({
              id: z.number(),
              name: z.string(),
              size_in_bytes: z.number().optional(),
              archive_download_url: z.string().optional(),
              expires_at: z.string().nullable().optional(),
            }),
          )
          .optional()
          .default([]),
      }),
    );
    if (!res) return [];
    return res.artifacts.map(
      (a): ForgeArtifact => ({
        id: String(a.id),
        name: a.name,
        sizeBytes: a.size_in_bytes ?? null,
        url: a.archive_download_url ?? null,
        expiresAt_ms: isoToMs(a.expires_at ?? undefined),
      }),
    );
  }

  /** Resolve a downloadable URL for an artifact; null when the forge has none. */
  async downloadArtifact(input: {
    owner: string;
    name: string;
    artifactId: string;
  }): Promise<string | null> {
    const repo = `${input.owner}/${input.name}`;
    const res = await this.ghJson(
      ["api", `repos/${repo}/actions/artifacts/${input.artifactId}`],
      z.object({ archive_download_url: z.string().optional() }),
    );
    return res?.archive_download_url ?? null;
  }

  async listReleases(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeRelease[]> {
    const repo = `${input.owner}/${input.name}`;
    const rows = await this.ghJson(
      ["api", `repos/${repo}/releases?per_page=${input.limit ?? 30}`],
      z.array(
        z.object({
          id: z.number(),
          tag_name: z.string(),
          name: z.string().nullable().optional(),
          draft: z.boolean().optional(),
          prerelease: z.boolean().optional(),
          published_at: z.string().nullable().optional(),
          html_url: z.string(),
          assets: z
            .array(
              z.object({
                name: z.string(),
                browser_download_url: z.string(),
                size: z.number().optional(),
              }),
            )
            .optional()
            .default([]),
        }),
      ),
    );
    if (!rows) return [];
    return rows.map(
      (r): ForgeRelease => ({
        id: String(r.id),
        tagName: r.tag_name,
        name: r.name ?? null,
        isDraft: r.draft ?? false,
        isPrerelease: r.prerelease ?? false,
        publishedAt_ms: isoToMs(r.published_at ?? undefined),
        url: r.html_url,
        assets: r.assets.map(
          (a): ForgeReleaseAsset => ({
            name: a.name,
            url: a.browser_download_url,
            sizeBytes: a.size ?? null,
          }),
        ),
      }),
    );
  }

  async listTags(input: { owner: string; name: string; limit?: number }): Promise<ForgeTag[]> {
    const repo = `${input.owner}/${input.name}`;
    const rows = await this.ghJson(
      ["api", `repos/${repo}/tags?per_page=${input.limit ?? 100}`],
      z.array(
        z.object({ name: z.string(), commit: z.object({ sha: z.string() }).nullable().optional() }),
      ),
    );
    if (!rows) return [];
    return rows.map(
      (t): ForgeTag => ({ name: t.name, commitSha: t.commit?.sha ?? null, url: null }),
    );
  }

  async listIssues(input: {
    owner: string;
    name: string;
    state?: "open" | "closed" | "all";
    limit?: number;
  }): Promise<ForgeIssue[]> {
    const repo = `${input.owner}/${input.name}`;
    // `gh issue list` excludes PRs (unlike the /issues REST endpoint), which is what we want.
    const rows = await this.ghJson(
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        input.state ?? "open",
        "--json",
        "number,title,url,state,author,labels,updatedAt",
        "--limit",
        String(input.limit ?? 50),
      ],
      z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          url: z.string(),
          state: z.string(),
          author: z.object({ login: z.string() }).nullable().optional(),
          labels: z.array(z.object({ name: z.string() })).optional(),
          updatedAt: z.string().optional(),
        }),
      ),
    );
    if (!rows) return [];
    return rows.map(
      (i): ForgeIssue => ({
        number: i.number,
        title: i.title,
        url: i.url,
        state: i.state.toLowerCase() === "closed" ? "closed" : "open",
        authorLogin: i.author?.login ?? null,
        labels: i.labels?.map((l) => l.name) ?? [],
        updatedAt_ms: isoToMs(i.updatedAt),
      }),
    );
  }

  async createIssue(input: {
    owner: string;
    name: string;
    title: string;
    body?: string;
  }): Promise<ForgeIssue | null> {
    const repo = `${input.owner}/${input.name}`;
    // `gh api` (vs `gh issue create`) returns the created issue as JSON to map back.
    const args = ["api", "-X", "POST", `repos/${repo}/issues`, "-f", `title=${input.title}`];
    if (input.body) args.push("-f", `body=${input.body}`);
    const res = await this.ghJson(
      args,
      z.object({
        number: z.number(),
        title: z.string(),
        html_url: z.string(),
        state: z.string(),
        user: z.object({ login: z.string() }).nullable().optional(),
        labels: z.array(z.object({ name: z.string() })).optional(),
        updated_at: z.string().optional(),
      }),
    );
    if (!res) return null;
    return {
      number: res.number,
      title: res.title,
      url: res.html_url,
      state: res.state.toLowerCase() === "closed" ? "closed" : "open",
      authorLogin: res.user?.login ?? null,
      labels: res.labels?.map((l) => l.name) ?? [],
      updatedAt_ms: isoToMs(res.updated_at),
    };
  }

  async commentIssue(input: {
    owner: string;
    name: string;
    number: number;
    body: string;
  }): Promise<boolean> {
    const repo = `${input.owner}/${input.name}`;
    return this.ghOk([
      "issue",
      "comment",
      String(input.number),
      "--repo",
      repo,
      "--body",
      input.body,
    ]);
  }

  async closeIssue(input: { owner: string; name: string; number: number }): Promise<boolean> {
    const repo = `${input.owner}/${input.name}`;
    return this.ghOk(["issue", "close", String(input.number), "--repo", repo]);
  }

  // ===== Milestone C — GitLab ====================================================

  async setGitLabAutoMerge(input: {
    owner: string;
    name: string;
    number: number;
    enabled: boolean;
  }): Promise<boolean> {
    const enc = glProjectId(input.owner, input.name);
    const mr = `projects/${enc}/merge_requests/${input.number}`;
    // "auto-merge" on GitLab == merge-when-pipeline-succeeds (MWPS).
    const ok = input.enabled
      ? await this.glabOk([
          "api",
          "-X",
          "PUT",
          `${mr}/merge`,
          "-f",
          "merge_when_pipeline_succeeds=true",
        ])
      : await this.glabOk(["api", "-X", "POST", `${mr}/cancel_merge_when_pipeline_succeeds`]);
    return ok ? input.enabled : !input.enabled;
  }

  async listGitLabArtifacts(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<ForgeArtifact[]> {
    // GitLab artifacts are job-scoped (no pipeline-level artifact list), so runId is
    // interpreted as a job id here. The job payload's `artifacts` array carries only
    // filename + size — no per-artifact download URL or expiry — so those stay null.
    const enc = glProjectId(input.owner, input.name);
    const res = await this.glabJson(
      ["api", `projects/${enc}/jobs/${input.runId}`],
      z.object({
        artifacts: z
          .array(z.object({ filename: z.string().optional(), size: z.number().optional() }))
          .nullable()
          .optional(),
      }),
    );
    if (!res?.artifacts) return [];
    return res.artifacts.map(
      (a, i): ForgeArtifact => ({
        id: `${input.runId}:${i}`,
        name: a.filename ?? `artifact-${i}`,
        sizeBytes: a.size ?? null,
        url: null,
        expiresAt_ms: null,
      }),
    );
  }

  async listGitLabReleases(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeRelease[]> {
    const enc = glProjectId(input.owner, input.name);
    const rows = await this.glabJson(
      ["api", `projects/${enc}/releases?per_page=${input.limit ?? 30}`],
      z.array(
        z.object({
          tag_name: z.string(),
          name: z.string().nullable().optional(),
          released_at: z.string().nullable().optional(),
          created_at: z.string().nullable().optional(),
          upcoming_release: z.boolean().optional(),
          _links: z.object({ self: z.string().optional() }).nullable().optional(),
          assets: z
            .object({
              links: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
            })
            .nullable()
            .optional(),
        }),
      ),
    );
    if (!rows) return [];
    return rows.map(
      (r): ForgeRelease => ({
        id: r.tag_name,
        tagName: r.tag_name,
        name: r.name ?? null,
        isDraft: false, // GitLab has no draft-release concept
        isPrerelease: r.upcoming_release ?? false,
        publishedAt_ms: isoToMs(r.released_at ?? r.created_at ?? undefined),
        url: r._links?.self ?? "",
        assets: (r.assets?.links ?? []).map(
          (a): ForgeReleaseAsset => ({ name: a.name, url: a.url, sizeBytes: null }),
        ),
      }),
    );
  }

  async listGitLabTags(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeTag[]> {
    const enc = glProjectId(input.owner, input.name);
    const rows = await this.glabJson(
      ["api", `projects/${enc}/repository/tags?per_page=${input.limit ?? 100}`],
      z.array(
        z.object({ name: z.string(), commit: z.object({ id: z.string() }).nullable().optional() }),
      ),
    );
    if (!rows) return [];
    return rows.map(
      (t): ForgeTag => ({ name: t.name, commitSha: t.commit?.id ?? null, url: null }),
    );
  }

  async listGitLabIssues(input: {
    owner: string;
    name: string;
    state?: "open" | "closed" | "all";
    limit?: number;
  }): Promise<ForgeIssue[]> {
    const enc = glProjectId(input.owner, input.name);
    const state = input.state === "closed" ? "closed" : input.state === "all" ? "all" : "opened";
    const qs = `per_page=${input.limit ?? 50}${state === "all" ? "" : `&state=${state}`}`;
    const rows = await this.glabJson(
      ["api", `projects/${enc}/issues?${qs}`],
      z.array(
        z.object({
          iid: z.number(),
          title: z.string(),
          web_url: z.string(),
          state: z.string(),
          author: z.object({ username: z.string() }).nullable().optional(),
          labels: z.array(z.string()).optional(),
          user_notes_count: z.number().optional(),
          updated_at: z.string().optional(),
        }),
      ),
    );
    if (!rows) return [];
    return rows.map(
      (i): ForgeIssue => ({
        number: i.iid,
        title: i.title,
        url: i.web_url,
        state: i.state.toLowerCase() === "opened" ? "open" : "closed",
        authorLogin: i.author?.username ?? null,
        labels: i.labels ?? [],
        commentCount: i.user_notes_count,
        updatedAt_ms: isoToMs(i.updated_at),
      }),
    );
  }

  async createGitLabIssue(input: {
    owner: string;
    name: string;
    title: string;
    body?: string;
  }): Promise<ForgeIssue | null> {
    const enc = glProjectId(input.owner, input.name);
    const args = ["api", "-X", "POST", `projects/${enc}/issues`, "-f", `title=${input.title}`];
    if (input.body) args.push("-f", `description=${input.body}`);
    const res = await this.glabJson(
      args,
      z.object({
        iid: z.number(),
        title: z.string(),
        web_url: z.string(),
        state: z.string(),
        author: z.object({ username: z.string() }).nullable().optional(),
        labels: z.array(z.string()).optional(),
        updated_at: z.string().optional(),
      }),
    );
    if (!res) return null;
    return {
      number: res.iid,
      title: res.title,
      url: res.web_url,
      state: res.state.toLowerCase() === "opened" ? "open" : "closed",
      authorLogin: res.author?.username ?? null,
      labels: res.labels ?? [],
      updatedAt_ms: isoToMs(res.updated_at),
    };
  }

  async commentGitLabIssue(input: {
    owner: string;
    name: string;
    number: number;
    body: string;
  }): Promise<boolean> {
    const enc = glProjectId(input.owner, input.name);
    return this.glabOk([
      "api",
      "-X",
      "POST",
      `projects/${enc}/issues/${input.number}/notes`,
      "-f",
      `body=${input.body}`,
    ]);
  }

  async closeGitLabIssue(input: { owner: string; name: string; number: number }): Promise<boolean> {
    const enc = glProjectId(input.owner, input.name);
    return this.glabOk([
      "api",
      "-X",
      "PUT",
      `projects/${enc}/issues/${input.number}`,
      "-f",
      "state_event=close",
    ]);
  }

  // ===== Bitbucket Cloud provider (REST 2.0 + token; no CLI) =====================
  // Auth is `Authorization: Bearer <token>` (Bitbucket access tokens / OAuth). App
  // passwords would use HTTP Basic (user:app_password); we default to Bearer since we
  // cannot e2e-verify the Basic path. Every helper degrades to a safe empty/false.

  private async bitbucketToken(): Promise<string | null> {
    const metas = await this.readConnectionIndex();
    const bb = metas.find((m) => m.forge === "bitbucket");
    const id = bb?.id ?? "bitbucket:bitbucket.org";
    return this.secretStore.get(`${SECRET_PREFIX}${id}`);
  }

  private bbRepo(owner: string, name: string): string {
    return `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  private async bbJson<T>(
    pathAndQuery: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ): Promise<T | null> {
    const token = await this.bitbucketToken();
    if (!token) return null;
    try {
      const res = await fetch(`${BITBUCKET_API}${pathAndQuery}`, {
        ...init,
        signal: AbortSignal.timeout(BB_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) return null;
      const text = await res.text();
      return schema.parse(text ? JSON.parse(text) : {});
    } catch {
      return null;
    }
  }

  private async bbText(pathAndQuery: string): Promise<string | null> {
    const token = await this.bitbucketToken();
    if (!token) return null;
    try {
      const res = await fetch(`${BITBUCKET_API}${pathAndQuery}`, {
        signal: AbortSignal.timeout(BB_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  /** POST/PUT for a side effect; resolve true on a 2xx, false on any failure. */
  private async bbSend(method: string, pathAndQuery: string, body?: unknown): Promise<boolean> {
    const token = await this.bitbucketToken();
    if (!token) return false;
    try {
      const res = await fetch(`${BITBUCKET_API}${pathAndQuery}`, {
        method,
        signal: AbortSignal.timeout(BB_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Probe the token's account label via GET /2.0/user; null on any failure. */
  private async bitbucketAccount(): Promise<string | null> {
    const res = await this.bbJson(
      "/user",
      z.object({
        username: z.string().optional(),
        nickname: z.string().optional(),
        display_name: z.string().optional(),
      }),
    );
    return res?.username ?? res?.nickname ?? res?.display_name ?? null;
  }

  async listBitbucketRepos(input: { query?: string; limit?: number }): Promise<ForgeRepo[]> {
    const limit = Math.min(input.limit ?? 50, 100);
    const res = await this.bbJson(
      `/repositories?role=member&sort=-updated_on&pagelen=${limit}`,
      bbPaged(BbRepoSchema),
    );
    if (!res) return [];
    const query = input.query?.trim().toLowerCase();
    const connectionId = await this.bitbucketConnectionId();
    return res.values
      .filter((r) => !query || r.full_name.toLowerCase().includes(query))
      .map((r): ForgeRepo => {
        const idx = r.full_name.indexOf("/");
        const owner = idx >= 0 ? r.full_name.slice(0, idx) : "";
        const name = idx >= 0 ? r.full_name.slice(idx + 1) : r.full_name;
        return {
          forge: "bitbucket",
          connectionId,
          // The repo's workspace/owner is the cheapest per-repo account label.
          account: owner || undefined,
          owner,
          name,
          description: r.description ?? null,
          defaultBranch: r.mainbranch?.name ?? null,
          visibility:
            r.is_private === true ? "private" : r.is_private === false ? "public" : "unknown",
          updatedAt_ms: isoToMs(r.updated_on),
          url: r.links?.html?.href ?? "",
        };
      });
  }

  async listBitbucketChangeRequests(input: {
    owner: string;
    name: string;
    state?: "open" | "draft" | "merged" | "closed" | "all";
    limit?: number;
  }): Promise<ForgeChangeRequestSummary[]> {
    const base = this.bbRepo(input.owner, input.name);
    const limit = Math.min(input.limit ?? 50, 50);
    // Bitbucket PR states: OPEN|MERGED|DECLINED|SUPERSEDED (the query repeats `state`).
    const states =
      input.state === "merged"
        ? ["MERGED"]
        : input.state === "closed"
          ? ["DECLINED", "SUPERSEDED"]
          : input.state === "all"
            ? ["OPEN", "MERGED", "DECLINED"]
            : ["OPEN"];
    const stateQs = states.map((s) => `state=${s}`).join("&");
    const res = await this.bbJson(
      `${base}/pullrequests?${stateQs}&pagelen=${limit}`,
      bbPaged(BbPrSchema),
    );
    if (!res) return [];
    return res.values
      .filter((r) => (input.state === "draft" ? r.draft === true : true))
      .map(
        (r): ForgeChangeRequestSummary => ({
          number: r.id,
          title: r.title,
          url: r.links?.html?.href ?? "",
          state: bbPrState(r.state, r.draft),
          authorLogin: r.author?.nickname ?? r.author?.display_name ?? null,
          headRef: r.source?.branch?.name,
          baseRef: r.destination?.branch?.name,
          labels: [],
          reviewDecision: null,
          checksStatus: "none",
          updatedAt_ms: isoToMs(r.updated_on),
        }),
      );
  }

  async getBitbucketChangeRequestFiles(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<{ files: ForgeChangeRequestFile[]; truncated: boolean }> {
    const base = this.bbRepo(input.owner, input.name);
    const stat = await this.bbJson(
      `${base}/pullrequests/${input.number}/diffstat?pagelen=500`,
      bbPaged(BbDiffstatSchema),
    );
    if (!stat) return { files: [], truncated: false };
    const patchByPath = splitUnifiedDiff(
      await this.bbText(`${base}/pullrequests/${input.number}/diff`),
    );
    const files = stat.values.map((d): ForgeChangeRequestFile => {
      const p = d.new?.path ?? d.old?.path ?? "";
      return {
        path: p,
        previousPath: d.status.toLowerCase() === "renamed" ? (d.old?.path ?? null) : null,
        status: bbFileStatus(d.status),
        additions: d.lines_added ?? 0,
        deletions: d.lines_removed ?? 0,
        patch: patchByPath.get(p) ?? null,
      };
    });
    return { files, truncated: false };
  }

  async listBitbucketBranches(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeBranch[]> {
    const base = this.bbRepo(input.owner, input.name);
    const [repo, res] = await Promise.all([
      this.bbJson(
        base,
        z.object({ mainbranch: z.object({ name: z.string() }).nullable().optional() }),
      ),
      this.bbJson(
        `${base}/refs/branches?pagelen=${Math.min(input.limit ?? 100, 100)}`,
        bbPaged(BbBranchSchema),
      ),
    ]);
    if (!res) return [];
    const def = repo?.mainbranch?.name;
    return res.values.map(
      (b): ForgeBranch => ({
        name: b.name,
        isDefault: def ? b.name === def : undefined,
        commitSha: b.target?.hash ?? null,
        protected: undefined, // branch-restriction lookups are a separate paginated API
      }),
    );
  }

  async listBitbucketCommits(input: {
    owner: string;
    name: string;
    ref?: string;
    limit?: number;
  }): Promise<ForgeCommit[]> {
    const base = this.bbRepo(input.owner, input.name);
    const p = input.ref ? `${base}/commits/${encodeURIComponent(input.ref)}` : `${base}/commits`;
    const res = await this.bbJson(
      `${p}?pagelen=${Math.min(input.limit ?? 50, 100)}`,
      bbPaged(BbCommitSchema),
    );
    if (!res) return [];
    return res.values.map(bbCommit);
  }

  async compareBitbucketCommits(input: {
    owner: string;
    name: string;
    base: string;
    head: string;
  }): Promise<{ files: ForgeChangeRequestFile[]; commits: ForgeCommit[] }> {
    const base = this.bbRepo(input.owner, input.name);
    const spec = `${encodeURIComponent(input.head)}..${encodeURIComponent(input.base)}`;
    const [diffText, commitsRes] = await Promise.all([
      this.bbText(`${base}/diff/${spec}`),
      this.bbJson(
        `${base}/commits/${encodeURIComponent(input.head)}?exclude=${encodeURIComponent(input.base)}&pagelen=100`,
        bbPaged(BbCommitSchema),
      ),
    ]);
    return {
      files: parseDiffToFiles(diffText),
      commits: (commitsRes?.values ?? []).map(bbCommit),
    };
  }

  async listBitbucketTree(input: {
    owner: string;
    name: string;
    ref: string;
    path: string;
  }): Promise<ForgeTreeEntry[]> {
    const base = this.bbRepo(input.owner, input.name);
    const enc = encodePath(input.path);
    // A trailing slash requests a directory listing; root = /src/{ref}/.
    // Best-effort: only the first page is read (the `next` cursor is ignored).
    const res = await this.bbJson(
      `${base}/src/${encodeURIComponent(input.ref)}/${enc}${enc ? "/" : ""}`,
      z.object({
        values: z.array(
          z.object({ path: z.string(), type: z.string(), size: z.number().optional() }),
        ),
      }),
    );
    if (!res) return [];
    return res.values.map((e): ForgeTreeEntry => {
      const seg = e.path.split("/");
      return {
        name: seg[seg.length - 1] ?? e.path,
        path: e.path,
        type: e.type === "commit_directory" ? "dir" : "file",
        size: e.size ?? null,
      };
    });
  }

  async getBitbucketFile(input: {
    owner: string;
    name: string;
    ref: string;
    path: string;
  }): Promise<ForgeFileResult> {
    // Bitbucket's /src/{ref}/{path} returns RAW bytes for a file (not JSON), so read
    // the arrayBuffer directly rather than via bbJson/bbText.
    const token = await this.bitbucketToken();
    const miss: ForgeFileResult = {
      path: input.path,
      content: null,
      isBinary: false,
      size: null,
      truncated: false,
    };
    if (!token) return miss;
    try {
      const res = await fetch(
        `${BITBUCKET_API}${this.bbRepo(input.owner, input.name)}/src/${encodeURIComponent(input.ref)}/${encodePath(input.path)}`,
        {
          signal: AbortSignal.timeout(BB_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) return miss;
      return decodeForgeFile(input.path, Buffer.from(await res.arrayBuffer()));
    } catch {
      return miss;
    }
  }

  async reviewBitbucketChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
    action: ForgeReviewAction;
    body?: string;
  }): Promise<boolean> {
    const pr = `${this.bbRepo(input.owner, input.name)}/pullrequests/${input.number}`;
    if (input.action === "approve") return this.bbSend("POST", `${pr}/approve`);
    if (input.action === "request_changes") return this.bbSend("POST", `${pr}/request-changes`);
    return this.bbSend("POST", `${pr}/comments`, { content: { raw: input.body ?? "" } });
  }

  async mergeBitbucketChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
    method: ForgeMergeMethod;
  }): Promise<boolean> {
    const base = this.bbRepo(input.owner, input.name);
    // Bitbucket has no rebase-merge; map rebase → fast_forward (closest available).
    const strategy =
      input.method === "squash"
        ? "squash"
        : input.method === "rebase"
          ? "fast_forward"
          : "merge_commit";
    return this.bbSend("POST", `${base}/pullrequests/${input.number}/merge`, {
      merge_strategy: strategy,
    });
  }

  async listBitbucketPipelines(input: {
    owner: string;
    name: string;
    ref?: string;
    limit?: number;
  }): Promise<ForgePipelineRun[]> {
    const base = this.bbRepo(input.owner, input.name);
    const res = await this.bbJson(
      `${base}/pipelines/?sort=-created_on&pagelen=${Math.min(input.limit ?? 30, 100)}`,
      bbPaged(BbPipelineSchema),
    );
    if (!res) return [];
    return res.values
      .filter((p) => !input.ref || p.target?.ref_name === input.ref)
      .map(
        (p): ForgePipelineRun => ({
          id: p.uuid,
          name: p.build_number != null ? `Pipeline #${p.build_number}` : "Pipeline",
          status: bbPipelineStatus(p.state?.name, p.state?.result?.name ?? undefined),
          ref: p.target?.ref_name ?? null,
          sha: p.target?.commit?.hash ?? null,
          trigger: p.trigger?.name ?? null,
          actor: null,
          durationSeconds: null,
          createdAt_ms: isoToMs(p.created_on),
          url: p.build_number != null ? bbPipelineUrl(input.owner, input.name, p.build_number) : "",
        }),
      );
  }

  async getBitbucketPipeline(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<ForgePipelineDetail | null> {
    const base = this.bbRepo(input.owner, input.name);
    const uuid = encodeURIComponent(input.runId);
    const [pipe, steps] = await Promise.all([
      this.bbJson(`${base}/pipelines/${uuid}`, BbPipelineSchema),
      this.bbJson(`${base}/pipelines/${uuid}/steps/`, bbPaged(BbStepSchema)),
    ]);
    if (!steps) return null;
    const jobs: ForgePipelineJob[] = steps.values.map((s) => ({
      // The step-log endpoint needs the pipeline uuid AND the step uuid, but the neutral
      // job.log RPC only carries jobId — so encode "pipelineUuid:stepUuid" (uuids have no ":").
      id: `${input.runId}:${s.uuid}`,
      name: s.name ?? "step",
      stage: "steps",
      status: bbPipelineStatus(s.state?.name, s.state?.result?.name ?? undefined),
      durationSeconds:
        s.started_on && s.completed_on
          ? Math.max(0, Math.round((Date.parse(s.completed_on) - Date.parse(s.started_on)) / 1000))
          : null,
      url: null,
    }));
    const status = pipe
      ? bbPipelineStatus(pipe.state?.name, pipe.state?.result?.name ?? undefined)
      : aggregateGlStatus(jobs.map((j) => j.status));
    return {
      id: input.runId,
      status,
      url:
        pipe?.build_number != null
          ? bbPipelineUrl(input.owner, input.name, pipe.build_number)
          : null,
      stages: [{ name: "steps", status, jobs }],
    };
  }

  async getBitbucketJobLog(input: {
    owner: string;
    name: string;
    jobId: string;
  }): Promise<{ log: string; truncated: boolean; running: boolean }> {
    // jobId is "pipelineUuid:stepUuid" (see getBitbucketPipeline).
    const sep = input.jobId.indexOf(":");
    const pipelineUuid = sep >= 0 ? input.jobId.slice(0, sep) : "";
    const stepUuid = sep >= 0 ? input.jobId.slice(sep + 1) : "";
    if (!pipelineUuid || !stepUuid) return { log: "", truncated: false, running: false };
    const base = this.bbRepo(input.owner, input.name);
    const text = await this.bbText(
      `${base}/pipelines/${encodeURIComponent(pipelineUuid)}/steps/${encodeURIComponent(stepUuid)}/log`,
    );
    const MAX = 2 * 1024 * 1024;
    if (text == null) return { log: "", truncated: false, running: false };
    if (text.length > MAX) return { log: text.slice(0, MAX), truncated: true, running: false };
    return { log: text, truncated: false, running: false };
  }

  async cancelBitbucketPipeline(input: {
    owner: string;
    name: string;
    runId: string;
  }): Promise<boolean> {
    const base = this.bbRepo(input.owner, input.name);
    return this.bbSend("POST", `${base}/pipelines/${encodeURIComponent(input.runId)}/stopPipeline`);
  }

  async listBitbucketTags(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeTag[]> {
    const base = this.bbRepo(input.owner, input.name);
    const res = await this.bbJson(
      `${base}/refs/tags?pagelen=${Math.min(input.limit ?? 100, 100)}`,
      bbPaged(BbTagSchema),
    );
    if (!res) return [];
    return res.values.map(
      (t): ForgeTag => ({
        name: t.name,
        commitSha: t.target?.hash ?? null,
        url: t.links?.html?.href ?? null,
      }),
    );
  }

  async listBitbucketReleases(input: {
    owner: string;
    name: string;
    limit?: number;
  }): Promise<ForgeRelease[]> {
    // Bitbucket Cloud has no releases API; synthesize one release per tag (name = tag).
    const tags = await this.listBitbucketTags(input);
    return tags.map(
      (t): ForgeRelease => ({
        id: t.name,
        tagName: t.name,
        name: t.name,
        isDraft: false,
        isPrerelease: false,
        publishedAt_ms: null,
        url: t.url ?? "",
        assets: [],
      }),
    );
  }

  async listBitbucketIssues(input: {
    owner: string;
    name: string;
    state?: "open" | "closed" | "all";
    limit?: number;
  }): Promise<ForgeIssue[]> {
    const base = this.bbRepo(input.owner, input.name);
    // The issue tracker may be disabled → the endpoint 404s → bbJson returns null → [].
    const res = await this.bbJson(
      `${base}/issues?pagelen=${Math.min(input.limit ?? 50, 50)}&sort=-updated_on`,
      bbPaged(BbIssueSchema),
    );
    if (!res) return [];
    return res.values
      .map(
        (i): ForgeIssue => ({
          number: i.id,
          title: i.title,
          url: i.links?.html?.href ?? "",
          state: bbIssueState(i.state),
          authorLogin: i.reporter?.nickname ?? null,
          labels: [],
          updatedAt_ms: isoToMs(i.updated_on),
        }),
      )
      .filter((i) => (input.state && input.state !== "all" ? i.state === input.state : true));
  }

  async createBitbucketIssue(input: {
    owner: string;
    name: string;
    title: string;
    body?: string;
  }): Promise<ForgeIssue | null> {
    const base = this.bbRepo(input.owner, input.name);
    const payload: Record<string, unknown> = { title: input.title };
    if (input.body) payload.content = { raw: input.body };
    const res = await this.bbJson(`${base}/issues`, BbIssueSchema, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    });
    if (!res) return null;
    return {
      number: res.id,
      title: res.title,
      url: res.links?.html?.href ?? "",
      state: bbIssueState(res.state),
      authorLogin: res.reporter?.nickname ?? null,
      labels: [],
      updatedAt_ms: isoToMs(res.updated_on),
    };
  }

  async commentBitbucketIssue(input: {
    owner: string;
    name: string;
    number: number;
    body: string;
  }): Promise<boolean> {
    const base = this.bbRepo(input.owner, input.name);
    return this.bbSend("POST", `${base}/issues/${input.number}/comments`, {
      content: { raw: input.body },
    });
  }

  async closeBitbucketIssue(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<boolean> {
    const base = this.bbRepo(input.owner, input.name);
    return this.bbSend("PUT", `${base}/issues/${input.number}`, { state: "closed" });
  }

  // ===== Milestone D — create/close change request · create/get release ==========

  async createChangeRequest(input: {
    owner: string;
    name: string;
    base: string;
    head: string;
    title: string;
    body?: string;
    draft?: boolean;
  }): Promise<ForgeCreateChangeRequestResult> {
    const gh = await this.ghPath();
    if (!gh) return { number: null, url: null, error: "gh CLI not found" };
    const args = [
      "pr",
      "create",
      "--repo",
      `${input.owner}/${input.name}`,
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body ?? "",
    ];
    if (input.draft) args.push("--draft");
    try {
      const res = await execCommand(gh, args, { timeout: GH_TIMEOUT_MS });
      // `gh pr create` prints the created PR URL as the last non-empty stdout line.
      const url = lastNonEmptyLine(res.stdout);
      const m = url?.match(/\/pull\/(\d+)/);
      return { number: m ? Number(m[1]) : null, url: url ?? null };
    } catch (error) {
      return { number: null, url: null, error: shortForgeError(error) };
    }
  }

  async createGitLabChangeRequest(input: {
    owner: string;
    name: string;
    base: string;
    head: string;
    title: string;
    body?: string;
    draft?: boolean;
  }): Promise<ForgeCreateChangeRequestResult> {
    const glab = await this.glabPath();
    if (!glab) return { number: null, url: null, error: "glab CLI not found" };
    const args = [
      "mr",
      "create",
      "-R",
      `${input.owner}/${input.name}`,
      "--source-branch",
      input.head,
      "--target-branch",
      input.base,
      "--title",
      input.title,
      // --description is required to avoid the interactive editor; pass a space when empty.
      "--description",
      input.body && input.body.length > 0 ? input.body : " ",
      "--yes",
    ];
    if (input.draft) args.push("--draft");
    try {
      const res = await execCommand(glab, args, { timeout: GH_TIMEOUT_MS });
      const url = lastMatchingLine(res.stdout, /\/merge_requests\/\d+/);
      const m = url?.match(/\/merge_requests\/(\d+)/);
      return { number: m ? Number(m[1]) : null, url: url ?? null };
    } catch (error) {
      return { number: null, url: null, error: shortForgeError(error) };
    }
  }

  async createBitbucketChangeRequest(input: {
    owner: string;
    name: string;
    base: string;
    head: string;
    title: string;
    body?: string;
  }): Promise<ForgeCreateChangeRequestResult> {
    const base = this.bbRepo(input.owner, input.name);
    const body: Record<string, unknown> = {
      title: input.title,
      source: { branch: { name: input.head } },
      destination: { branch: { name: input.base } },
    };
    if (input.body) body.description = input.body;
    const res = await this.bbJson(
      `${base}/pullrequests`,
      z.object({
        id: z.number(),
        links: z
          .object({ html: z.object({ href: z.string() }).nullable().optional() })
          .nullable()
          .optional(),
      }),
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      },
    );
    if (!res) return { number: null, url: null, error: "bitbucket request failed" };
    return { number: res.id, url: res.links?.html?.href ?? null };
  }

  async closeChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<boolean> {
    return this.ghOk([
      "pr",
      "close",
      String(input.number),
      "--repo",
      `${input.owner}/${input.name}`,
    ]);
  }

  async closeGitLabChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<boolean> {
    return this.glabOk(["mr", "close", String(input.number), "-R", `${input.owner}/${input.name}`]);
  }

  async closeBitbucketChangeRequest(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<boolean> {
    const base = this.bbRepo(input.owner, input.name);
    return this.bbSend("POST", `${base}/pullrequests/${input.number}/decline`);
  }

  /** Read one gh release back as a neutral ForgeRelease (used by create + get). */
  private async ghReleaseView(
    owner: string,
    name: string,
    tagName: string,
  ): Promise<ForgeRelease | null> {
    const r = await this.ghJson(
      [
        "release",
        "view",
        tagName,
        "--repo",
        `${owner}/${name}`,
        "--json",
        "tagName,name,body,isDraft,isPrerelease,publishedAt,url,assets",
      ],
      z.object({
        tagName: z.string(),
        name: z.string().nullable().optional(),
        body: z.string().nullable().optional(),
        isDraft: z.boolean().optional(),
        isPrerelease: z.boolean().optional(),
        publishedAt: z.string().nullable().optional(),
        url: z.string(),
        assets: z
          .array(
            z.object({
              name: z.string(),
              url: z.string().optional(),
              size: z.number().optional(),
            }),
          )
          .optional()
          .default([]),
      }),
    );
    if (!r) return null;
    return {
      id: r.tagName,
      tagName: r.tagName,
      name: r.name ?? null,
      body: r.body ?? null,
      isDraft: r.isDraft ?? false,
      isPrerelease: r.isPrerelease ?? false,
      publishedAt_ms: isoToMs(r.publishedAt ?? undefined),
      url: r.url,
      assets: r.assets.map(
        (a): ForgeReleaseAsset => ({ name: a.name, url: a.url ?? "", sizeBytes: a.size ?? null }),
      ),
    };
  }

  async createRelease(input: {
    owner: string;
    name: string;
    tagName: string;
    releaseName?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    target?: string;
  }): Promise<ForgeCreateReleaseResult> {
    const gh = await this.ghPath();
    if (!gh) return { release: null, error: "gh CLI not found" };
    const repo = `${input.owner}/${input.name}`;
    const args = [
      "release",
      "create",
      input.tagName,
      "--repo",
      repo,
      "--title",
      input.releaseName ?? input.tagName,
      "--notes",
      input.body ?? "",
    ];
    if (input.draft) args.push("--draft");
    if (input.prerelease) args.push("--prerelease");
    if (input.target) args.push("--target", input.target);
    try {
      await execCommand(gh, args, { timeout: GH_TIMEOUT_MS });
    } catch (error) {
      return { release: null, error: shortForgeError(error) };
    }
    return { release: await this.ghReleaseView(input.owner, input.name, input.tagName) };
  }

  async getRelease(input: {
    owner: string;
    name: string;
    tagName: string;
  }): Promise<ForgeRelease | null> {
    return this.ghReleaseView(input.owner, input.name, input.tagName);
  }

  /** Read one glab release back via the REST API as a neutral ForgeRelease. */
  private async glabReleaseView(
    owner: string,
    name: string,
    tagName: string,
  ): Promise<ForgeRelease | null> {
    const enc = glProjectId(owner, name);
    const r = await this.glabJson(
      ["api", `projects/${enc}/releases/${encodeURIComponent(tagName)}`],
      z.object({
        tag_name: z.string(),
        name: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        released_at: z.string().nullable().optional(),
        created_at: z.string().nullable().optional(),
        upcoming_release: z.boolean().optional(),
        _links: z.object({ self: z.string().optional() }).nullable().optional(),
        assets: z
          .object({
            links: z.array(z.object({ name: z.string(), url: z.string() })).optional(),
          })
          .nullable()
          .optional(),
      }),
    );
    if (!r) return null;
    return {
      id: r.tag_name,
      tagName: r.tag_name,
      name: r.name ?? null,
      body: r.description ?? null,
      isDraft: false, // GitLab has no draft-release concept
      isPrerelease: r.upcoming_release ?? false,
      publishedAt_ms: isoToMs(r.released_at ?? r.created_at ?? undefined),
      url: r._links?.self ?? "",
      assets: (r.assets?.links ?? []).map(
        (a): ForgeReleaseAsset => ({ name: a.name, url: a.url, sizeBytes: null }),
      ),
    };
  }

  async createGitLabRelease(input: {
    owner: string;
    name: string;
    tagName: string;
    releaseName?: string;
    body?: string;
    target?: string;
  }): Promise<ForgeCreateReleaseResult> {
    const glab = await this.glabPath();
    if (!glab) return { release: null, error: "glab CLI not found" };
    const args = ["release", "create", input.tagName, "-R", `${input.owner}/${input.name}`];
    if (input.releaseName) args.push("--name", input.releaseName);
    args.push("--notes", input.body ?? "");
    if (input.target) args.push("--ref", input.target);
    try {
      await execCommand(glab, args, { timeout: GH_TIMEOUT_MS });
    } catch (error) {
      return { release: null, error: shortForgeError(error) };
    }
    return { release: await this.glabReleaseView(input.owner, input.name, input.tagName) };
  }

  async getGitLabRelease(input: {
    owner: string;
    name: string;
    tagName: string;
  }): Promise<ForgeRelease | null> {
    return this.glabReleaseView(input.owner, input.name, input.tagName);
  }

  async createBitbucketRelease(_input: {
    owner: string;
    name: string;
    tagName: string;
  }): Promise<ForgeCreateReleaseResult> {
    // Bitbucket Cloud has no releases API.
    return { release: null, error: "unsupported" };
  }

  async getBitbucketRelease(input: {
    owner: string;
    name: string;
    tagName: string;
  }): Promise<ForgeRelease | null> {
    // No releases API → synthesize a release from the tag (name = tag, body = null),
    // matching listBitbucketReleases.
    const base = this.bbRepo(input.owner, input.name);
    const t = await this.bbJson(
      `${base}/refs/tags/${encodeURIComponent(input.tagName)}`,
      BbTagSchema,
    );
    if (!t) return null;
    return {
      id: t.name,
      tagName: t.name,
      name: t.name,
      body: null,
      isDraft: false,
      isPrerelease: false,
      publishedAt_ms: null,
      url: t.links?.html?.href ?? "",
      assets: [],
    };
  }
}

/** Map GitHub run status+conclusion onto the neutral pipeline status enum. */
function ghRunStatus(
  status: string | undefined,
  conclusion: string | null | undefined,
): ForgePipelineRun["status"] {
  const c = (conclusion ?? "").toLowerCase();
  if (c) {
    if (c === "success") return "success";
    if (c === "failure" || c === "timed_out" || c === "startup_failure") return "failed";
    if (c === "cancelled") return "canceled";
    if (c === "skipped") return "skipped";
    if (c === "action_required" || c === "neutral") return "manual";
    return "unknown";
  }
  const s = (status ?? "").toLowerCase();
  if (s === "in_progress") return "running";
  if (s === "queued" || s === "waiting" || s === "pending" || s === "requested") return "pending";
  if (s === "completed") return "success";
  return "unknown";
}

/** Result of a create-change-request across providers. */
interface ForgeCreateChangeRequestResult {
  number: number | null;
  url: string | null;
  error?: string | null;
}
/** Result of a create-release across providers. */
interface ForgeCreateReleaseResult {
  release: ForgeRelease | null;
  error?: string | null;
}

/** Extract a short one-line error from a rejected execCommand (prefer stderr). */
function shortForgeError(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const raw =
    typeof stderr === "string" && stderr.trim().length > 0
      ? stderr
      : ((error as { message?: unknown })?.message ?? "");
  const line = String(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "command failed").slice(0, 500);
}

/** Last non-empty line of stdout (where `gh pr create` prints the PR URL). */
function lastNonEmptyLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

/** Last stdout line matching a pattern (glab prints extra lines around the MR URL). */
function lastMatchingLine(text: string, pattern: RegExp): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => pattern.test(l));
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

export class ForgeHubSession {
  private readonly service: ForgeHubService;
  /** Device-flow sign-in driver; held on the session so cancel reaches the same
   *  instance (and thus the same pty map) that started the login. */
  private readonly deviceLogin = new ForgeDeviceLogin();
  constructor(private readonly options: ForgeHubSessionOptions) {
    this.service = new ForgeHubService(options.secretStore, options.secretStoreDir);
  }

  async handle(msg: ForgeHubInbound): Promise<void> {
    try {
      switch (msg.type) {
        case "forge.connection.list.request": {
          const connections = await this.service.listConnections();
          this.emit({
            type: "forge.connection.list.response",
            payload: { connections, requestId: msg.requestId },
          });
          return;
        }
        case "forge.connection.add.request": {
          const connection = await this.service.addConnection({
            forge: msg.forge,
            host: msg.host,
            method: msg.method,
            token: msg.token,
          });
          this.emit({
            type: "forge.connection.add.response",
            payload: { connection, requestId: msg.requestId },
          });
          return;
        }
        case "forge.connection.remove.request": {
          const removed = await this.service.removeConnection(msg.connectionId);
          this.emit({
            type: "forge.connection.remove.response",
            payload: { removed, requestId: msg.requestId },
          });
          return;
        }
        case "forge.repo.list.request": {
          const repos = await this.service.listRepos({
            query: msg.query,
            limit: msg.limit,
            connectionId: msg.connectionId,
          });
          this.emit({
            type: "forge.repo.list.response",
            payload: { repos, requestId: msg.requestId },
          });
          return;
        }
        case "forge.change_request.list.request": {
          const changeRequests =
            msg.repo.forge === "github"
              ? await this.service.listChangeRequests({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  state: msg.state,
                  limit: msg.limit,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabChangeRequests({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    state: msg.state,
                    limit: msg.limit,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketChangeRequests({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      state: msg.state,
                      limit: msg.limit,
                    })
                  : [];
          this.emit({
            type: "forge.change_request.list.response",
            payload: { changeRequests, requestId: msg.requestId },
          });
          return;
        }
        case "forge.change_request.files.request": {
          const { files, truncated } =
            msg.repo.forge === "github"
              ? await this.service.getChangeRequestFiles({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  number: msg.number,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.getGitLabChangeRequestFiles({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    number: msg.number,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.getBitbucketChangeRequestFiles({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      number: msg.number,
                    })
                  : { files: [], truncated: false };
          this.emit({
            type: "forge.change_request.files.response",
            payload: { files, truncated, requestId: msg.requestId },
          });
          return;
        }
        // ---- Milestone B (GitHub via gh; other forges return empty for now) ----
        case "forge.branch.list.request": {
          const branches =
            msg.repo.forge === "github"
              ? await this.service.listBranches({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  limit: msg.limit,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabBranches({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    limit: msg.limit,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketBranches({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      limit: msg.limit,
                    })
                  : [];
          this.emit({
            type: "forge.branch.list.response",
            payload: { branches, requestId: msg.requestId },
          });
          return;
        }
        case "forge.commit.list.request": {
          const commits =
            msg.repo.forge === "github"
              ? await this.service.listCommits({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  ref: msg.ref,
                  limit: msg.limit,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabCommits({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    ref: msg.ref,
                    limit: msg.limit,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketCommits({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      ref: msg.ref,
                      limit: msg.limit,
                    })
                  : [];
          this.emit({
            type: "forge.commit.list.response",
            payload: { commits, requestId: msg.requestId },
          });
          return;
        }
        case "forge.commit.compare.request": {
          const res =
            msg.repo.forge === "github"
              ? await this.service.compareCommits({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  base: msg.base,
                  head: msg.head,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.compareGitLabCommits({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    base: msg.base,
                    head: msg.head,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.compareBitbucketCommits({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      base: msg.base,
                      head: msg.head,
                    })
                  : { files: [], commits: [] };
          this.emit({
            type: "forge.commit.compare.response",
            payload: { files: res.files, commits: res.commits, requestId: msg.requestId },
          });
          return;
        }
        case "forge.tree.list.request": {
          const entries =
            msg.repo.forge === "github"
              ? await this.service.listTree({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  ref: msg.ref,
                  path: msg.path,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabTree({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    ref: msg.ref,
                    path: msg.path,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketTree({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      ref: msg.ref,
                      path: msg.path,
                    })
                  : [];
          this.emit({
            type: "forge.tree.list.response",
            payload: { entries, requestId: msg.requestId },
          });
          return;
        }
        case "forge.file.get.request": {
          const file =
            msg.repo.forge === "github"
              ? await this.service.getFile({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  ref: msg.ref,
                  path: msg.path,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.getGitLabFile({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    ref: msg.ref,
                    path: msg.path,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.getBitbucketFile({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      ref: msg.ref,
                      path: msg.path,
                    })
                  : {
                      path: msg.path,
                      content: null,
                      isBinary: false,
                      size: null,
                      truncated: false,
                    };
          this.emit({
            type: "forge.file.get.response",
            payload: {
              path: file.path,
              content: file.content,
              isBinary: file.isBinary,
              size: file.size,
              truncated: file.truncated,
              requestId: msg.requestId,
            },
          });
          return;
        }
        case "forge.change_request.review.request": {
          const ok =
            msg.repo.forge === "github"
              ? await this.service.reviewChangeRequest({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  number: msg.number,
                  action: msg.action,
                  body: msg.body,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.reviewGitLabChangeRequest({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    number: msg.number,
                    action: msg.action,
                    body: msg.body,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.reviewBitbucketChangeRequest({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      number: msg.number,
                      action: msg.action,
                      body: msg.body,
                    })
                  : false;
          this.emit({
            type: "forge.change_request.review.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        case "forge.change_request.merge.request": {
          const merged =
            msg.repo.forge === "github"
              ? await this.service.mergeChangeRequest({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  number: msg.number,
                  method: msg.method,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.mergeGitLabChangeRequest({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    number: msg.number,
                    method: msg.method,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.mergeBitbucketChangeRequest({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      number: msg.number,
                      method: msg.method,
                    })
                  : false;
          this.emit({
            type: "forge.change_request.merge.response",
            payload: { merged, requestId: msg.requestId },
          });
          return;
        }
        case "forge.pipeline.list.request": {
          const runs =
            msg.repo.forge === "github"
              ? await this.service.listPipelines({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  ref: msg.ref,
                  limit: msg.limit,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabPipelines({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    ref: msg.ref,
                    limit: msg.limit,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketPipelines({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      ref: msg.ref,
                      limit: msg.limit,
                    })
                  : [];
          this.emit({
            type: "forge.pipeline.list.response",
            payload: { runs, requestId: msg.requestId },
          });
          return;
        }
        case "forge.pipeline.get.request": {
          const pipeline =
            msg.repo.forge === "github"
              ? await this.service.getPipeline({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  runId: msg.runId,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.getGitLabPipeline({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    runId: msg.runId,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.getBitbucketPipeline({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      runId: msg.runId,
                    })
                  : null;
          this.emit({
            type: "forge.pipeline.get.response",
            payload: { pipeline, requestId: msg.requestId },
          });
          return;
        }
        case "forge.job.log.request": {
          const res =
            msg.repo.forge === "github"
              ? await this.service.getJobLog({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  jobId: msg.jobId,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.getGitLabJobLog({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    jobId: msg.jobId,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.getBitbucketJobLog({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      jobId: msg.jobId,
                    })
                  : { log: "", truncated: false, running: false };
          this.emit({
            type: "forge.job.log.response",
            payload: {
              log: res.log,
              truncated: res.truncated,
              running: res.running,
              requestId: msg.requestId,
            },
          });
          return;
        }
        case "forge.pipeline.rerun.request": {
          const ok =
            msg.repo.forge === "github"
              ? await this.service.rerunPipeline({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  runId: msg.runId,
                  onlyFailed: msg.onlyFailed,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.rerunGitLabPipeline({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    runId: msg.runId,
                  })
                : false;
          this.emit({
            type: "forge.pipeline.rerun.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        case "forge.pipeline.cancel.request": {
          const ok =
            msg.repo.forge === "github"
              ? await this.service.cancelPipeline({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  runId: msg.runId,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.cancelGitLabPipeline({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    runId: msg.runId,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.cancelBitbucketPipeline({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      runId: msg.runId,
                    })
                  : false;
          this.emit({
            type: "forge.pipeline.cancel.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        case "forge.job.play.request": {
          // GitHub has no per-job "play" (manual gates are environment approvals) → ok:false.
          // GitLab plays a manual job via POST /jobs/{id}/play.
          const ok =
            msg.repo.forge === "gitlab"
              ? await this.service.playGitLabJob({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  jobId: msg.jobId,
                })
              : false;
          this.emit({
            type: "forge.job.play.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        // ---- Milestone C (auto-merge · artifacts · releases · tags · issues) ----
        case "forge.change_request.set_auto_merge.request": {
          // Bitbucket has no auto-merge API → report disabled.
          const enabled =
            msg.repo.forge === "github"
              ? await this.service.setAutoMerge({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  number: msg.number,
                  enabled: msg.enabled,
                  method: msg.method,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.setGitLabAutoMerge({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    number: msg.number,
                    enabled: msg.enabled,
                  })
                : false;
          this.emit({
            type: "forge.change_request.set_auto_merge.response",
            payload: { enabled, requestId: msg.requestId },
          });
          return;
        }
        case "forge.artifact.list.request": {
          // GitHub: workflow-run artifacts. GitLab: job-scoped (best-effort). Bitbucket:
          // no run-scoped artifacts API → empty.
          const artifacts =
            msg.repo.forge === "github"
              ? await this.service.listArtifacts({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  runId: msg.runId,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabArtifacts({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    runId: msg.runId,
                  })
                : [];
          this.emit({
            type: "forge.artifact.list.response",
            payload: { artifacts, requestId: msg.requestId },
          });
          return;
        }
        case "forge.artifact.download.request": {
          // Only GitHub exposes a per-artifact download URL; others → null.
          const url =
            msg.repo.forge === "github"
              ? await this.service.downloadArtifact({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  artifactId: msg.artifactId,
                })
              : null;
          this.emit({
            type: "forge.artifact.download.response",
            payload: { url, requestId: msg.requestId },
          });
          return;
        }
        case "forge.release.list.request": {
          // Bitbucket has no releases API → synthesized from tags.
          const releases =
            msg.repo.forge === "github"
              ? await this.service.listReleases({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  limit: msg.limit,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabReleases({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    limit: msg.limit,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketReleases({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      limit: msg.limit,
                    })
                  : [];
          this.emit({
            type: "forge.release.list.response",
            payload: { releases, requestId: msg.requestId },
          });
          return;
        }
        case "forge.tag.list.request": {
          const tags =
            msg.repo.forge === "github"
              ? await this.service.listTags({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  limit: msg.limit,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabTags({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    limit: msg.limit,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketTags({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      limit: msg.limit,
                    })
                  : [];
          this.emit({
            type: "forge.tag.list.response",
            payload: { tags, requestId: msg.requestId },
          });
          return;
        }
        case "forge.issue.list.request": {
          const issues =
            msg.repo.forge === "github"
              ? await this.service.listIssues({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  state: msg.state,
                  limit: msg.limit,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.listGitLabIssues({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    state: msg.state,
                    limit: msg.limit,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.listBitbucketIssues({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      state: msg.state,
                      limit: msg.limit,
                    })
                  : [];
          this.emit({
            type: "forge.issue.list.response",
            payload: { issues, requestId: msg.requestId },
          });
          return;
        }
        case "forge.issue.create.request": {
          const issue =
            msg.repo.forge === "github"
              ? await this.service.createIssue({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  title: msg.title,
                  body: msg.body,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.createGitLabIssue({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    title: msg.title,
                    body: msg.body,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.createBitbucketIssue({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      title: msg.title,
                      body: msg.body,
                    })
                  : null;
          this.emit({
            type: "forge.issue.create.response",
            payload: { issue, requestId: msg.requestId },
          });
          return;
        }
        case "forge.issue.comment.request": {
          const ok =
            msg.repo.forge === "github"
              ? await this.service.commentIssue({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  number: msg.number,
                  body: msg.body,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.commentGitLabIssue({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    number: msg.number,
                    body: msg.body,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.commentBitbucketIssue({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      number: msg.number,
                      body: msg.body,
                    })
                  : false;
          this.emit({
            type: "forge.issue.comment.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        case "forge.issue.close.request": {
          const ok =
            msg.repo.forge === "github"
              ? await this.service.closeIssue({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  number: msg.number,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.closeGitLabIssue({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    number: msg.number,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.closeBitbucketIssue({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      number: msg.number,
                    })
                  : false;
          this.emit({
            type: "forge.issue.close.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        case "forge.change_request.create.request": {
          const result =
            msg.repo.forge === "github"
              ? await this.service.createChangeRequest({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  base: msg.base,
                  head: msg.head,
                  title: msg.title,
                  body: msg.body,
                  draft: msg.draft,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.createGitLabChangeRequest({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    base: msg.base,
                    head: msg.head,
                    title: msg.title,
                    body: msg.body,
                    draft: msg.draft,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.createBitbucketChangeRequest({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      base: msg.base,
                      head: msg.head,
                      title: msg.title,
                      body: msg.body,
                    })
                  : { number: null, url: null, error: "unsupported forge" };
          this.emit({
            type: "forge.change_request.create.response",
            payload: {
              number: result.number,
              url: result.url,
              error: result.error ?? null,
              requestId: msg.requestId,
            },
          });
          return;
        }
        case "forge.change_request.close.request": {
          const ok =
            msg.repo.forge === "github"
              ? await this.service.closeChangeRequest({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  number: msg.number,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.closeGitLabChangeRequest({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    number: msg.number,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.closeBitbucketChangeRequest({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      number: msg.number,
                    })
                  : false;
          this.emit({
            type: "forge.change_request.close.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        case "forge.release.create.request": {
          const result =
            msg.repo.forge === "github"
              ? await this.service.createRelease({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  tagName: msg.tagName,
                  releaseName: msg.name,
                  body: msg.body,
                  draft: msg.draft,
                  prerelease: msg.prerelease,
                  target: msg.target,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.createGitLabRelease({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    tagName: msg.tagName,
                    releaseName: msg.name,
                    body: msg.body,
                    target: msg.target,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.createBitbucketRelease({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      tagName: msg.tagName,
                    })
                  : { release: null, error: "unsupported forge" };
          this.emit({
            type: "forge.release.create.response",
            payload: {
              release: result.release,
              error: result.error ?? null,
              requestId: msg.requestId,
            },
          });
          return;
        }
        case "forge.release.get.request": {
          const release =
            msg.repo.forge === "github"
              ? await this.service.getRelease({
                  owner: msg.repo.owner,
                  name: msg.repo.name,
                  tagName: msg.tagName,
                })
              : msg.repo.forge === "gitlab"
                ? await this.service.getGitLabRelease({
                    owner: msg.repo.owner,
                    name: msg.repo.name,
                    tagName: msg.tagName,
                  })
                : msg.repo.forge === "bitbucket"
                  ? await this.service.getBitbucketRelease({
                      owner: msg.repo.owner,
                      name: msg.repo.name,
                      tagName: msg.tagName,
                    })
                  : null;
          this.emit({
            type: "forge.release.get.response",
            payload: { release, requestId: msg.requestId },
          });
          return;
        }
        // ---- CLI detect + guided auto-install (host-level; dispatch by `forge`) --
        case "forge.cli.status.request": {
          const status = await detectCliStatus(msg.forge);
          this.emit({
            type: "forge.cli.status.response",
            payload: {
              binary: status.binary,
              installed: status.installed,
              version: status.version,
              path: status.path,
              packageManager: status.packageManager,
              canAutoInstall: status.canAutoInstall,
              requestId: msg.requestId,
            },
          });
          return;
        }
        case "forge.cli.install.request": {
          const requestId = msg.requestId;
          const result = await installCli(msg.forge, (progress) => {
            // Progress is FLAT (requestId at top level, no payload wrapper).
            this.emit({
              type: "forge.cli.install.progress",
              requestId,
              phase: progress.phase,
              percent: progress.percent ?? null,
              line: progress.line ?? null,
            });
          });
          this.emit({
            type: "forge.cli.install.response",
            payload: {
              ok: result.ok,
              binary: result.binary,
              version: result.version ?? null,
              packageManager: result.packageManager ?? null,
              error: result.error ?? null,
              requestId,
            },
          });
          return;
        }
        // ---- app-driven device-flow sign-in (host-level; dispatch by `forge`) ---
        case "forge.connection.login.request": {
          const requestId = msg.requestId;
          const result = await this.deviceLogin.start(
            msg.forge,
            msg.host,
            requestId,
            (progress) => {
              // Progress is FLAT (requestId + fields at top level, no payload wrapper).
              this.emit({
                type: "forge.connection.login.progress",
                requestId,
                phase: progress.phase,
                userCode: progress.userCode ?? null,
                verificationUri: progress.verificationUri ?? null,
                line: progress.line ?? null,
              });
            },
          );
          this.emit({
            type: "forge.connection.login.response",
            payload: {
              ok: result.ok,
              forge: result.forge,
              error: result.error ?? null,
              requestId,
            },
          });
          return;
        }
        case "forge.connection.login.cancel.request": {
          const ok = this.deviceLogin.cancel(msg.targetRequestId);
          this.emit({
            type: "forge.connection.login.cancel.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
      }
    } catch (error) {
      this.options.logger?.warn?.("forge-hub request failed", { type: msg.type, error });
      // Best-effort empty response so the client's correlated request settles.
      this.emitEmptyFor(msg);
    }
  }

  private emit(message: SessionOutboundMessage): void {
    this.options.host.emit(message);
  }

  // (forge dispatch is inline in handle(): "github" → gh impl, "gitlab" → glab impl,
  //  any other forge → the neutral empty result.)

  private emitEmptyFor(msg: ForgeHubInbound): void {
    switch (msg.type) {
      case "forge.connection.list.request":
        return this.emit({
          type: "forge.connection.list.response",
          payload: { connections: [], requestId: msg.requestId },
        });
      case "forge.connection.add.request":
        return; // add failure surfaces as an rpc error upstream; nothing safe to fabricate
      case "forge.connection.remove.request":
        return this.emit({
          type: "forge.connection.remove.response",
          payload: { removed: false, requestId: msg.requestId },
        });
      case "forge.repo.list.request":
        return this.emit({
          type: "forge.repo.list.response",
          payload: { repos: [], requestId: msg.requestId },
        });
      case "forge.change_request.list.request":
        return this.emit({
          type: "forge.change_request.list.response",
          payload: { changeRequests: [], requestId: msg.requestId },
        });
      case "forge.change_request.files.request":
        return this.emit({
          type: "forge.change_request.files.response",
          payload: { files: [], requestId: msg.requestId },
        });
      case "forge.branch.list.request":
        return this.emit({
          type: "forge.branch.list.response",
          payload: { branches: [], requestId: msg.requestId },
        });
      case "forge.commit.list.request":
        return this.emit({
          type: "forge.commit.list.response",
          payload: { commits: [], requestId: msg.requestId },
        });
      case "forge.commit.compare.request":
        return this.emit({
          type: "forge.commit.compare.response",
          payload: { files: [], commits: [], requestId: msg.requestId },
        });
      case "forge.tree.list.request":
        return this.emit({
          type: "forge.tree.list.response",
          payload: { entries: [], requestId: msg.requestId },
        });
      case "forge.file.get.request":
        return this.emit({
          type: "forge.file.get.response",
          payload: {
            path: msg.path,
            content: null,
            isBinary: false,
            truncated: false,
            requestId: msg.requestId,
          },
        });
      case "forge.change_request.review.request":
        return this.emit({
          type: "forge.change_request.review.response",
          payload: { ok: false, requestId: msg.requestId },
        });
      case "forge.change_request.merge.request":
        return this.emit({
          type: "forge.change_request.merge.response",
          payload: { merged: false, requestId: msg.requestId },
        });
      case "forge.pipeline.list.request":
        return this.emit({
          type: "forge.pipeline.list.response",
          payload: { runs: [], requestId: msg.requestId },
        });
      case "forge.pipeline.get.request":
        return this.emit({
          type: "forge.pipeline.get.response",
          payload: { pipeline: null, requestId: msg.requestId },
        });
      case "forge.job.log.request":
        return this.emit({
          type: "forge.job.log.response",
          payload: { log: "", truncated: false, running: false, requestId: msg.requestId },
        });
      case "forge.pipeline.rerun.request":
        return this.emit({
          type: "forge.pipeline.rerun.response",
          payload: { ok: false, requestId: msg.requestId },
        });
      case "forge.pipeline.cancel.request":
        return this.emit({
          type: "forge.pipeline.cancel.response",
          payload: { ok: false, requestId: msg.requestId },
        });
      case "forge.job.play.request":
        return this.emit({
          type: "forge.job.play.response",
          payload: { ok: false, requestId: msg.requestId },
        });
      case "forge.change_request.set_auto_merge.request":
        return this.emit({
          type: "forge.change_request.set_auto_merge.response",
          payload: { enabled: false, requestId: msg.requestId },
        });
      case "forge.artifact.list.request":
        return this.emit({
          type: "forge.artifact.list.response",
          payload: { artifacts: [], requestId: msg.requestId },
        });
      case "forge.artifact.download.request":
        return this.emit({
          type: "forge.artifact.download.response",
          payload: { url: null, requestId: msg.requestId },
        });
      case "forge.release.list.request":
        return this.emit({
          type: "forge.release.list.response",
          payload: { releases: [], requestId: msg.requestId },
        });
      case "forge.tag.list.request":
        return this.emit({
          type: "forge.tag.list.response",
          payload: { tags: [], requestId: msg.requestId },
        });
      case "forge.issue.list.request":
        return this.emit({
          type: "forge.issue.list.response",
          payload: { issues: [], requestId: msg.requestId },
        });
      case "forge.issue.create.request":
        return this.emit({
          type: "forge.issue.create.response",
          payload: { issue: null, requestId: msg.requestId },
        });
      case "forge.issue.comment.request":
        return this.emit({
          type: "forge.issue.comment.response",
          payload: { ok: false, requestId: msg.requestId },
        });
      case "forge.issue.close.request":
        return this.emit({
          type: "forge.issue.close.response",
          payload: { ok: false, requestId: msg.requestId },
        });
      case "forge.change_request.create.request":
        return this.emit({
          type: "forge.change_request.create.response",
          payload: { number: null, url: null, error: null, requestId: msg.requestId },
        });
      case "forge.change_request.close.request":
        return this.emit({
          type: "forge.change_request.close.response",
          payload: { ok: false, requestId: msg.requestId },
        });
      case "forge.release.create.request":
        return this.emit({
          type: "forge.release.create.response",
          payload: { release: null, error: null, requestId: msg.requestId },
        });
      case "forge.release.get.request":
        return this.emit({
          type: "forge.release.get.response",
          payload: { release: null, requestId: msg.requestId },
        });
      case "forge.cli.status.request":
        return this.emit({
          type: "forge.cli.status.response",
          payload: {
            binary: "",
            installed: false,
            version: null,
            path: null,
            packageManager: null,
            canAutoInstall: false,
            requestId: msg.requestId,
          },
        });
      case "forge.cli.install.request":
        return this.emit({
          type: "forge.cli.install.response",
          payload: {
            ok: false,
            binary: "",
            version: null,
            packageManager: null,
            error: "install failed",
            requestId: msg.requestId,
          },
        });
      case "forge.connection.login.request":
        return this.emit({
          type: "forge.connection.login.response",
          payload: { ok: false, forge: msg.forge, error: "login failed", requestId: msg.requestId },
        });
      case "forge.connection.login.cancel.request":
        return this.emit({
          type: "forge.connection.login.cancel.response",
          payload: { ok: false, requestId: msg.requestId },
        });
    }
  }
}
