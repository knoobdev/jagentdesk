import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type express from "express";
import type { Logger } from "pino";
import { z } from "zod";
import type { BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import { NO_BROWSER_HOST_MESSAGE } from "./shim-script.js";

export const AGENT_BROWSER_OPEN_ROUTE = "/api/agent-browser/open";
export const AGENT_FILES_ROUTE = "/api/agent-files";

const WEB_FILE = /\.(?:html?|svg|pdf)$/i;
const MAX_SHARED_ROOTS = 256;
const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

/**
 * Local files an agent opened, served to the in-app browser over loopback. Each share is the
 * file's directory under an unguessable token, so a report's relative CSS and images load too.
 * Kept in memory for the life of the daemon, oldest dropped past {@link MAX_SHARED_ROOTS}.
 */
export class AgentFileShares {
  private readonly tokenByRoot = new Map<string, string>();
  private readonly rootByToken = new Map<string, string>();

  share(filePath: string): { token: string; relativePath: string } {
    const root = path.dirname(filePath);
    let token = this.tokenByRoot.get(root);
    if (!token) {
      token = randomBytes(16).toString("hex");
      this.tokenByRoot.set(root, token);
      this.rootByToken.set(token, root);
      if (this.tokenByRoot.size > MAX_SHARED_ROOTS) {
        const [oldestRoot, oldestToken] = this.tokenByRoot.entries().next().value as [
          string,
          string,
        ];
        this.tokenByRoot.delete(oldestRoot);
        this.rootByToken.delete(oldestToken);
      }
    }
    return { token, relativePath: path.basename(filePath) };
  }

  /** The absolute file for a request path under a token, or null outside the shared root. */
  async resolve(token: string, relativePath: string): Promise<string | null> {
    const root = this.rootByToken.get(token);
    if (!root || !relativePath) return null;
    const candidate = path.resolve(root, relativePath);
    try {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
      if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) return null;
      return (await stat(realFile)).isFile() ? realFile : null;
    } catch {
      return null;
    }
  }
}

export function createAgentFilesRouteHandler(shares: AgentFileShares): express.RequestHandler {
  return (req, res) => {
    void (async () => {
      if (!isLoopback(req.socket.remoteAddress) || req.method !== "GET") {
        res.status(403).end();
        return;
      }
      const [token = "", ...rest] = req.path.replace(/^\/+/, "").split("/");
      let relativePath: string;
      try {
        relativePath = rest.map((part) => decodeURIComponent(part)).join("/");
      } catch {
        res.status(400).end();
        return;
      }
      const file = await shares.resolve(token, relativePath);
      if (!file) {
        res.status(404).end();
        return;
      }
      res.sendFile(file, { dotfiles: "allow", headers: { "cache-control": "no-store" } });
    })();
  };
}

const OpenRequestSchema = z.object({
  agentId: z.string().min(1),
  target: z.union([
    z.object({ url: z.string().regex(/^https?:\/\//i) }),
    z.object({ path: z.string().min(1) }),
  ]),
});

export interface AgentBrowserOpenDependencies {
  token: string;
  resolveAgent(agentId: string): { cwd: string; workspaceId?: string | null } | null;
  execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload>;
  shares: AgentFileShares;
  /** `http://127.0.0.1:<port>` of the daemon, or null before it listens on TCP. */
  baseUrl(): string | null;
  logger: Logger;
}

function hasToken(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const provided = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function localFileUrl(
  deps: AgentBrowserOpenDependencies,
  filePath: string,
): Promise<{ url: string } | { error: string }> {
  if (!path.isAbsolute(filePath) || !WEB_FILE.test(filePath)) {
    return { error: "JAgentDesk opens only .html, .htm, .svg and .pdf files in its browser." };
  }
  try {
    if (!(await stat(filePath)).isFile()) return { error: `Not a file: ${filePath}` };
  } catch {
    return { error: `No such file: ${filePath}` };
  }
  const base = deps.baseUrl();
  if (!base) return { error: "The JAgentDesk daemon is not listening on a local TCP port." };
  const { token, relativePath } = deps.shares.share(filePath);
  return { url: `${base}${AGENT_FILES_ROUTE}/${token}/${encodeURIComponent(relativePath)}` };
}

async function openTab(input: {
  deps: AgentBrowserOpenDependencies;
  agentId: string;
  agent: { cwd: string; workspaceId?: string | null };
  url: string;
}): Promise<BrowserToolsResponsePayload> {
  const request: BrowserToolsExecuteInput = {
    agentId: input.agentId,
    cwd: input.agent.cwd,
    ...(input.agent.workspaceId ? { workspaceId: input.agent.workspaceId } : {}),
    command: { command: "new_tab", args: { url: input.url } },
  };
  const payload = await input.deps.execute(request);
  if (payload.ok || payload.error.code !== "browser_host_ambiguous") return payload;
  // Several app windows can host tabs: the first one that can open tabs takes it.
  const host = payload.error.browserHosts?.find((entry) => entry.canOpenTabs);
  return host ? input.deps.execute({ ...request, browserHostId: host.browserHostId }) : payload;
}

/**
 * Spec 04 §27b item 3b: the agent shims post web targets here. Loopback only and gated by the
 * per-run agent token, like /mcp/agents. The tab opens in the agent's workspace through the same
 * broker command as browser_new_tab; with no browser host the request fails and nothing else opens.
 */
export function createAgentBrowserOpenRouteHandler(
  deps: AgentBrowserOpenDependencies,
): express.RequestHandler {
  return (req, res) => {
    void (async () => {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.status(403).json({ ok: false, message: "Forbidden" });
        return;
      }
      if (!hasToken(req.header("authorization"), deps.token)) {
        res.status(401).json({ ok: false, message: "Unauthorized" });
        return;
      }
      const parsed = OpenRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ ok: false, message: "Expected { agentId, target: { url | path } }" });
        return;
      }
      const { agentId, target } = parsed.data;
      const agent = deps.resolveAgent(agentId);
      if (!agent) {
        res.status(404).json({ ok: false, message: `Unknown JAgentDesk agent ${agentId}` });
        return;
      }
      const resolved =
        "url" in target ? { url: target.url } : await localFileUrl(deps, target.path);
      if ("error" in resolved) {
        res.status(400).json({ ok: false, message: resolved.error });
        return;
      }
      const payload = await openTab({ deps, agentId, agent, url: resolved.url });
      if (payload.ok) {
        res.json({ ok: true, url: resolved.url });
        return;
      }
      deps.logger.info(
        { agentId, code: payload.error.code },
        "Agent shim could not open an in-app browser tab",
      );
      const noHost =
        payload.error.code === "browser_no_host" || payload.error.code === "browser_host_ambiguous";
      res.status(noHost ? 409 : 502).json({
        ok: false,
        code: payload.error.code,
        message: noHost ? NO_BROWSER_HOST_MESSAGE : payload.error.message,
      });
    })().catch((error: unknown) => {
      deps.logger.error({ err: error }, "Agent shim browser open failed");
      if (!res.headersSent) res.status(500).json({ ok: false, message: "Internal error" });
    });
  };
}
