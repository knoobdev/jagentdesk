import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { DiffStat } from "@/components/diff-stat";
import { composerPillStyles } from "@/composer/pill-styles";
import { useSessionStore } from "@/stores/session-store";

interface ComposerDiffStatPillProps {
  additions: number;
  deletions: number;
  onPress: () => void;
}

export function ComposerDiffStatPill({ additions, deletions, onPress }: ComposerDiffStatPillProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );

  return (
    <Pressable
      testID="composer-diff-stat-pill"
      accessibilityRole="button"
      accessibilityLabel={t("workspace.git.diff.openChangesTab")}
      onPress={onPress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
    >
      <DiffStat additions={additions} deletions={deletions} />
    </Pressable>
  );
}

interface WorkspaceDiffStat {
  additions: number;
  deletions: number;
}

function hasDiffStatChanges(diffStat: WorkspaceDiffStat | null | undefined): boolean {
  return Boolean(diffStat && (diffStat.additions > 0 || diffStat.deletions > 0));
}

/** The workspace's uncommitted changes as a pill in the composer rail; pressing it opens Changes. */
export const WorkspaceDiffStatPill = memo(function WorkspaceDiffStatPill({
  serverId,
  workspaceId,
  onPress,
}: {
  serverId: string;
  workspaceId: string;
  onPress: (workspaceDirectory: string) => void;
}): ReactElement | null {
  const workspace = useSessionStore((state) =>
    state.sessions[serverId]?.workspaces.get(workspaceId),
  );
  const diffStat = workspace?.diffStat;
  const workspaceDirectory = workspace?.workspaceDirectory;
  const handlePress = useCallback(() => {
    if (workspaceDirectory) onPress(workspaceDirectory);
  }, [onPress, workspaceDirectory]);
  if (!diffStat || !hasDiffStatChanges(diffStat) || !workspaceDirectory) {
    return null;
  }
  return (
    <ComposerDiffStatPill
      additions={diffStat.additions}
      deletions={diffStat.deletions}
      onPress={handlePress}
    />
  );
});
