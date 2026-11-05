import { describe, expect, it } from "vitest";

import { shouldShowAddProject } from "./sidebar-add-project-visibility";

describe("shouldShowAddProject", () => {
  it("hides the Add project footer while a Figma section route is active", () => {
    expect(shouldShowAddProject("/figma")).toBe(false);
    expect(shouldShowAddProject("/figma/project/123")).toBe(false);
    expect(shouldShowAddProject("/h/srv1/figma")).toBe(false);
    expect(shouldShowAddProject("/h/srv1/figma/branch-1/file-2")).toBe(false);
  });

  it("keeps the footer for other sections, unsectioned routes and unresolved routes", () => {
    expect(shouldShowAddProject("/jira")).toBe(true);
    expect(shouldShowAddProject("/h/srv1/jira")).toBe(true);
    expect(shouldShowAddProject("/h/srv1/figma-ish")).toBe(true);
    expect(shouldShowAddProject(null)).toBe(true);
    expect(shouldShowAddProject("")).toBe(true);
  });
});
