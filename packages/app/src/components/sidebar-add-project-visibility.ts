/**
 * Whether the left sidebar footer may render its "Add project" affordance.
 *
 * The Figma and Bots sections have their own add controls in the top bar and sidebar, and the
 * workspace-oriented "Add project" modal is meaningless while a Figma section route
 * is mounted, so the footer hides it for those routes.
 * Desktop section routes look like `/h/<serverId>/figma/...`; the section can also
 * appear as a bare `/figma` prefix. Pure and dependency-free so the rule is
 * unit-testable without mounting the sidebar (re-exported from left-sidebar.tsx).
 */
function ownsSectionColumn(route: string): boolean {
  const segments = route.split(/[?#]/, 1)[0].replace(/^\/+/, "").split("/");
  if (segments[0] === "figma" || segments[0] === "bots") return true;
  return segments[0] === "h" && (segments[2] === "figma" || segments[2] === "bots");
}

export function shouldShowAddProject(sectionRoute: string | null): boolean {
  if (!sectionRoute) return true;
  return !ownsSectionColumn(sectionRoute);
}

/**
 * Whether the left sidebar footer container may render at all.
 *
 * The Figma and Bots sections own the whole left column: with "Add project" hidden the
 * footer would leave nothing but its own divider and an empty strip, so the container goes
 * too. Other routes keep the footer exactly as it is.
 */
export function shouldShowSidebarFooter(sectionRoute: string | null): boolean {
  if (!sectionRoute) return true;
  return !ownsSectionColumn(sectionRoute);
}
