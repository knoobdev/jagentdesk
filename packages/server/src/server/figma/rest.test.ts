import { pino } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FigmaTokenProvider } from "./context.js";
import { FigmaServiceError } from "./context.js";
import { HttpFigmaRestClient, FIGMA_API_BASE_URL } from "./rest.js";
import { FakeFigmaApi } from "./test-support/fake-figma-api.js";

// Deterministic clock; the client's budget window and Retry-After math are relative to now().
const T0 = 1_762_300_000_000;

class FakeTokens implements FigmaTokenProvider {
  invalidations = 0;
  issued: string[] = [];
  private index = 0;

  constructor(private readonly tokens: string[]) {}

  async accessToken(): Promise<string> {
    const token = this.tokens[Math.min(this.index, this.tokens.length - 1)];
    this.issued.push(token);
    return token;
  }

  invalidate(): void {
    this.invalidations += 1;
    this.index += 1;
  }
}

const metaRoute = { path: "/v1/files/KEY1/meta", tier: "3" as const };

describe("HttpFigmaRestClient", () => {
  let api: FakeFigmaApi;
  let clock: { now: number };
  let client: (tokens: FigmaTokenProvider) => HttpFigmaRestClient;

  beforeAll(async () => {
    api = new FakeFigmaApi();
    await api.start();
  });

  afterAll(async () => {
    await api.stop();
  });

  beforeEach(() => {
    api.reset();
    clock = { now: T0 };
    client = (tokens) =>
      new HttpFigmaRestClient({
        logger: pino({ level: "silent" }),
        tokens: () => tokens,
        baseUrl: api.baseUrl ?? FIGMA_API_BASE_URL,
        now: () => clock.now,
      });
  });

  function expectServiceError(error: unknown, code: string): FigmaServiceError {
    expect(error).toBeInstanceOf(FigmaServiceError);
    expect((error as FigmaServiceError).code).toBe(code);
    return error as FigmaServiceError;
  }

  it("sends the bearer token and query params to the API base URL", async () => {
    api.fileMeta.set("KEY1", { name: "Landing" });
    const tokens = new FakeTokens(["fake-figma-access-token-0001"]);
    const rest = client(tokens);
    const result = await rest.getJson<{ name: string }>({
      connectionId: "fgc_1",
      path: "/v1/files/KEY1/meta",
      query: { ids: "1:2", depth: 2, geometry: "paths", branch_data: true, skip: undefined },
      tier: "3",
    });
    expect(result.name).toBe("Landing");
    const request = api.lastRequest();
    expect(request?.authorization).toBe("Bearer fake-figma-access-token-0001");
    expect(request?.query).toEqual({
      ids: "1:2",
      depth: "2",
      geometry: "paths",
      branch_data: "true",
    });
    expect(tokens.issued).toEqual(["fake-figma-access-token-0001"]);
  });

  it("refreshes and retries exactly once on 401", async () => {
    api.validToken = "fresh-token";
    api.fileMeta.set("KEY1", { name: "Landing" });
    const tokens = new FakeTokens(["stale-token", "fresh-token"]);
    const rest = client(tokens);
    const result = await rest.getJson<{ name: string }>({ ...metaRoute, connectionId: "fgc_1" });
    expect(result).toEqual({ name: "Landing" });
    expect(tokens.invalidations).toBe(1);
    expect(api.requestCount).toBe(2);
    expect(api.requests[1]?.authorization).toBe("Bearer fresh-token");
  });

  it("fails with auth_failed when the retried request is a 401 again", async () => {
    const tokens = new FakeTokens(["wrong-token"]);
    const rest = client(tokens);
    const error = expectServiceError(
      await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
      "auth_failed",
    );
    expect(error.message).toContain("Invalid token");
    expect(api.requestCount).toBe(2); // initial + single retry, never a third
    expect(tokens.invalidations).toBe(1);
  });

  it("counts requests per tier in the last minute and ages them out", async () => {
    api.fileMeta.set("KEY1", { name: "Landing" });
    const rest = client(new FakeTokens(["fake-figma-access-token-0001"]));
    for (let i = 0; i < 2; i += 1)
      await rest.getJson({ ...metaRoute, connectionId: "fgc_1", tier: "1" });
    await rest.getJson({ ...metaRoute, connectionId: "fgc_1", tier: "2" });
    await rest.getJson({ ...metaRoute, connectionId: "fgc_1", tier: "3" });
    await rest.getJson({ ...metaRoute, connectionId: "fgc_other", tier: "1" });

    expect(
      rest
        .budget("fgc_1")
        .tiers.map((tier) => [tier.tier, tier.usedLastMinute, tier.blockedUntil_ms]),
    ).toEqual([
      ["1", 2, null],
      ["2", 1, null],
      ["3", 1, null],
    ]);
    expect(rest.budget("fgc_other").tiers.find((tier) => tier.tier === "1")?.usedLastMinute).toBe(
      1,
    );

    clock.now = T0 + 61_000;
    expect(rest.budget("fgc_1").tiers.map((tier) => [tier.tier, tier.usedLastMinute])).toEqual([
      ["1", 0],
      ["2", 0],
      ["3", 0],
    ]);
  });

  it("blocks a rate-limited tier without further network calls until Retry-After passes", async () => {
    api.fileMeta.set("KEY1", { name: "Landing" });
    api.enqueue({
      status: 429,
      headers: {
        "Retry-After": "7",
        "X-Figma-Plan-Tier": "starter",
        "X-Figma-Rate-Limit-Type": "low",
        "X-Figma-Upgrade-Link": "https://www.figma.com/pricing",
      },
      body: { err: "Rate limit exceeded" },
    });
    const tokens = new FakeTokens(["fake-figma-access-token-0001"]);
    const rest = client(tokens);

    const first = expectServiceError(
      await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
      "rate_limited",
    );
    expect(first.extra.retryAt_ms).toBe(T0 + 7_000);
    expect(first.extra.planTier).toBe("starter");
    expect(first.extra.rateLimitType).toBe("low");
    expect(first.extra.upgradeUrl).toBe("https://www.figma.com/pricing");
    expect(api.requestCount).toBe(1); // never auto-retried

    // While blocked: refused with the same info and no call to Figma at all.
    for (let i = 0; i < 3; i += 1) {
      const blocked = expectServiceError(
        await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
        "rate_limited",
      );
      expect(blocked.extra.retryAt_ms).toBe(T0 + 7_000);
    }
    expect(api.requestCount).toBe(1);
    expect(rest.budget("fgc_1").tiers.find((tier) => tier.tier === "3")?.blockedUntil_ms).toBe(
      T0 + 7_000,
    );
    expect(rest.budget("fgc_1").planTier).toBe("starter");
    expect(rest.budget("fgc_1").rateLimitType).toBe("low");

    // A different tier of the same connection is not blocked.
    await rest.getJson({ ...metaRoute, connectionId: "fgc_1", tier: "1" });
    expect(api.requestCount).toBe(2);

    clock.now = T0 + 7_001;
    const result = await rest.getJson<{ name: string }>({ ...metaRoute, connectionId: "fgc_1" });
    expect(result.name).toBe("Landing");
    expect(api.requestCount).toBe(3);
    expect(
      rest.budget("fgc_1").tiers.find((tier) => tier.tier === "3")?.blockedUntil_ms,
    ).toBeNull();
  });

  it("maps error statuses and keeps Figma's err detail", async () => {
    const rest = client(new FakeTokens(["fake-figma-access-token-0001"]));
    api.enqueue({ status: 403, body: { err: "Invalid token scopes" } });
    const forbidden = expectServiceError(
      await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
      "forbidden",
    );
    expect(forbidden.message).toContain("Invalid token scopes");

    api.enqueue({ status: 400, body: { err: "Bad node id" } });
    expectServiceError(
      await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
      "invalid_input",
    );

    api.enqueue({ status: 502, body: { err: "Bad gateway" } });
    expectServiceError(
      await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
      "network",
    );

    expectServiceError(
      await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
      "not_found",
    ); // routing default for an unregistered file key
  });

  it("sends JSON bodies on writes", async () => {
    api.enqueue({ status: 200, body: { ok: true } });
    const rest = client(new FakeTokens(["fake-figma-access-token-0001"]));
    const result = await rest.sendJson<{ ok: boolean }>({
      connectionId: "fgc_1",
      method: "POST",
      path: "/v1/files/KEY1/comments",
      body: { message: "hello" },
      tier: "2",
    });
    expect(result.ok).toBe(true);
    const request = api.lastRequest();
    expect(request?.method).toBe("POST");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({ message: "hello" });
  });

  it("downloads bytes without an Authorization header", async () => {
    api.images.set("/images/fill-1.png", {
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      contentType: "image/png",
    });
    const tokens = new FakeTokens(["fake-figma-access-token-0001"]);
    const rest = client(tokens);
    const bytes = await rest.getBytes(`${api.baseUrl}/images/fill-1.png`);
    expect(bytes.mimeType).toBe("image/png");
    expect(bytes.data.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(api.lastRequest()?.authorization).toBeNull();
    expect(tokens.issued).toEqual([]);
  });

  it("reports a failed byte download as a network error", async () => {
    const rest = client(new FakeTokens(["fake-figma-access-token-0001"]));
    expectServiceError(
      await rest.getBytes(`${api.baseUrl}/images/missing.png`).catch((e) => e),
      "network",
    );
  });

  it("uses JAGENTDESK_FIGMA_API_URL when no base URL is given", async () => {
    const previous = process.env.JAGENTDESK_FIGMA_API_URL;
    process.env.JAGENTDESK_FIGMA_API_URL = "http://127.0.0.1:9/";
    try {
      const rest = new HttpFigmaRestClient({
        logger: pino({ level: "silent" }),
        tokens: () => new FakeTokens(["fake-figma-access-token-0001"]),
      });
      // Port 9 (discard) refuses the connection: reaching it proves the env override is the target.
      const error = expectServiceError(
        await rest.getJson({ ...metaRoute, connectionId: "fgc_1" }).catch((e) => e),
        "network",
      );
      expect(error.message).toContain("Could not reach Figma");
    } finally {
      if (previous === undefined) delete process.env.JAGENTDESK_FIGMA_API_URL;
      else process.env.JAGENTDESK_FIGMA_API_URL = previous;
    }
  });
});
