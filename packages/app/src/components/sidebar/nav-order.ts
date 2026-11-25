// Established destination order. Built-in feature destinations keep their positions; any other
// built-in destination follows Marketplace in load order.
const APP_NAV_ORDER: readonly string[] = [
  "home",
  "sessions",
  "schedules",
  "bots",
  "shared-sessions",
  "skills",
  "marketplace",
  "docker",
  "simulators",
  "workbench",
  "databases",
  "servers",
  "clusters",
  "argocd",
  "usage",
  "insights",
  "jira",
  "forge",
];
const UNPLACED_NAV_RANK = APP_NAV_ORDER.indexOf("marketplace") + 0.5;
export function orderAppNavItems<T extends { key: string }>(items: readonly T[]): T[] {
  const rank = (key: string) => {
    const index = APP_NAV_ORDER.indexOf(key);
    return index === -1 ? UNPLACED_NAV_RANK : index;
  };
  // Hermes has no `toSorted`; Array.prototype.sort is stable.
  return [...items].sort((left, right) => rank(left.key) - rank(right.key));
}
