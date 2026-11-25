import { useCallback, useMemo, useState } from "react";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupItem,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";
const PINNED_POLICY = { kind: "pinned" } as const;
export function useLimitedSidebarGroup<T extends SidebarGroupItem>(
  items: readonly T[],
  policy: SidebarGroupVisibilityPolicy<T> = PINNED_POLICY,
  controlled?: { expanded: boolean; toggleExpanded: () => void },
) {
  const [localExpanded, setExpanded] = useState(false);
  const expanded = controlled?.expanded ?? localExpanded;
  const selection = useActiveWorkspaceSelection();
  const visibility = useMemo(
    () => selectSidebarGroupVisibility({ items, expanded, policy, selection }),
    [expanded, items, policy, selection],
  );
  const toggleExpanded = useCallback(() => setExpanded((current) => !current), []);
  return { ...visibility, expanded, toggleExpanded: controlled?.toggleExpanded ?? toggleExpanded };
}
