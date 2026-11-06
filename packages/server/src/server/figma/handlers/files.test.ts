import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretStore } from "../../database/secret-store.js";
import type { FigmaContext, FigmaLinkBridge, FigmaTokenProvider } from "../context.js";
import { FigmaServiceError } from "../context.js";
import { unavailableLink } from "../unavailable.js";
import { JsonFigmaStore } from "../store.js";
import { HttpFigmaRestClient } from "../rest.js";
import { FakeFigmaApi } from "../test-support/fake-figma-api.js";
import { filesHandlers, parseFigmaFileUrl, parseFigmaTeamUrl } from "./files.js";
import type { FigmaRequestOf, FigmaSessionInfo } from "./types.js";

const CONNECTION = "fgc_test1";
const LINKED_KEY = "LINKED";

const api = new FakeFigmaApi();
let ctx: FigmaContext;

const session: FigmaSessionInfo = { sessionKey: "test-session", canRunLoopback: false };

function buildContext(jagentdeskHome: string): FigmaContext {
  const logger = pino({ level: "silent" });
  const tokens: FigmaTokenProvider = {
    accessToken: async () => "fake-figma-access-token-0001",
    invalidate: () => undefined,
  };
  const link: FigmaLinkBridge = {
    ...unavailableLink,
    isLinked: (fileKey: string) => fileKey === LINKED_KEY,
  };
  return {
    jagentdeskHome,
    logger,
    secrets: new MemorySecretStore(),
    store: new JsonFigmaStore({ jagentdeskHome, logger }),
    tokens,
    rest: new HttpFigmaRestClient({
      logger,
      tokens: () => tokens,
      baseUrl: api.baseUrl ?? "http://127.0.0.1:9",
    }),
    cache: {
      getJson: async () => null,
      putJson: async () => undefined,
      getBytes: async () => null,
      putBytes: async () => undefined,
    },
    link,
    push: () => undefined,
    now: () => Date.now(),
  };
}

function addRequest(url: string): FigmaRequestOf<"figma.files.add.request"> {
  return { type: "figma.files.add.request", requestId: "req-1", connectionId: CONNECTION, url };
}

async function expectError(promise: Promise<unknown>, code: string): Promise<FigmaServiceError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(FigmaServiceError);
  const serviceError = error as FigmaServiceError;
  expect(serviceError.code).toBe(code);
  return serviceError;
}

beforeAll(async () => {
  await api.start();
});

beforeEach(async () => {
  api.reset();
  ctx = buildContext(await mkdtemp(path.join(tmpdir(), "jad-figma-files-")));
  await ctx.store.saveConnection({
    id: CONNECTION,
    account: { figmaUserId: "u-1", handle: "@tester", email: null },
    authState: "connected",
    createdAt_ms: 1_700_000_000_000,
  });
});

describe("parseFigmaFileUrl", () => {
  it("accepts every file URL shape and bare keys", () => {
    expect(parseFigmaFileUrl("https://www.figma.com/design/KEY1/Homepage?node-id=1-2&t=1")).toBe(
      "KEY1",
    );
    expect(parseFigmaFileUrl("figma.com/design/KEY2/Name")).toBe("KEY2");
    expect(parseFigmaFileUrl("http://figma.com/file/KEY3/x")).toBe("KEY3");
    expect(parseFigmaFileUrl("https://www.figma.com/proto/KEY4/Flow?mode=design")).toBe("KEY4");
    expect(parseFigmaFileUrl("  https://www.figma.com/design/KEY5// ")).toBe("KEY5");
    expect(parseFigmaFileUrl("AbC123")).toBe("AbC123");
    expect(parseFigmaFileUrl("12:345")).toBe("12:345"); // branch key
  });

  it("rejects non-file URLs and junk", () => {
    expect(parseFigmaFileUrl("https://example.com/design/KEY1/x")).toBeNull();
    expect(parseFigmaFileUrl("https://www.figma.com/settings")).toBeNull();
    expect(parseFigmaFileUrl("https://www.figma.com/design/")).toBeNull();
    expect(parseFigmaFileUrl("hello world")).toBeNull();
    expect(parseFigmaFileUrl("")).toBeNull();
  });
});

describe("parseFigmaTeamUrl", () => {
  it("accepts team URLs and bare ids", () => {
    expect(parseFigmaTeamUrl("https://www.figma.com/files/team/111/Team-One/projects/222")).toBe(
      "111",
    );
    expect(parseFigmaTeamUrl("figma.com/files/team/222")).toBe("222");
    expect(parseFigmaTeamUrl("333")).toBe("333");
  });

  it("rejects non-team URLs and junk", () => {
    expect(parseFigmaTeamUrl("https://www.figma.com/design/KEY1/x")).toBeNull();
    expect(parseFigmaTeamUrl("https://example.com/files/team/111")).toBeNull();
    expect(parseFigmaTeamUrl("two words")).toBeNull();
  });
});

describe("figma.files.add", () => {
  it("resolves each URL shape to the file key and fetches Tier-3 meta", async () => {
    for (const [url, key] of [
      ["https://www.figma.com/design/KEY1/Homepage?node-id=1-2", "KEY1"],
      ["figma.com/file/KEY2/x", "KEY2"],
      ["https://www.figma.com/proto/KEY3/Flow", "KEY3"],
      ["AbC123", "AbC123"],
    ] as const) {
      api.fileMeta.set(key, { name: `${key} design` });
      const response = await filesHandlers["figma.files.add.request"](
        addRequest(url),
        ctx,
        session,
      );
      expect(response.file?.fileKey).toBe(key);
      expect(api.lastRequest()?.path).toBe(`/v1/files/${key}/meta`);
    }
  });

  it("stores the file with name, version and lastModified from the meta endpoint", async () => {
    api.fileMeta.set("KEY1", {
      name: "Checkout redesign",
      version: "881",
      last_touched_at: "2026-11-01T08:00:00.000Z",
    });
    const response = await filesHandlers["figma.files.add.request"](
      addRequest("https://www.figma.com/design/KEY1/Checkout"),
      ctx,
      session,
    );
    expect(response.file).toEqual({
      fileKey: "KEY1",
      connectionId: CONNECTION,
      name: "Checkout redesign",
      pinned: false,
      lastVersion: "881",
      lastModified_ms: Date.parse("2026-11-01T08:00:00.000Z"),
      linked: false,
    });
    expect(await ctx.store.getFile("KEY1")).toEqual(response.file);
  });

  it("still accepts a flat top-level meta body", async () => {
    // The documented shape nests under `file`; some deployments (and the daemon's own cache
    // history) put the fields at the top level, so the reader tolerates both.
    api.fileMeta.set("KEY1", { name: "Checkout redesign", version: "881" });
    api.enqueue({
      status: 200,
      body: {
        name: "Checkout redesign",
        version: "881",
        last_touched_at: "2026-11-01T08:00:00.000Z",
        thumbnail_url: "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/thumb-KEY1.png",
        editorType: "figma",
      },
    });
    const response = await filesHandlers["figma.files.add.request"](
      addRequest("https://www.figma.com/design/KEY1/Checkout"),
      ctx,
      session,
    );
    expect(response.file).toMatchObject({
      fileKey: "KEY1",
      name: "Checkout redesign",
      lastVersion: "881",
      lastModified_ms: Date.parse("2026-11-01T08:00:00.000Z"),
    });
  });

  it("marks the file linked when Figma Link has it open and keeps the pin on re-add", async () => {
    api.fileMeta.set(LINKED_KEY, { name: "Linked file" });
    const first = await filesHandlers["figma.files.add.request"](
      addRequest(`https://www.figma.com/design/${LINKED_KEY}/x`),
      ctx,
      session,
    );
    expect(first.file?.linked).toBe(true);

    await filesHandlers["figma.files.pin.request"](
      { type: "figma.files.pin.request", requestId: "req-2", fileKey: LINKED_KEY, pinned: true },
      ctx,
      session,
    );
    const again = await filesHandlers["figma.files.add.request"](
      addRequest(`https://www.figma.com/design/${LINKED_KEY}/x`),
      ctx,
      session,
    );
    expect(again.file?.pinned).toBe(true);
  });

  it("rejects junk URLs and unknown connections without a Figma call", async () => {
    const bad = await expectError(
      filesHandlers["figma.files.add.request"](addRequest("two words"), ctx, session),
      "invalid_input",
    );
    expect(bad.message).toContain("two words");

    await expectError(
      filesHandlers["figma.files.add.request"](
        { ...addRequest("KEY1"), connectionId: "fgc_missing" },
        ctx,
        session,
      ),
      "not_found",
    );
    expect(api.requestCount).toBe(0);
  });

  // The live 403 evidence (user same account, Can edit): /v1/me returned 200 at sign-in while
  // /v1/files/:key/meta returned 403 "Permission denied". A bare "Permission denied" reads like
  // the user lacks file permission; the sign-in already proved the account, so the message must
  // name the account and put the app-scope check and the file-sharing check side by side.
  it("diagnoses a 403 on file meta as app-vs-file access, naming the connected account", async () => {
    api.enqueue({ status: 403, body: { err: "Permission denied" } });
    const error = await expectError(
      filesHandlers["figma.files.add.request"](
        addRequest("https://www.figma.com/design/KEY403/Design"),
        ctx,
        session,
      ),
      "forbidden",
    );
    expect(error.message).toContain("Permission denied"); // Figma's raw error stays quotable
    expect(error.message).toContain("KEY403");
    expect(error.message).toContain("@tester"); // the connection has no email → handle
    expect(error.message).toContain("scopes"); // app access is one of the two checks
    expect(error.message).toMatch(/open this file.*in Figma/); // user file permission is the other
    expect(error.message).not.toMatch(/sign in again/i); // it is not presented as a sign-in fault
  });

  it("names the connected email when the account has one", async () => {
    await ctx.store.saveConnection({
      id: "fgc_mail",
      account: { figmaUserId: "u-2", handle: "<account-handle>", email: "<account-email>" },
      authState: "connected",
      createdAt_ms: 1_700_000_000_000,
    });
    api.enqueue({ status: 403, body: { err: "Request denied" } });
    const error = await expectError(
      filesHandlers["figma.files.add.request"](
        { ...addRequest("KEY403"), connectionId: "fgc_mail" },
        ctx,
        session,
      ),
      "forbidden",
    );
    expect(error.message).toContain("<account-email>");
    expect(error.message).toContain("Request denied");
  });

  it("leaves non-403 meta failures untouched", async () => {
    api.enqueue({ status: 404, body: { err: "Not found" } });
    const notFound = await expectError(
      filesHandlers["figma.files.add.request"](addRequest("MISSING1"), ctx, session),
      "not_found",
    );
    expect(notFound.message).toBe("Not found"); // no diagnostics bolted onto a plain 404
  });
});

describe("figma.files list / remove / pin", () => {
  beforeEach(async () => {
    api.fileMeta.set("KEY1", { name: "One" });
    api.fileMeta.set("KEY2", { name: "Two" });
    await filesHandlers["figma.files.add.request"](
      addRequest("https://www.figma.com/design/KEY1/one"),
      ctx,
      session,
    );
    await filesHandlers["figma.files.add.request"](
      addRequest("https://www.figma.com/design/KEY2/two"),
      ctx,
      session,
    );
  });

  it("lists files, filtered by connection, with live linked state", async () => {
    api.fileMeta.set(LINKED_KEY, { name: "Linked" });
    await filesHandlers["figma.files.add.request"](addRequest(LINKED_KEY), ctx, session);

    const all = await filesHandlers["figma.files.list.request"](
      { type: "figma.files.list.request", requestId: "req-3" },
      ctx,
      session,
    );
    expect(all.files.map((entry) => entry.fileKey)).toEqual(["KEY1", "KEY2", LINKED_KEY]);
    expect(all.files.map((entry) => entry.linked)).toEqual([false, false, true]);
    expect(
      (
        await filesHandlers["figma.files.list.request"](
          { type: "figma.files.list.request", requestId: "req-4", connectionId: "fgc_other" },
          ctx,
          session,
        )
      ).files,
    ).toEqual([]);
  });

  it("pins and unpins", async () => {
    const pinned = await filesHandlers["figma.files.pin.request"](
      { type: "figma.files.pin.request", requestId: "req-5", fileKey: "KEY1", pinned: true },
      ctx,
      session,
    );
    expect(pinned.file?.pinned).toBe(true);
    expect((await ctx.store.getFile("KEY1"))?.pinned).toBe(true);
  });

  it("removes tracked files and fails on unknown ones", async () => {
    await filesHandlers["figma.files.remove.request"](
      { type: "figma.files.remove.request", requestId: "req-6", fileKey: "KEY1" },
      ctx,
      session,
    );
    expect(await ctx.store.getFile("KEY1")).toBeNull();
    await expectError(
      filesHandlers["figma.files.remove.request"](
        { type: "figma.files.remove.request", requestId: "req-7", fileKey: "KEY1" },
        ctx,
        session,
      ),
      "not_found",
    );
    await expectError(
      filesHandlers["figma.files.pin.request"](
        { type: "figma.files.pin.request", requestId: "req-8", fileKey: "NOPE", pinned: true },
        ctx,
        session,
      ),
      "not_found",
    );
  });
});

describe("figma.teams", () => {
  it("validates and names the team from the projects endpoint when adding", async () => {
    api.teams.set("111", { name: "Design Org", projects: [{ key: "P1", name: "Web" }] });
    const response = await filesHandlers["figma.teams.add.request"](
      {
        type: "figma.teams.add.request",
        requestId: "req-9",
        connectionId: CONNECTION,
        url: "https://www.figma.com/files/team/111/Design-Org",
      },
      ctx,
      session,
    );
    expect(response.team).toEqual({ teamId: "111", connectionId: CONNECTION, name: "Design Org" });
    expect(await ctx.store.listTeams(CONNECTION)).toEqual([response.team]);
  });

  it("lists, browses projects and files, and removes teams", async () => {
    api.teams.set("111", {
      name: "Design Org",
      projects: [
        { key: "P1", name: "Web" },
        { key: "P2", name: "Mobile" },
        { key: "P3", name: "No name" },
        { key: "P4", name: 7 } as unknown as { key: string; name: string },
      ],
    });
    api.projects.set("P1", {
      name: "Web",
      files: [
        { key: "KEY1", name: "Home", last_modified: "2026-11-02T10:00:00.000Z" },
        { key: "KEY2", name: "Checkout" },
      ],
    });

    const projects = await filesHandlers["figma.teams.projects.request"](
      {
        type: "figma.teams.projects.request",
        requestId: "req-10",
        connectionId: CONNECTION,
        teamId: "111",
      },
      ctx,
      session,
    );
    expect(projects.projects).toEqual([
      { id: "P1", name: "Web" },
      { id: "P2", name: "Mobile" },
      { id: "P3", name: "No name" },
    ]);

    const files = await filesHandlers["figma.teams.files.request"](
      {
        type: "figma.teams.files.request",
        requestId: "req-11",
        connectionId: CONNECTION,
        projectId: "P1",
      },
      ctx,
      session,
    );
    expect(files.files).toEqual([
      { fileKey: "KEY1", name: "Home", lastModified_ms: Date.parse("2026-11-02T10:00:00.000Z") },
      { fileKey: "KEY2", name: "Checkout" },
    ]);

    await filesHandlers["figma.teams.add.request"](
      {
        type: "figma.teams.add.request",
        requestId: "req-12",
        connectionId: CONNECTION,
        url: "111",
      },
      ctx,
      session,
    );
    const listed = await filesHandlers["figma.teams.list.request"](
      { type: "figma.teams.list.request", requestId: "req-13", connectionId: CONNECTION },
      ctx,
      session,
    );
    expect(listed.teams).toEqual([{ teamId: "111", connectionId: CONNECTION, name: "Design Org" }]);

    await filesHandlers["figma.teams.remove.request"](
      {
        type: "figma.teams.remove.request",
        requestId: "req-14",
        connectionId: CONNECTION,
        teamId: "111",
      },
      ctx,
      session,
    );
    expect(await ctx.store.listTeams(CONNECTION)).toEqual([]);
  });

  it("turns browse-endpoint 403/404 into forbidden with the paste-file-URLs advice", async () => {
    api.browseEnabled = false; // public app: Figma answers 403 on projects/files
    const error = await expectError(
      filesHandlers["figma.teams.projects.request"](
        {
          type: "figma.teams.projects.request",
          requestId: "req-15",
          connectionId: CONNECTION,
          teamId: "999",
        },
        ctx,
        session,
      ),
      "forbidden",
    );
    expect(error.message).toContain("paste file URLs");

    await expectError(
      filesHandlers["figma.teams.files.request"](
        {
          type: "figma.teams.files.request",
          requestId: "req-16",
          connectionId: CONNECTION,
          projectId: "P1",
        },
        ctx,
        session,
      ),
      "forbidden",
    );

    // A 404 (unknown team) is forbidden advice too, while rate limits keep their own code.
    api.browseEnabled = true;
    await expectError(
      filesHandlers["figma.teams.projects.request"](
        {
          type: "figma.teams.projects.request",
          requestId: "req-17",
          connectionId: CONNECTION,
          teamId: "unknown",
        },
        ctx,
        session,
      ),
      "forbidden",
    );
    api.enqueue({ status: 429, headers: { "Retry-After": "30" } });
    await expectError(
      filesHandlers["figma.teams.projects.request"](
        {
          type: "figma.teams.projects.request",
          requestId: "req-18",
          connectionId: CONNECTION,
          teamId: "111",
        },
        ctx,
        session,
      ),
      "rate_limited",
    );
  });

  it("rejects junk team URLs without a Figma call", async () => {
    await expectError(
      filesHandlers["figma.teams.add.request"](
        {
          type: "figma.teams.add.request",
          requestId: "req-19",
          connectionId: CONNECTION,
          url: "https://www.figma.com/design/KEY1/x",
        },
        ctx,
        session,
      ),
      "invalid_input",
    );
    expect(api.requestCount).toBe(0);
  });
});

describe("figma.budget.get", () => {
  it("returns the REST client's budget for the connection", async () => {
    api.enqueue({
      status: 429,
      headers: {
        "Retry-After": "15",
        "X-Figma-Plan-Tier": "org",
        "X-Figma-Rate-Limit-Type": "high",
        "X-Figma-Upgrade-Link": "https://www.figma.com/settings",
      },
    });
    await expectError(
      filesHandlers["figma.files.add.request"](
        addRequest("https://www.figma.com/design/BUDGET1/x"),
        ctx,
        session,
      ),
      "rate_limited",
    );
    const response = await filesHandlers["figma.budget.get.request"](
      { type: "figma.budget.get.request", requestId: "req-20", connectionId: CONNECTION },
      ctx,
      session,
    );
    expect(response.budget?.connectionId).toBe(CONNECTION);
    expect(response.budget?.planTier).toBe("org");
    expect(response.budget?.rateLimitType).toBe("high");
    expect(response.budget?.upgradeUrl).toBe("https://www.figma.com/settings");
    const tier3 = response.budget?.tiers.find((tier) => tier.tier === "3");
    expect(tier3?.usedLastMinute).toBe(1);
    expect(tier3?.blockedUntil_ms).toBeGreaterThan(Date.now() - 1000);
  });
});
