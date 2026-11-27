/** Every report list of a host: its own and each agent's. */
export function hostUsageQueryKey(serverId: string) {
  return ["usage", serverId] as const;
}

/**
 * A host's own reports. The key differs only by host, so it is read with `dataShape: "value"`:
 * a list shape keeps the previous key's data while the next one loads, which would show one host's
 * reports as another's.
 */
export function usageReportsQueryKey(serverId: string) {
  return [...hostUsageQueryKey(serverId), "reports"] as const;
}
