import { describe, expect, it } from "vitest";
import { buildWorkingDirectorySuggestions } from "./working-directory-suggestions";

describe("buildWorkingDirectorySuggestions", () => {
  it("returns de-duplicated recommendations when query is empty", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/jagentdesk", "/Users/me/projects/jagentdesk"],
      serverPaths: ["/Users/me/projects/playground"],
      query: "",
    });

    expect(results).toEqual(["/Users/me/projects/jagentdesk"]);
  });

  it("keeps fuzzy recommendation matches before de-duplicated daemon suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/jagentdesk-desktop", "/Users/me/documents"],
      serverPaths: ["/Users/me/projects/jagentdesk-plan", "/Users/me/projects/jagentdesk-desktop"],
      query: "pso",
    });

    expect(results).toEqual(["/Users/me/projects/jagentdesk-desktop", "/Users/me/projects/jagentdesk-plan"]);
  });

  it("does not reinterpret daemon-ranked suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [],
      serverPaths: ["/Users/me/projects/jagentdesk-desktop"],
      query: "a-query-ranked-by-the-daemon",
    });

    expect(results).toEqual(["/Users/me/projects/jagentdesk-desktop"]);
  });

  it("leaves path-query semantics to the daemon", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: [
        "/Users/me/archive/projects/jagentdesk-desktop",
        "/Users/me/projects/jagentdesk-desktop",
      ],
      serverPaths: [],
      query: "~/projects/pso",
    });

    expect(results).toEqual([]);
  });

  it("treats '~' as an active query and includes daemon suggestions", () => {
    const results = buildWorkingDirectorySuggestions({
      recommendedPaths: ["/Users/me/projects/jagentdesk"],
      serverPaths: ["/Users/me/documents", "/Users/me/projects"],
      query: "~",
    });

    expect(results).toEqual([
      "/Users/me/projects/jagentdesk",
      "/Users/me/documents",
      "/Users/me/projects",
    ]);
  });
});
