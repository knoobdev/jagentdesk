/**
 * The drawer rows predate the grid and their `sidebar-*` testIDs are load-bearing for the
 * mobile e2e suites, so tiles keep those IDs instead of the rail's `rail-*` ones. Keys that
 * did not exist when the grid landed (Figma, later sections) fall back to the rail testID.
 */
const LEGACY_ROW_TEST_IDS: Readonly<Record<string, string>> = {
  sessions: "sidebar-sessions",
  schedules: "sidebar-schedules",
  "shared-sessions": "sidebar-shared-sessions",
  clusters: "sidebar-clusters-nav",
  databases: "sidebar-databases-nav",
  servers: "sidebar-servers-nav",
  argocd: "sidebar-argocd-nav",
  jira: "sidebar-jira-nav",
  skills: "sidebar-skills-nav",
  marketplace: "sidebar-marketplace-nav",
  docker: "sidebar-docker-nav",
  simulators: "sidebar-simulator-nav",
  workbench: "sidebar-workbench-nav",
  insights: "sidebar-insights-nav",
  usage: "sidebar-usage-nav",
  forge: "sidebar-forge-nav",
};

export function mobileNavTileTestID(key: string, railTestID: string): string {
  return LEGACY_ROW_TEST_IDS[key] ?? railTestID;
}
