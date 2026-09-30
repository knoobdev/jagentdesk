import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { NativeSkillsService } from "./service.js";
import { fakeFetch, fakeRoute, githubRepoRoutes, makeTempRoots } from "./test-utils/fixtures.js";

const COMMIT = "c".repeat(40);
const SEARCH_PDF = "https://skillsmp.com/api/v1/skills/search?q=pdf&page=1&limit=20&sortBy=stars";
const GITHUB_URL = "https://github.com/owner/repo/tree/main/skills/nano-pdf";

let roots: ReturnType<typeof makeTempRoots>;

beforeEach(async () => {
  roots = makeTempRoots();
  await fs.mkdir(roots.home, { recursive: true });
  await fs.mkdir(roots.jdHome, { recursive: true });
});

afterEach(async () => {
  await fs.rm(roots.root, { recursive: true, force: true });
});

function searchResponse(hasNext = false) {
  return fakeRoute({
    headers: { "x-ratelimit-daily-limit": "50", "x-ratelimit-daily-remaining": "47" },
    body: {
      success: true,
      data: {
        skills: [
          {
            id: "owner-repo-skills-nano-pdf",
            name: "nano-pdf",
            author: "owner",
            description: "Edit PDFs with natural-language instructions.",
            githubUrl: GITHUB_URL,
            stars: 12,
          },
        ],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNext },
      },
    },
  });
}

function newService(fetch: ReturnType<typeof fakeFetch>): NativeSkillsService {
  return new NativeSkillsService({
    jagentdeskHome: roots.jdHome,
    homeDir: roots.home,
    logger: createTestLogger(),
    fetch,
  });
}

async function addDirectory(service: NativeSkillsService) {
  await service.initialize();
  return service.addSource("https://skillsmp.com/some/page");
}

describe("skill directory sources (ADR-0023)", () => {
  it("adds skillsmp.com as a directory without any request", async () => {
    const fetch = fakeFetch({});
    const source = await addDirectory(newService(fetch));
    expect(fetch.calls).toEqual([]);
    expect(source.spec).toEqual({ kind: "index", url: "https://skillsmp.com" });
    expect(source.directory).toEqual({ provider: "skillsmp", hasApiKey: false, quota: null });
  });

  it("never calls the directory in a merged browse", async () => {
    const fetch = fakeFetch({});
    const service = newService(fetch);
    await addDirectory(service);
    await service.browsePage(undefined, {}).catch(() => undefined);
    expect(fetch.calls.some((url) => url.includes("skillsmp.com"))).toBe(false);
  });

  it("searches one page per request and installs a result through GitHub", async () => {
    const repo = githubRepoRoutes(
      "owner/repo",
      COMMIT,
      {
        "skills/nano-pdf/SKILL.md":
          "---\nname: nano-pdf\ndescription: Edit PDFs.\n---\n\nUse nano-pdf.\n",
        "skills/other/SKILL.md": "---\nname: other\ndescription: Other.\n---\n\nOther.\n",
      },
      { ref: "main" },
    );
    const fetch = fakeFetch({ [SEARCH_PDF]: searchResponse(true), ...repo.routes });
    const service = newService(fetch);
    const source = await addDirectory(service);

    expect(await service.browsePage(undefined, { sourceId: source.sourceId })).toEqual({
      items: [],
      hasMore: false,
    });
    const page = await service.browsePage(undefined, { sourceId: source.sourceId, query: "pdf" });
    expect(fetch.calls.filter((url) => url.includes("skillsmp.com"))).toEqual([SEARCH_PDF]);
    expect(page.hasMore).toBe(true);
    expect(page.items).toMatchObject([
      {
        itemId: "skills/nano-pdf",
        name: "nano-pdf",
        source: { kind: "url", url: GITHUB_URL },
        origin: "owner/repo",
        metadataOnly: true,
        stars: 12,
        files: [],
        sourceId: source.sourceId,
      },
    ]);
    // Cached for 10 minutes: the same page again makes no request.
    await service.browsePage(undefined, { sourceId: source.sourceId, query: "pdf" });
    expect(fetch.calls.filter((url) => url.includes("skillsmp.com"))).toHaveLength(1);

    const status = (await service.listSources()).find((s) => s.sourceId === source.sourceId);
    expect(status?.directory?.quota).toEqual({ limit: 50, remaining: 47, resetAtMs: null });

    const item = page.items[0]!;
    const { skill } = await service.install({
      item: { source: item.source, itemId: item.itemId },
      scope: "global",
    });
    expect(skill?.name).toBe("nano-pdf");
    const installed = await fs.readFile(
      path.join(roots.home, ".agents", "skills", "nano-pdf", "SKILL.md"),
      "utf8",
    );
    expect(installed).toContain("Use nano-pdf.");
  });

  it("keeps the API key on the daemon and sends it only to the directory", async () => {
    const fetch = fakeFetch({ [SEARCH_PDF]: searchResponse() });
    const service = newService(fetch);
    const source = await addDirectory(service);

    const updated = await service.setSourceApiKey(source.sourceId, "sk_live_test_value");
    expect(updated.directory?.hasApiKey).toBe(true);
    expect(JSON.stringify(await service.listSources())).not.toContain("sk_live_test_value");
    const credentials = path.join(roots.jdHome, "skills", "credentials.json");
    expect((await fs.stat(credentials)).mode & 0o777).toBe(0o600);

    await service.browsePage(undefined, { sourceId: source.sourceId, query: "pdf" });
    const request = fetch.requests.find((entry) => entry.url === SEARCH_PDF);
    expect(request?.headers.Authorization).toBe("Bearer sk_live_test_value");

    const cleared = await service.setSourceApiKey(source.sourceId, null);
    expect(cleared.directory?.hasApiKey).toBe(false);
  });

  it("reports the daily limit clearly", async () => {
    const fetch = fakeFetch({
      [SEARCH_PDF]: fakeRoute({
        status: 429,
        body: { success: false, error: { code: "DAILY_QUOTA_EXCEEDED", message: "limit" } },
      }),
    });
    const service = newService(fetch);
    const source = await addDirectory(service);
    await expect(
      service.browsePage(undefined, { sourceId: source.sourceId, query: "pdf" }),
    ).rejects.toMatchObject({
      code: "source_fetch_failed",
      message: expect.stringContaining("daily search limit reached"),
    });
  });

  it("rejects a web page that is not an index or a known directory", async () => {
    const fetch = fakeFetch({
      "https://skills.directory.invalid/": fakeRoute({ body: "<!DOCTYPE html><html></html>" }),
    });
    const service = newService(fetch);
    await service.initialize();
    await expect(service.addSource("https://skills.directory.invalid/")).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("is a web page, not a skills index"),
    });
    expect((await service.listSources()).some((s) => s.spec.kind === "index")).toBe(false);
  });
});
