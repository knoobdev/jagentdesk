import { describe, expect, it } from "vitest";
import { buildMobileMetaParts } from "./agent-list";

describe("buildMobileMetaParts", () => {
  it("keeps project, branch and workspace in order", () => {
    expect(buildMobileMetaParts("jagentdesk", "main", "wks-feature")).toEqual([
      { key: "project", text: "jagentdesk" },
      { key: "branch", text: "main" },
      { key: "workspace", text: "wks-feature" },
    ]);
  });

  it("drops an empty branch and a workspace that repeats the project", () => {
    expect(buildMobileMetaParts("docs-reviewer", "", "docs-reviewer")).toEqual([
      { key: "project", text: "docs-reviewer" },
    ]);
  });

  it("returns nothing when every part is blank", () => {
    expect(buildMobileMetaParts(" ", "", "")).toEqual([]);
  });
});
