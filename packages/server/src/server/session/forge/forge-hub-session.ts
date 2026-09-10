import { z } from "zod";
import type {
  ForgeConnection,
  ForgeRepo,
  ForgeChangeRequestSummary,
  ForgeChangeRequestFile,
  ForgeBranch,
  ForgeCommit,
  ForgePipelineRun,
  ForgePipelineDetail,
  ForgePipelineJob,
  ForgeReviewAction,
  ForgeMergeMethod,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@jagentdesk/protocol/messages";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../../utils/spawn.js";
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
      | "forge.change_request.review.request"
      | "forge.change_request.merge.request"
      | "forge.pipeline.list.request"
      | "forge.pipeline.get.request"
      | "forge.job.log.request"
      | "forge.pipeline.rerun.request"
      | "forge.pipeline.cancel.request"
      | "forge.job.play.request";
  }
>;

export interface ForgeHubSessionOptions {
  host: { emit: (message: SessionOutboundMessage) => void };
  /** Daemon secret store for method:"token" connections (id → token). */
  secretStore: SecretStore;
  logger?: { warn?: (msg: string, meta?: unknown) => void };
}

const GH_TIMEOUT_MS = 20_000;
const SECRET_PREFIX = "forge.connection.token:";

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

export class ForgeHubService {
  constructor(private readonly secretStore: SecretStore) {}

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
    // Token connections persisted in the secret store.
    for (const meta of await this.listTokenConnectionMeta()) {
      out.push(meta);
    }
    return out;
  }

  // Token connection metadata is kept next to the secret (id-encoded), keyless for
  // Milestone A: only the fields the UI shows. Bitbucket adapter (Milestone C) fills
  // account/expiry via a REST probe.
  private async listTokenConnectionMeta(): Promise<ForgeConnection[]> {
    // SecretStore has no list(); token connections are enumerated from their ids that
    // callers added this session. Milestone A persists none by default, so return [].
    return [];
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
      await this.secretStore.set(`${SECRET_PREFIX}${id}`, input.token);
      return {
        id,
        forge: input.forge,
        host,
        account: null,
        method: "token",
        authState: "authenticated",
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
    await this.secretStore.delete(`${SECRET_PREFIX}${connectionId}`);
    return true;
  }

  async listRepos(input: { query?: string; limit?: number }): Promise<ForgeRepo[]> {
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
    return rows
      .filter((r) => !query || r.nameWithOwner.toLowerCase().includes(query))
      .map((r): ForgeRepo => {
        const [owner, name] = r.nameWithOwner.split("/", 2);
        return {
          forge: "github",
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

export class ForgeHubSession {
  private readonly service: ForgeHubService;
  constructor(private readonly options: ForgeHubSessionOptions) {
    this.service = new ForgeHubService(options.secretStore);
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
          const repos = await this.service.listRepos({ query: msg.query, limit: msg.limit });
          this.emit({
            type: "forge.repo.list.response",
            payload: { repos, requestId: msg.requestId },
          });
          return;
        }
        case "forge.change_request.list.request": {
          const changeRequests = await this.service.listChangeRequests({
            owner: msg.repo.owner,
            name: msg.repo.name,
            state: msg.state,
            limit: msg.limit,
          });
          this.emit({
            type: "forge.change_request.list.response",
            payload: { changeRequests, requestId: msg.requestId },
          });
          return;
        }
        case "forge.change_request.files.request": {
          const { files, truncated } = await this.service.getChangeRequestFiles({
            owner: msg.repo.owner,
            name: msg.repo.name,
            number: msg.number,
          });
          this.emit({
            type: "forge.change_request.files.response",
            payload: { files, truncated, requestId: msg.requestId },
          });
          return;
        }
        // ---- Milestone B (GitHub via gh; other forges return empty for now) ----
        case "forge.branch.list.request": {
          const branches = this.isGitHub(msg.repo.forge)
            ? await this.service.listBranches({
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
          const commits = this.isGitHub(msg.repo.forge)
            ? await this.service.listCommits({
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
          const res = this.isGitHub(msg.repo.forge)
            ? await this.service.compareCommits({
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
        case "forge.change_request.review.request": {
          const ok = this.isGitHub(msg.repo.forge)
            ? await this.service.reviewChangeRequest({
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
          const merged = this.isGitHub(msg.repo.forge)
            ? await this.service.mergeChangeRequest({
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
          const runs = this.isGitHub(msg.repo.forge)
            ? await this.service.listPipelines({
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
          const pipeline = this.isGitHub(msg.repo.forge)
            ? await this.service.getPipeline({
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
          const res = this.isGitHub(msg.repo.forge)
            ? await this.service.getJobLog({
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
          const ok = this.isGitHub(msg.repo.forge)
            ? await this.service.rerunPipeline({
                owner: msg.repo.owner,
                name: msg.repo.name,
                runId: msg.runId,
                onlyFailed: msg.onlyFailed,
              })
            : false;
          this.emit({
            type: "forge.pipeline.rerun.response",
            payload: { ok, requestId: msg.requestId },
          });
          return;
        }
        case "forge.pipeline.cancel.request": {
          const ok = this.isGitHub(msg.repo.forge)
            ? await this.service.cancelPipeline({
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
          // GitHub has no per-job "play" (manual gates are environment approvals); report
          // unsupported. GitLab (glab `ci play`) lands with the GitLab provider.
          this.emit({
            type: "forge.job.play.response",
            payload: { ok: false, requestId: msg.requestId },
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
    }
  }

  /** Milestone B methods are implemented for GitHub in this checkpoint; other forges
   *  (glab/bitbucket) return empty until their provider lands. */
  private isGitHub(forge: string): boolean {
    return forge === "github";
  }
}
