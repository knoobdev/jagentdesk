import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

// A fake Figma OAuth + REST server for tests only, speaking the shapes cited in
// docs/reference/figma-integration.md §2: /v1/oauth/token and /v1/oauth/refresh take the client
// secret over HTTP Basic with an x-www-form-urlencoded body (the refresh response carries no new
// refresh token), and /v1/me answers with the User object. Everything is loopback — tests never
// touch api.figma.com. Every request is recorded so tests can assert what the daemon sent.

export interface FakeFigmaAccount {
  id: string;
  handle: string;
  email: string | null;
}

interface RecordedTokenRequest {
  authorization: string;
  contentType: string;
  body: string;
  form: Record<string, string>;
}

export class FakeFigmaApi {
  readonly clientId = "fake-figma-client-ngoc";
  readonly clientSecret = "sekrit-KHANH-not-a-substring";
  baseUrl = "";
  /** Access tokens the user has never seen: assert they stay out of every response payload. */
  readonly account: FakeFigmaAccount = {
    id: "900000000000000001",
    handle: "ngoc",
    email: "ngoc@hdc.dev",
  };
  tokenExpiresInS = 90 * 24 * 60 * 60;
  refreshDelayMs = 0;
  /** Set to "invalid_grant" to make /v1/oauth/refresh reject the stored refresh token. */
  refreshFailure: "invalid_grant" | null = null;
  /** When true, /v1/me answers 401 no matter the token. */
  meUnauthorized = false;

  readonly tokenRequests: RecordedTokenRequest[] = [];
  readonly refreshRequests: RecordedTokenRequest[] = [];
  meRequests: string[] = [];

  private server: http.Server | null = null;
  private issuedCode: string | null = null;
  private issuedChallenge: string | null = null;
  private liveAccess: string | null = null;
  private liveRefresh: string | null = null;
  private counter = 0;

  /** The next (and only) authorization code Figma will accept, with its PKCE challenge. */
  issueCode(codeChallenge: string | null): string {
    this.issuedCode = `code-${Date.now()}-${++this.counter}`;
    this.issuedChallenge = codeChallenge;
    return this.issuedCode;
  }

  get currentAccessToken(): string | null {
    return this.liveAccess;
  }
  get currentRefreshToken(): string | null {
    return this.liveRefresh;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.route(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const body = await readBody(req);
    if (req.method === "POST" && url.pathname === "/v1/oauth/token") {
      this.handleToken(res, body, req);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/oauth/refresh") {
      await this.handleRefresh(res, body, req);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/me") {
      this.handleMe(res, req.headers.authorization ?? "");
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: 404, err: "Not found" }));
  }

  private handleToken(res: http.ServerResponse, body: string, req: http.IncomingMessage): void {
    const form = formOf(body);
    this.tokenRequests.push(recorded(req, body));
    if (!this.basicMatches(req.headers.authorization ?? "")) {
      reply(res, 401, { error: "invalid_client" });
      return;
    }
    if (form.grant_type !== "authorization_code" || form.code !== this.issuedCode) {
      reply(res, 400, { error: "invalid_request" });
      return;
    }
    if (this.issuedChallenge !== null) {
      const verifier = form.code_verifier ?? "";
      if (
        createHash("sha256").update(verifier, "ascii").digest("base64url") !== this.issuedChallenge
      ) {
        reply(res, 400, { error: "invalid_request", error_description: "PKCE check failed" });
        return;
      }
    }
    this.issuedCode = null; // a code is single-use
    this.liveAccess = this.mint("at");
    this.liveRefresh = this.mint("rt");
    reply(res, 200, {
      access_token: this.liveAccess,
      token_type: "bearer",
      expires_in: this.tokenExpiresInS,
      refresh_token: this.liveRefresh,
      user_id_string: this.account.id,
    });
  }

  private async handleRefresh(
    res: http.ServerResponse,
    body: string,
    req: http.IncomingMessage,
  ): Promise<void> {
    const form = formOf(body);
    this.refreshRequests.push(recorded(req, body));
    if (!this.basicMatches(req.headers.authorization ?? "")) {
      reply(res, 401, { error: "invalid_client" });
      return;
    }
    if (this.refreshFailure === "invalid_grant" || form.refresh_token !== this.liveRefresh) {
      reply(res, 403, { error: "invalid_grant", err: "Refresh token expired" });
      return;
    }
    if (this.refreshDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.refreshDelayMs));
    }
    // Figma's refresh response carries no refresh_token — the old one stays valid.
    this.liveAccess = this.mint("at");
    reply(res, 200, {
      access_token: this.liveAccess,
      token_type: "bearer",
      expires_in: this.tokenExpiresInS,
    });
  }

  private handleMe(res: http.ServerResponse, authorization: string): void {
    this.meRequests.push(authorization);
    if (this.meUnauthorized || authorization !== `Bearer ${this.liveAccess}`) {
      reply(res, 401, { status: 401, err: "Invalid token" });
      return;
    }
    reply(res, 200, {
      id: this.account.id,
      email: this.account.email,
      handle: this.account.handle,
      img_url: "https://figma.invalid/avatars/900000000000000001.png",
      created_at: "2024-01-01T00:00:00Z",
    });
  }

  private basicMatches(authorization: string): boolean {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    return authorization === `Basic ${basic}`;
  }

  private mint(prefix: string): string {
    return `${prefix}_${++this.counter}`;
  }
}

function formOf(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

function recorded(req: http.IncomingMessage, body: string): RecordedTokenRequest {
  return {
    authorization: req.headers.authorization ?? "",
    contentType: String(req.headers["content-type"] ?? ""),
    body,
    form: formOf(body),
  };
}

function reply(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
