import { describe, expect, it } from "vitest";
import type { SkillSourceStatus } from "@jagentdesk/protocol/native-skills";
import {
  BROWSE_ALL_SOURCES,
  BROWSE_PROVIDER_MARKETPLACES,
  browseRequestFor,
  describeSourceAddError,
  describeSourceSpec,
  effectiveBrowseFilter,
  missingDefaultSources,
} from "./skill-sources-logic";

function source(partial: Partial<SkillSourceStatus> & Pick<SkillSourceStatus, "spec">) {
  return {
    sourceId: "src_000000000001",
    label: "label",
    customLabel: null,
    builtin: false,
    enabled: true,
    addedAtMs: 0,
    lastRefreshMs: null,
    itemCount: null,
    revision: null,
    error: null,
    ...partial,
  } satisfies SkillSourceStatus;
}

const anthropics = source({
  sourceId: "src_a",
  builtin: true,
  spec: { kind: "github", owner: "anthropics", repo: "skills", ref: null, subpath: null },
});
const openai = source({
  sourceId: "src_o",
  builtin: true,
  spec: { kind: "github", owner: "openai", repo: "skills", ref: null, subpath: null },
});

describe("browse requests (spec 22.5)", () => {
  it("maps the filter to a merged, single-source or provider-marketplace browse", () => {
    expect(browseRequestFor(BROWSE_ALL_SOURCES)).toEqual({ kind: "configured" });
    expect(browseRequestFor("src_a")).toEqual({ kind: "configured", sourceId: "src_a" });
    expect(browseRequestFor(BROWSE_PROVIDER_MARKETPLACES)).toEqual({
      kind: "provider-marketplace",
    });
  });

  it("falls back to all sources when the chosen source is gone or disabled", () => {
    expect(effectiveBrowseFilter("src_a", [anthropics])).toBe("src_a");
    expect(effectiveBrowseFilter("src_a", [{ ...anthropics, enabled: false }])).toBe(
      BROWSE_ALL_SOURCES,
    );
    expect(effectiveBrowseFilter("src_gone", [anthropics])).toBe(BROWSE_ALL_SOURCES);
    expect(effectiveBrowseFilter("src_a", undefined)).toBe("src_a");
    expect(effectiveBrowseFilter(BROWSE_PROVIDER_MARKETPLACES, [])).toBe(
      BROWSE_PROVIDER_MARKETPLACES,
    );
  });
});

describe("sources sheet", () => {
  it("describes each source kind as the text to add it again", () => {
    expect(
      describeSourceSpec({
        kind: "github",
        owner: "owner",
        repo: "repo",
        ref: "v1",
        subpath: "skills",
      }),
    ).toBe("owner/repo/skills@v1");
    expect(describeSourceSpec({ kind: "npm", pkg: "@scope/pack" })).toBe("npm:@scope/pack");
    expect(describeSourceSpec({ kind: "index", url: "https://host/index.json" })).toBe(
      "https://host/index.json",
    );
    expect(describeSourceSpec({ kind: "local", path: "/srv/skills" })).toBe("/srv/skills");
  });

  it("lists the default repositories missing from the source list", () => {
    expect(missingDefaultSources([anthropics, openai])).toEqual([]);
    expect(missingDefaultSources([openai])).toEqual(["anthropics/skills"]);
    const pinned = source({
      spec: { kind: "github", owner: "anthropics", repo: "skills", ref: "v1", subpath: null },
    });
    expect(missingDefaultSources([pinned])).toEqual(["anthropics/skills", "openai/skills"]);
  });

  it("maps add-source rejections to a validation, fetch or generic error", () => {
    const rpcError = (code: string, message: string) =>
      Object.assign(new Error(`${message} requestType=skills.sources.add.request code=${code}`), {
        code,
      });
    expect(describeSourceAddError(rpcError("invalid_request", "Not a URL: x"))).toEqual({
      kind: "invalid",
      message: "Not a URL: x",
    });
    expect(
      describeSourceAddError(rpcError("source_fetch_failed", "GitHub rate limit; resets at 12:00")),
    ).toEqual({ kind: "fetch", message: "GitHub rate limit; resets at 12:00" });
    expect(describeSourceAddError(new Error("socket closed"))).toEqual({
      kind: "other",
      message: "socket closed",
    });
  });
});
