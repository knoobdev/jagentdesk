import { z } from "zod";
import type {
  ForgeConnection,
  ForgeRepo,
  ForgeChangeRequestSummary,
  ForgeChangeRequestFile,
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
      | "forge.change_request.files.request";
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
    }
  }
}
