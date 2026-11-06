import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../database/secret-store.js";
import { FigmaServiceError, type FigmaContext } from "./context.js";
import {
  figmaEndpointsFromEnv,
  figmaSecretKeys,
  FigmaOAuth,
  FIGMA_OAUTH_SCOPES,
  parseFigmaCallbackUrl,
  pkceChallengeS256,
  FIGMA_ENDPOINTS,
  FIGMA_LOOPBACK_REDIRECT_URI,
} from "./oauth.js";
import {
  unavailableCache,
  unavailableLink,
  unavailableRest,
  unavailableTokens,
} from "./unavailable.js";
import { FakeFigmaApi } from "./test-support/fake-figma-oauth-api.js";
import { MemoryFigmaStore } from "./test-support/fake-figma-store.js";

// The pure halves of the sign-in module: the PKCE transform, the pasted-URL parser, and the
// env endpoint override tests use to point at a fake server (spec 32.2).

describe("pkceChallengeS256", () => {
  it("matches the RFC 7636 appendix B vector", () => {
    expect(pkceChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("figmaEndpointsFromEnv", () => {
  it("defaults to Figma's production endpoints", () => {
    expect(figmaEndpointsFromEnv({})).toEqual(FIGMA_ENDPOINTS);
  });

  it("overrides each endpoint independently for tests", () => {
    expect(
      figmaEndpointsFromEnv({
        JAGENTDESK_FIGMA_AUTH_URL: "http://127.0.0.1:4001",
        JAGENTDESK_FIGMA_API_URL: "http://127.0.0.1:4002",
      }),
    ).toEqual({ authUrl: "http://127.0.0.1:4001", apiUrl: "http://127.0.0.1:4002" });
  });
});

describe("figmaSecretKeys", () => {
  it("covers every secret one connection owns", () => {
    expect(figmaSecretKeys("fgc_abc")).toEqual([
      "figma/fgc_abc/client_id",
      "figma/fgc_abc/client_secret",
      "figma/fgc_abc/tokens",
    ]);
  });
});

describe("parseFigmaCallbackUrl", () => {
  it("extracts code and state from the URL the browser landed on", () => {
    expect(parseFigmaCallbackUrl(`${FIGMA_LOOPBACK_REDIRECT_URI}?code=c_1&state=s_1`)).toEqual({
      code: "c_1",
      state: "s_1",
    });
  });

  it("reports a refused sign-in as auth_failed", () => {
    const thrown = () =>
      parseFigmaCallbackUrl(`${FIGMA_LOOPBACK_REDIRECT_URI}?error=access_denied&state=s_1`);
    expect(thrown).toThrow(FigmaServiceError);
    try {
      thrown();
    } catch (error) {
      expect((error as FigmaServiceError).code).toBe("auth_failed");
      expect((error as FigmaServiceError).message).toContain("access_denied");
    }
  });

  it("rejects a URL without code and state", () => {
    expect(() => parseFigmaCallbackUrl("http://127.0.0.1:8766/figma/callback")).toThrow(
      /no code and state/,
    );
  });

  it("rejects something that is not a URL", () => {
    expect(() => parseFigmaCallbackUrl("not a url")).toThrow(/not a URL/);
  });
});

// Spec 32.2 pins this exact list; the app's connect guide (packages/app/src/figma/connect/
// oauth-flow.ts) carries its own copy for the user to tick in the Figma console, pinned to the
// same list in its own test. When this assertion fails, fix the copy in oauth.ts — the guide's
// list is what the user enables, so the two must not drift.
describe("requested scopes", () => {
  it("requests exactly the spec 32.2 scope list", () => {
    expect(FIGMA_OAUTH_SCOPES).toEqual([
      "current_user:read",
      "file_content:read",
      "file_metadata:read",
      "file_versions:read",
      "file_comments:read",
      "file_comments:write",
      "library_content:read",
      "file_dev_resources:read",
      "projects:read",
    ]);
  });

  it("asks Figma for the same list the connect guide shows, space-separated", () => {
    const { oauth, ctx } = buildOAuthHarness();
    const begun = oauth.begin(ctx, {
      clientId: "cid",
      clientSecret: "sec",
      redirect: "paste",
    });
    const url = new URL(begun.authorizeUrl);
    expect(url.searchParams.get("scope")).toBe(FIGMA_OAUTH_SCOPES.join(" "));
    expect(url.searchParams.get("scope")).not.toContain("file_variables"); // Enterprise-only; variables go through Figma Link
  });
});

// The callback is one-shot: a completed (or failed) attempt is consumed, so a replayed
// figma.oauth.complete cannot post the same 30-second code twice.
describe("FigmaOAuth begin/complete", () => {
  let fake: FakeFigmaApi | null = null;

  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  async function startFake(): Promise<FakeFigmaApi> {
    fake = new FakeFigmaApi();
    await fake.start();
    return fake;
  }

  function beginWith(oauth: FigmaOAuth, ctx: FigmaContext, f: FakeFigmaApi) {
    const begun = oauth.begin(ctx, {
      clientId: f.clientId,
      clientSecret: f.clientSecret,
      redirect: "loopback",
    });
    const url = new URL(begun.authorizeUrl);
    return {
      begun,
      state: url.searchParams.get("state")!,
      code: f.issueCode(url.searchParams.get("code_challenge")),
    };
  }

  it("completes a sign-in against the token endpoint and /v1/me", async () => {
    const f = await startFake();
    const { oauth, ctx } = buildOAuthHarness(f);
    const { begun, state, code } = beginWith(oauth, ctx, f);
    const connection = await oauth.complete(ctx, { attemptId: begun.attemptId, code, state });
    expect(connection.authState).toBe("connected");
    expect(connection.account.handle).toBe(f.account.handle);
    expect(await ctx.store.getConnection(connection.id)).toEqual(connection);
    expect(f.tokenRequests).toHaveLength(1);
    expect(f.meRequests).toHaveLength(1);
  });

  it("consumes the attempt: completing it twice fails as expired", async () => {
    const f = await startFake();
    const { oauth, ctx } = buildOAuthHarness(f);
    const { begun, state, code } = beginWith(oauth, ctx, f);
    await oauth.complete(ctx, { attemptId: begun.attemptId, code, state });
    const replay = await oauth.complete(ctx, { attemptId: begun.attemptId, code, state }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(replay).toBeInstanceOf(FigmaServiceError);
    expect((replay as FigmaServiceError).code).toBe("invalid_input");
    expect((replay as FigmaServiceError).message).toContain("expired");
    // The replay never reached Figma: one token exchange and one /v1/me in total.
    expect(f.tokenRequests).toHaveLength(1);
    expect(f.meRequests).toHaveLength(1);
  });

  it("consumes the attempt even when the code exchange fails", async () => {
    const f = await startFake();
    const { oauth, ctx } = buildOAuthHarness(f);
    const { begun, state } = beginWith(oauth, ctx, f);
    const failed = await oauth
      .complete(ctx, { attemptId: begun.attemptId, code: "not-my-code", state })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(failed).toBeInstanceOf(FigmaServiceError);
    expect((failed as FigmaServiceError).code).toBe("figma_error"); // fake rejects the unknown code
    // The one-shot delete ran before the exchange: the attempt is gone even after a failure.
    const replay = await oauth
      .complete(ctx, { attemptId: begun.attemptId, code: "not-my-code", state })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(replay).toBeInstanceOf(FigmaServiceError);
    expect((replay as FigmaServiceError).message).toContain("expired");
  });
});

function buildOAuthHarness(f?: FakeFigmaApi): { oauth: FigmaOAuth; ctx: FigmaContext } {
  const secrets = new MemorySecretStore();
  const oauth = new FigmaOAuth({
    secrets,
    logger: pino({ level: "silent" }),
    endpoints: {
      authUrl: f?.baseUrl ?? "http://127.0.0.1:9",
      apiUrl: f?.baseUrl ?? "http://127.0.0.1:9",
    },
    now: () => 1_762_000_000_000,
  });
  const ctx = {
    jagentdeskHome: "/tmp/jad-figma-oauth-test",
    logger: pino({ level: "silent" }),
    secrets,
    store: new MemoryFigmaStore(),
    tokens: unavailableTokens,
    rest: unavailableRest,
    cache: unavailableCache,
    link: unavailableLink,
    push: () => undefined,
    now: () => 1_762_000_000_000,
  } satisfies FigmaContext;
  return { oauth, ctx };
}
