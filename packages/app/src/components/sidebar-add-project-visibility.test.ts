import { describe, expect, it } from "vitest";

import { shouldShowAddProject, shouldShowSidebarFooter } from "./sidebar-add-project-visibility";

describe("shouldShowAddProject", () => {
  it("hides the Add project footer while a Bots section route is active", () => {
    expect(shouldShowAddProject("/bots")).toBe(false);
    expect(shouldShowAddProject("/h/srv1/bots")).toBe(false);
    expect(shouldShowAddProject("/h/srv1/bots?botId=one")).toBe(false);
  });

  it("keeps the footer for other sections, unsectioned routes and unresolved routes", () => {
    expect(shouldShowAddProject("/jira")).toBe(true);
    expect(shouldShowAddProject("/h/srv1/jira")).toBe(true);
    expect(shouldShowAddProject("/h/srv1/bots-ish")).toBe(true);
    expect(shouldShowAddProject(null)).toBe(true);
    expect(shouldShowAddProject("")).toBe(true);
  });
});

describe("shouldShowSidebarFooter", () => {
  it("hides the whole footer container (divider included) for the Bots section", () => {
    // With "Add project" hidden the footer would render nothing but its border and padding —
    // an empty strip at the bottom of the column the Bots nav owns.
    expect(shouldShowSidebarFooter("/bots")).toBe(false);
    expect(shouldShowSidebarFooter("/h/host/bots?botId=one")).toBe(false);
  });

  it("keeps the footer container for every other route", () => {
    expect(shouldShowSidebarFooter("/jira")).toBe(true);
    expect(shouldShowSidebarFooter("/h/srv1/jira")).toBe(true);
    expect(shouldShowSidebarFooter("/h/srv1/sessions")).toBe(true);
    expect(shouldShowSidebarFooter(null)).toBe(true);
    expect(shouldShowSidebarFooter("")).toBe(true);
  });
});
