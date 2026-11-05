/**
 * Whether the left sidebar footer may render its "Add project" affordance.
 *
 * The Figma section has its own add controls in the top bar and sidebar, and the
 * workspace-oriented "Add project" modal is meaningless while a Figma section route
 * is mounted, so the footer hides it for exactly that route — nothing else changes.
 * Desktop section routes look like `/h/<serverId>/figma/...`; the section can also
 * appear as a bare `/figma` prefix. Pure and dependency-free so the rule is
 * unit-testable without mounting the sidebar (re-exported from left-sidebar.tsx).
 */
function isFigmaSectionRoute(route: string): boolean {
  const segments = route.replace(/^\/+/, "").split("/");
  if (segments[0] === "figma") return true;
  return segments[0] === "h" && segments[2] === "figma";
}

export function shouldShowAddProject(sectionRoute: string | null): boolean {
  if (!sectionRoute) return true;
  return !isFigmaSectionRoute(sectionRoute);
}
