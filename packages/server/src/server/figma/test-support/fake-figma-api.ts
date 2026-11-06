import http from "node:http";
import type { AddressInfo } from "node:net";

// A fake api.figma.com for tests only (no real network calls to Figma). Routing and response
// shapes follow the official endpoints cited in the research doc (figma-integration.md §3, §4):
//   GET /v1/files/:key/meta         Tier 3  → { file: { name, version, last_touched_at, thumbnail_url, editorType } }
//   GET /v1/teams/:team_id/projects Tier 2 → { name, projects: [{ id, name }] }
//   GET /v1/projects/:id/files      Tier 2 → { name, files: [{ key, name, last_modified }] }
//   GET /images/<name>              S3-style bytes, never authenticated
// Every request is logged (method, path, query, Authorization) so tests can assert what the
// daemon sent — and that a blocked budget sent nothing at all.

export interface LoggedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: string | null;
}

export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  /** JSON body (mutually exclusive with `bytes`). */
  body?: unknown;
  bytes?: { data: Buffer; contentType: string };
}

export interface FakeFileMeta {
  name?: string;
  version?: string;
  last_touched_at?: string;
  thumbnail_url?: string;
  editorType?: string;
}

/**
 * The body `GET /v1/files/:key/meta` documents: every field nested under `file`
 * (developers.figma.com file-endpoints — Get file metadata).
 */
export function documentedFileMeta(fileKey: string, meta: FakeFileMeta): FakeFileMeta {
  return {
    name: meta.name ?? `File ${fileKey}`,
    version: meta.version ?? "1",
    last_touched_at: meta.last_touched_at ?? "2026-03-01T00:00:00.000Z",
    thumbnail_url:
      meta.thumbnail_url ??
      `https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/thumb-${fileKey}.png`,
    editorType: meta.editorType ?? "figma",
  };
}

export interface FakeTeam {
  name: string;
  projects: Array<{ id: string; name: string }>;
}

export interface FakeProject {
  name: string;
  files: Array<{ key: string; name: string; last_modified?: string }>;
}

export class FakeFigmaApi {
  readonly requests: LoggedRequest[] = [];
  /** Requests with this bearer succeed; anything else answers 401 (research: token expiry). */
  validToken: string | null = "fake-figma-access-token-0001";
  /** When false the team/project browse endpoints answer 403, like public OAuth apps. */
  browseEnabled = true;
  fileMeta = new Map<string, FakeFileMeta>();
  teams = new Map<string, FakeTeam>();
  projects = new Map<string, FakeProject>();
  images = new Map<string, { data: Buffer; contentType: string }>();

  private server: http.Server | null = null;
  private url: string | null = null;
  private readonly script: ScriptedResponse[] = [];

  /** The origin to give the client under test, or null before start(). */
  get baseUrl(): string | null {
    return this.url;
  }

  /** Overrides the next N responses in order, before routing. */
  enqueue(...responses: ScriptedResponse[]): void {
    this.script.push(...responses);
  }

  get requestCount(): number {
    return this.requests.length;
  }

  /** Requests the daemon asked Figma for, oldest first. */
  pathsSeen(): string[] {
    return this.requests.map((request) => request.path);
  }

  /** Clears the request log, scripted responses and canned data between tests. */
  reset(): void {
    this.requests.length = 0;
    this.script.length = 0;
    this.validToken = "fake-figma-access-token-0001";
    this.browseEnabled = true;
    this.fileMeta.clear();
    this.teams.clear();
    this.projects.clear();
    this.images.clear();
  }

  lastRequest(): LoggedRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async start(): Promise<string> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.url = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://unused");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8") || null;
    const authorization = (request.headers.authorization as string | undefined) ?? null;
    this.requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization,
      body,
    });

    const scripted = this.script.shift();
    if (scripted) return this.send(response, scripted);

    if (url.pathname.startsWith("/images/")) {
      const image = this.images.get(url.pathname);
      if (image) {
        return this.send(response, { status: 200, bytes: image });
      }
      return this.send(response, { status: 404, body: { err: "Not found" } });
    }

    if (this.validToken !== null && authorization !== `Bearer ${this.validToken}`) {
      return this.send(response, { status: 401, body: { err: "Invalid token" } });
    }

    const fileMeta = /^\/v1\/files\/([^/]+)\/meta$/.exec(url.pathname);
    if (fileMeta) {
      const key = decodeURIComponent(fileMeta[1]);
      const meta = this.fileMeta.get(key);
      return meta
        ? this.send(response, { status: 200, body: { file: documentedFileMeta(key, meta) } })
        : this.send(response, { status: 404, body: { err: "Not found" } });
    }

    const teamProjects = /^\/v1\/teams\/([^/]+)\/projects$/.exec(url.pathname);
    if (teamProjects) {
      if (!this.browseEnabled) {
        return this.send(response, {
          status: 403,
          body: {
            err: "OAuth application is not verified or some of the required scopes were not granted.",
          },
        });
      }
      const team = this.teams.get(decodeURIComponent(teamProjects[1]));
      return team
        ? this.send(response, { status: 200, body: team })
        : this.send(response, { status: 404, body: { err: "Not found" } });
    }

    const projectFiles = /^\/v1\/projects\/([^/]+)\/files$/.exec(url.pathname);
    if (projectFiles) {
      if (!this.browseEnabled) {
        return this.send(response, {
          status: 403,
          body: {
            err: "OAuth application is not verified or some of the required scopes were not granted.",
          },
        });
      }
      const project = this.projects.get(decodeURIComponent(projectFiles[1]));
      return project
        ? this.send(response, { status: 200, body: project })
        : this.send(response, { status: 404, body: { err: "Not found" } });
    }

    return this.send(response, { status: 404, body: { err: "Not found" } });
  }

  private send(response: http.ServerResponse, result: ScriptedResponse): void {
    response.statusCode = result.status;
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      response.setHeader(key, value);
    }
    if (result.bytes) {
      response.setHeader("Content-Type", result.bytes.contentType);
      response.end(result.bytes.data);
      return;
    }
    if (result.body === undefined) {
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(result.body));
  }
}
