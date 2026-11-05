import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FigmaConnection,
  FigmaPush,
  FigmaRequest,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { MemorySecretStore } from "../../database/secret-store.js";
import { FigmaServiceError, type FigmaContext } from "../context.js";
import { FigmaService } from "../service.js";
import { FIGMA_OAUTH_SCOPES, FigmaOAuth } from "../oauth.js";
import {
  unavailableCache,
  unavailableLink,
  unavailableRest,
  unavailableTokens,
} from "../unavailable.js";
import { FakeFigmaApi } from "../test-support/fake-figma-oauth-api.js";
import { MemoryFigmaStore } from "../test-support/fake-figma-store.js";
import type { FigmaSessionInfo } from "./types.js";

// The connections + OAuth group (spec 32.2, ADR-0035 §1) against a fake Figma server: begin →
// complete over both the loopback and the pasted URL, state and attempt-expiry rejection, the
// single-flight refresh, invalid_grant → needs_reauth, secrets kept off the wire, and the desktop
// delegation push. Every RPC goes through FigmaService.handle on a fixed clock; the only network
// is to the loopback fake, never to api.figma.com.

const T0 = 1_762_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CALLBACK = "http://127.0.0.1:8766/figma/callback";

interface Harness {
  fake: FakeFigmaApi;
  secrets: MemorySecretStore;
  store: MemoryFigmaStore;
  service: FigmaService;
  clock: { offset: number };
  pushes: FigmaPush[];
}

const desktop: FigmaSessionInfo = { sessionKey: "s-desktop", canRunLoopback: true };
const mobile: FigmaSessionInfo = { sessionKey: "s-mobile", canRunLoopback: false };

let harnesses: Harness[] = [];

async function startHarness(options: { tokens?: FigmaContext["tokens"] } = {}): Promise<Harness> {
  const fake = new FakeFigmaApi();
  await fake.start();
  const clock = { offset: 0 };
  const secrets = new MemorySecretStore();
  const store = new MemoryFigmaStore();
  const logger = pino({ level: "silent" });
  const now = () => T0 + clock.offset;
  const service = new FigmaService({
    jagentdeskHome: "/tmp/jad-figma-w2-test",
    logger,
    secrets,
    parts: {
      store,
      tokens:
        options.tokens ??
        new FigmaOAuth({
          secrets,
          logger,
          endpoints: { authUrl: fake.baseUrl, apiUrl: fake.baseUrl },
          now,
        }),
      rest: unavailableRest,
      cache: unavailableCache,
      link: unavailableLink,
    },
    now,
  });
  const pushes: FigmaPush[] = [];
  service.onPush((event) => pushes.push(event));
  const harness: Harness = { fake, secrets, store, service, clock, pushes };
  harnesses.push(harness);
  return harness;
}

async function call<T>(
  h: Harness,
  request: FigmaRequest,
  session: FigmaSessionInfo = mobile,
): Promise<T> {
  return (await h.service.handle({ ...request, requestId: randomUUID() }, session)) as T;
}

function beginRequest(h: Harness, redirect: "loopback" | "paste"): FigmaRequest {
  return {
    type: "figma.oauth.begin.request",
    requestId: "",
    clientId: h.fake.clientId,
    clientSecret: h.fake.clientSecret,
    redirect,
  };
}

function completeRequest(input: { attemptId: string; code: string; state: string }): FigmaRequest {
  return {
    type: "figma.oauth.complete.request",
    requestId: "",
    attemptId: input.attemptId,
    code: input.code,
    state: input.state,
  };
}

/** begin → read state + challenge off the authorize URL → fake the code → complete. */
async function signIn(
  h: Harness,
  redirect: "loopback" | "paste" = "loopback",
): Promise<FigmaConnection> {
  const begun = await call<{ attemptId: string; authorizeUrl: string; redirectUri: string }>(
    h,
    beginRequest(h, redirect),
  );
  const url = new URL(begun.authorizeUrl);
  const code = h.fake.issueCode(url.searchParams.get("code_challenge"));
  const completed = await call<{ connection: FigmaConnection | null }>(
    h,
    completeRequest({ attemptId: begun.attemptId, code, state: url.searchParams.get("state")! }),
  );
  const connection = completed.connection;
  if (!connection) throw new Error("sign-in returned no connection");
  return connection;
}

async function expectError(action: () => Promise<unknown>): Promise<FigmaServiceError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(FigmaServiceError);
    return error as FigmaServiceError;
  }
  throw new Error("expected the action to fail");
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.fake.stop()));
});

describe("figma.oauth.begin", () => {
  it("builds the authorize URL with state and PKCE S256 and keeps the secret off the wire", async () => {
    const h = await startHarness();
    const begun = await call<Record<string, string>>(h, beginRequest(h, "loopback"));
    expect(Object.keys(begun).sort()).toEqual(["attemptId", "authorizeUrl", "redirectUri"]);
    expect(begun.attemptId.startsWith("fga_")).toBe(true);
    expect(begun.redirectUri).toBe(CALLBACK);
    const url = new URL(begun.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${h.fake.baseUrl}/oauth`);
    expect(url.searchParams.get("client_id")).toBe(h.fake.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(url.searchParams.get("scope")).toBe(FIGMA_OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(JSON.stringify(begun)).not.toContain(h.fake.clientSecret);
    // Paste mode registers the same redirect (spec 32.2).
    const pasted = await call<Record<string, string>>(h, beginRequest(h, "paste"));
    expect(pasted.redirectUri).toBe(CALLBACK);
  });

  it("requires a client id and secret", async () => {
    const h = await startHarness();
    const error = await expectError(() =>
      call(h, { ...beginRequest(h, "loopback"), clientId: "  " } as FigmaRequest),
    );
    expect(error.code).toBe("invalid_input");
  });

  it("expires attempts after ten minutes", async () => {
    const h = await startHarness();
    const begun = await call<{ attemptId: string; authorizeUrl: string }>(
      h,
      beginRequest(h, "loopback"),
    );
    const state = new URL(begun.authorizeUrl).searchParams.get("state")!;
    h.clock.offset = 10 * 60_000 + 1;
    const error = await expectError(() =>
      call(h, completeRequest({ attemptId: begun.attemptId, code: "unused", state })),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("expired");
  });
});

describe("figma.oauth.complete", () => {
  it("exchanges the loopback code and stores every secret daemon-side", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    expect(connection.id.startsWith("fgc_")).toBe(true);
    expect(JSON.parse(JSON.stringify(connection))).toEqual({
      id: expect.any(String),
      account: {
        figmaUserId: h.fake.account.id,
        handle: h.fake.account.handle,
        email: h.fake.account.email,
      },
      authState: "connected",
      tokenExpiresAt_ms: T0 + 90 * DAY_MS,
      createdAt_ms: T0,
    });
    expect(await h.store.getConnection(connection.id)).toEqual(connection);

    // The exchange went out immediately: form body, secret over HTTP Basic, PKCE verifier.
    expect(h.fake.tokenRequests).toHaveLength(1);
    const tokenRequest = h.fake.tokenRequests[0]!;
    expect(tokenRequest.contentType).toBe("application/x-www-form-urlencoded");
    expect(tokenRequest.authorization).toBe(
      `Basic ${Buffer.from(`${h.fake.clientId}:${h.fake.clientSecret}`).toString("base64")}`,
    );
    expect(tokenRequest.form.grant_type).toBe("authorization_code");
    expect(tokenRequest.form.redirect_uri).toBe(CALLBACK);
    expect(tokenRequest.form.code_verifier).toBeTruthy();

    // Tokens and the secret live in the secret store only.
    const stored = JSON.parse((await h.secrets.get(`figma/${connection.id}/tokens`))!) as {
      accessToken: string;
      refreshToken: string;
      expiresAt_ms: number;
    };
    expect(stored.accessToken).toBe(h.fake.currentAccessToken);
    expect(stored.refreshToken).toBe(h.fake.currentRefreshToken);
    expect(stored.expiresAt_ms).toBe(T0 + 90 * DAY_MS);
    expect(await h.secrets.get(`figma/${connection.id}/client_secret`)).toBe(h.fake.clientSecret);
    expect(await h.secrets.get(`figma/${connection.id}/client_id`)).toBe(h.fake.clientId);
  });

  it("accepts the pasted URL the browser landed on", async () => {
    const h = await startHarness();
    const begun = await call<{ attemptId: string; authorizeUrl: string }>(
      h,
      beginRequest(h, "paste"),
    );
    const url = new URL(begun.authorizeUrl);
    const code = h.fake.issueCode(url.searchParams.get("code_challenge"));
    const completed = await call<{ connection: FigmaConnection | null }>(h, {
      type: "figma.oauth.complete.request",
      requestId: "",
      attemptId: begun.attemptId,
      pastedUrl: `${CALLBACK}?code=${code}&state=${url.searchParams.get("state")}`,
    });
    expect(completed.connection?.authState).toBe("connected");
    expect(h.fake.tokenRequests).toHaveLength(1);
  });

  it("rejects a wrong state and still accepts the right one", async () => {
    const h = await startHarness();
    const begun = await call<{ attemptId: string; authorizeUrl: string }>(
      h,
      beginRequest(h, "loopback"),
    );
    const url = new URL(begun.authorizeUrl);
    const code = h.fake.issueCode(url.searchParams.get("code_challenge"));
    const error = await expectError(() =>
      call(h, completeRequest({ attemptId: begun.attemptId, code, state: "wrong-state" })),
    );
    expect(error.code).toBe("invalid_input");
    const retry = await call<{ connection: FigmaConnection | null }>(
      h,
      completeRequest({
        attemptId: begun.attemptId,
        code,
        state: url.searchParams.get("state")!,
      }),
    );
    expect(retry.connection?.authState).toBe("connected");
  });

  it("surfaces a refused pasted URL as auth_failed", async () => {
    const h = await startHarness();
    const begun = await call<{ attemptId: string }>(h, beginRequest(h, "paste"));
    const error = await expectError(() =>
      call(h, {
        type: "figma.oauth.complete.request",
        requestId: "",
        attemptId: begun.attemptId,
        pastedUrl: `${CALLBACK}?error=access_denied&state=whatever`,
      }),
    );
    expect(error.code).toBe("auth_failed");
  });

  it("reports a PKCE mismatch from the token endpoint as figma_error", async () => {
    const h = await startHarness();
    const begun = await call<{ attemptId: string; authorizeUrl: string }>(
      h,
      beginRequest(h, "loopback"),
    );
    const code = h.fake.issueCode("not-the-challenge");
    const error = await expectError(() =>
      call(h, {
        ...completeRequest({
          attemptId: begun.attemptId,
          code,
          state: new URL(begun.authorizeUrl).searchParams.get("state")!,
        }),
      }),
    );
    expect(error.code).toBe("figma_error");
    expect(error.message).toContain("PKCE");
  });

  it("rejects an unknown attempt", async () => {
    const h = await startHarness();
    const error = await expectError(() =>
      call(h, completeRequest({ attemptId: "fga_missing", code: "c", state: "s" })),
    );
    expect(error.code).toBe("invalid_input");
  });

  it("answers unsupported while the token manager is a placeholder", async () => {
    const h = await startHarness({ tokens: unavailableTokens });
    const error = await expectError(() => call(h, beginRequest(h, "loopback")));
    expect(error.code).toBe("unsupported");
  });
});

describe("token manager", () => {
  it("serves the cached token while it is more than five minutes from expiry", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    h.clock.offset = 90 * DAY_MS - 6 * 60_000;
    const token = await h.service.ctx.tokens.accessToken(connection.id);
    expect(token).toBe(h.fake.currentAccessToken);
    expect(h.fake.refreshRequests).toHaveLength(0);
  });

  it("refreshes exactly once for two parallel calls near expiry and persists before use", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    const firstToken = h.fake.currentAccessToken!;
    h.clock.offset = 90 * DAY_MS - 4 * 60_000;
    h.fake.refreshDelayMs = 250;
    const [a, b] = await Promise.all([
      h.service.ctx.tokens.accessToken(connection.id),
      h.service.ctx.tokens.accessToken(connection.id),
    ]);
    expect(h.fake.refreshRequests).toHaveLength(1);
    expect(a).toBe(b);
    expect(a).toBe(h.fake.currentAccessToken);
    expect(a).not.toBe(firstToken);
    // The rotated pair hit the secret store before anyone could use it; Figma's refresh response
    // carries no refresh token, so the stored one survives.
    const stored = JSON.parse((await h.secrets.get(`figma/${connection.id}/tokens`))!) as {
      accessToken: string;
      refreshToken: string;
    };
    expect(stored.accessToken).toBe(a);
    expect(stored.refreshToken).toBe(h.fake.currentRefreshToken);
    const updated = await h.store.getConnection(connection.id);
    expect(updated?.authState).toBe("connected");
    expect(updated?.tokenExpiresAt_ms).toBe(T0 + h.clock.offset + 90 * DAY_MS);
  });

  it("invalidate() forces the next call to refresh", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    const firstToken = h.fake.currentAccessToken!;
    h.service.ctx.tokens.invalidate(connection.id);
    const second = await h.service.ctx.tokens.accessToken(connection.id);
    expect(h.fake.refreshRequests).toHaveLength(1);
    expect(second).not.toBe(firstToken);
  });

  it("invalid_grant parks the connection in needs_reauth", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    h.clock.offset = 90 * DAY_MS - 4 * 60_000;
    h.fake.refreshFailure = "invalid_grant";
    const error = await expectError(() => h.service.ctx.tokens.accessToken(connection.id));
    expect(error.code).toBe("needs_reauth");
    const stored = await h.store.getConnection(connection.id);
    expect(stored?.authState).toBe("needs_reauth");
    expect(typeof stored?.lastError).toBe("string");
  });

  it("a connection without stored tokens needs re-auth", async () => {
    const h = await startHarness();
    const error = await expectError(() => h.service.ctx.tokens.accessToken("fgc_unknown"));
    expect(error.code).toBe("needs_reauth");
  });
});

describe("figma.connections.list / remove / test", () => {
  it("lists connections without any secret on the wire", async () => {
    const h = await startHarness();
    const first = await signIn(h);
    const second = await signIn(h);
    const listed = await call<{ connections: FigmaConnection[] }>(h, {
      type: "figma.connections.list.request",
      requestId: "",
    });
    expect(listed.connections.map((c) => c.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(listed)).not.toContain(h.fake.clientSecret);
  });

  it("remove deletes the store entry and every connection secret", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    const removed = await call<Record<string, never>>(h, {
      type: "figma.connections.remove.request",
      requestId: "",
      connectionId: connection.id,
    });
    expect(removed).toEqual({});
    expect(await h.store.getConnection(connection.id)).toBeNull();
    expect(await h.secrets.get(`figma/${connection.id}/client_id`)).toBeNull();
    expect(await h.secrets.get(`figma/${connection.id}/client_secret`)).toBeNull();
    expect(await h.secrets.get(`figma/${connection.id}/tokens`)).toBeNull();
    const error = await expectError(() =>
      call(h, {
        type: "figma.connections.remove.request",
        requestId: "",
        connectionId: connection.id,
      }),
    );
    expect(error.code).toBe("not_found");
  });

  it("test confirms the account through GET /v1/me", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    const tested = await call<{ connection: FigmaConnection }>(h, {
      type: "figma.connections.test.request",
      requestId: "",
      connectionId: connection.id,
    });
    expect(tested.connection.authState).toBe("connected");
    expect(h.fake.meRequests.at(-1)).toBe(`Bearer ${h.fake.currentAccessToken}`);
  });

  it("test marks a rejected connection needs_reauth and recovers on success", async () => {
    const h = await startHarness();
    const connection = await signIn(h);
    h.fake.meUnauthorized = true;
    const failed = await call<{ connection: FigmaConnection }>(h, {
      type: "figma.connections.test.request",
      requestId: "",
      connectionId: connection.id,
    });
    expect(failed.connection.authState).toBe("needs_reauth");
    expect(typeof failed.connection.lastError).toBe("string");
    h.fake.meUnauthorized = false;
    const passed = await call<{ connection: FigmaConnection }>(h, {
      type: "figma.connections.test.request",
      requestId: "",
      connectionId: connection.id,
    });
    expect(passed.connection.authState).toBe("connected");
    expect(passed.connection.lastError).toBeUndefined();
  });

  it("test on an unknown connection fails with not_found", async () => {
    const h = await startHarness();
    const error = await expectError(() =>
      call(h, {
        type: "figma.connections.test.request",
        requestId: "",
        connectionId: "fgc_unknown",
      }),
    );
    expect(error.code).toBe("not_found");
  });
});

describe("figma.oauth.delegate", () => {
  it("reports desktopAvailable false without a desktop session", async () => {
    const h = await startHarness();
    const result = await call<Record<string, unknown>>(h, {
      type: "figma.oauth.delegate.request",
      requestId: "",
      clientId: h.fake.clientId,
      clientSecret: h.fake.clientSecret,
    });
    expect(result).toEqual({ attemptId: null, desktopAvailable: false });
    expect(h.pushes).toEqual([]);
  });

  it("pushes the delegation to the desktop and completes from the forwarded code", async () => {
    const h = await startHarness();
    // A desktop session that has talked to the service can run the loopback.
    await call(h, { type: "figma.connections.list.request", requestId: "" }, desktop);
    const result = await call<{ attemptId: string | null; desktopAvailable: boolean }>(h, {
      type: "figma.oauth.delegate.request",
      requestId: "",
      clientId: h.fake.clientId,
      clientSecret: h.fake.clientSecret,
    });
    expect(result.desktopAvailable).toBe(true);
    expect(typeof result.attemptId).toBe("string");
    expect(h.pushes).toHaveLength(1);
    const push = h.pushes[0] as Extract<FigmaPush, { type: "figma.oauth.delegation" }>;
    expect(push.type).toBe("figma.oauth.delegation");
    expect(push.attemptId).toBe(result.attemptId);
    expect(push.redirectUri).toBe(CALLBACK);
    expect(JSON.stringify(push)).not.toContain(h.fake.clientSecret);

    // The desktop's loopback catches the callback and forwards code + state to figma.oauth.complete.
    const url = new URL(push.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const code = h.fake.issueCode(url.searchParams.get("code_challenge"));
    const completed = await call<{ connection: FigmaConnection | null }>(
      h,
      {
        type: "figma.oauth.complete.request",
        requestId: "",
        attemptId: result.attemptId!,
        code,
        state: url.searchParams.get("state")!,
      },
      desktop,
    );
    expect(completed.connection?.authState).toBe("connected");
  });
});
