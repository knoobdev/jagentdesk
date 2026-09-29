import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillEntry, SkillLink } from "@jagentdesk/protocol/native-skills";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { allKnownSkills, useSkillsStore } from "@/stores/skills-store";
import {
  formatSkillSource,
  skillErrorMessage,
  skillProviderLabel,
} from "@/skills/native-skill-logic";
import { MetaRow, SectionTitle, SkillBadge } from "@/skills/ui/skill-chrome";
import { SkillFileList } from "@/skills/ui/skill-files";
import { SkillGrowth } from "@/skills/ui/skill-growth";
import type { SkillActions } from "@/skills/ui/use-skill-actions";
import type { Theme } from "@/styles/theme";

function PathLine({
  label,
  path,
  onCopy,
}: {
  label: string;
  path: string;
  onCopy: (path: string) => void;
}) {
  const { t } = useTranslation();
  const handleCopy = useCallback(() => onCopy(path), [onCopy, path]);
  return (
    <View style={styles.pathBlock}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        onPress={handleCopy}
        accessibilityRole="button"
        accessibilityLabel={t("skillsHub.detail.copyPath")}
        style={styles.pathRow}
      >
        <Text style={styles.path} selectable>
          {path}
        </Text>
      </Pressable>
    </View>
  );
}

function SkillPaths({ entry, onCopy }: { entry: SkillEntry; onCopy: (path: string) => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.block}>
      <PathLine label={t("skillsHub.detail.realPath")} path={entry.realPath} onCopy={onCopy} />
      {entry.links.map((link: SkillLink) => (
        <PathLine
          key={link.path}
          label={t("skillsHub.detail.linkedInto", { dir: link.dir })}
          path={link.path}
          onCopy={onCopy}
        />
      ))}
    </View>
  );
}

function SkillFacts({ entry }: { entry: SkillEntry }) {
  const { t } = useTranslation();
  const visibleTo = entry.visibleTo.map(skillProviderLabel).join(", ");
  return (
    <View style={styles.metaCard}>
      <MetaRow label={t("skillsHub.detail.scope")} value={t(`skillsHub.scope.${entry.scope}`)} />
      {entry.projectRoot ? (
        <MetaRow label={t("skillsHub.project.label")} value={entry.projectRoot} />
      ) : null}
      <MetaRow label={t("skillsHub.detail.source")} value={formatSkillSource(entry.source)} />
      <MetaRow label={t("skillsHub.detail.visibleTo")} value={visibleTo || "—"} />
    </View>
  );
}

function DetailActions({
  entry,
  actions,
  onEdit,
  onClose,
  onOpenSkill,
}: {
  entry: SkillEntry;
  actions: SkillActions;
  onEdit: (entry: SkillEntry) => void;
  onClose: () => void;
  onOpenSkill: (entry: SkillEntry) => void;
}) {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(entry), [entry, onEdit]);
  const handleFork = useCallback(() => {
    void actions.fork(entry).then((forked) => {
      if (forked) onOpenSkill(forked);
      return undefined;
    });
  }, [actions, entry, onOpenSkill]);
  const handleUninstall = useCallback(() => {
    void actions.uninstall(entry).then((removed) => {
      if (removed) onClose();
      return undefined;
    });
  }, [actions, entry, onClose]);
  return (
    <View style={styles.row}>
      {entry.owned ? (
        <Button variant="default" size="sm" onPress={handleEdit} testID="skills-detail-edit">
          {t("skillsHub.row.edit")}
        </Button>
      ) : null}
      <Button variant="outline" size="sm" onPress={handleFork} testID="skills-detail-fork">
        {t("skillsHub.row.fork")}
      </Button>
      <Button
        variant="destructive"
        size="sm"
        onPress={handleUninstall}
        testID="skills-detail-uninstall"
      >
        {t("skillsHub.row.uninstall")}
      </Button>
    </View>
  );
}

export interface SkillDetailSheetProps {
  serverId: string;
  client: DaemonClient | null;
  skillId: string;
  /** Project root needed to resolve a non-owned project skill. */
  cwd: string | null;
  actions: SkillActions;
  onClose: () => void;
  onEdit: (entry: SkillEntry) => void;
  onOpenSkill: (entry: SkillEntry) => void;
}

/** Installed skill detail (spec 22.6): SKILL.md, files, source, real path + links, training. */
export function SkillDetailSheet(props: SkillDetailSheetProps) {
  const { t } = useTranslation();
  const { serverId, client, skillId, cwd, actions, onClose, onEdit, onOpenSkill } = props;
  const liveEntry = useSkillsStore((state) =>
    allKnownSkills(state).find((entry) => entry.skillId === skillId),
  );
  const detail = useFetchQuery({
    queryKey: [
      "skills-detail",
      serverId,
      skillId,
      cwd ?? "",
      liveEntry?.training?.lessons ?? 0,
      liveEntry?.enabled ?? true,
    ],
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getNativeSkill(skillId, cwd ? { cwd } : {});
    },
    enabled: Boolean(client),
    dataShape: "value",
    staleTimeMs: 5_000,
  });
  const entry = liveEntry ?? detail.data?.skill ?? null;
  const header = useMemo<SheetHeader>(
    () => ({ title: entry?.name ?? skillId, back: { onPress: onClose } }),
    [entry?.name, onClose, skillId],
  );
  const handleGraduate = useCallback(
    (target: SkillEntry) => void actions.graduate(target),
    [actions],
  );
  const handleForkToTrain = useCallback(
    (target: SkillEntry) => {
      void actions.forkToTrain(target).then((forked) => {
        if (forked) onOpenSkill(forked);
        return undefined;
      });
    },
    [actions, onOpenSkill],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="skills-detail-sheet"
      contentStyle={styles.body}
      desktopMaxWidth={640}
    >
      {entry ? (
        <View style={styles.block}>
          <DetailBadges entry={entry} />
          {entry.description ? <Text style={styles.description}>{entry.description}</Text> : null}
          {entry.invalidReason ? (
            <Alert
              variant="error"
              title={t("skillsHub.detail.invalidReason", { reason: entry.invalidReason })}
            />
          ) : null}
          <DetailActions
            entry={entry}
            actions={actions}
            onEdit={onEdit}
            onClose={onClose}
            onOpenSkill={onOpenSkill}
          />
          <SkillFacts entry={entry} />
          <SkillPaths entry={entry} onCopy={actions.copyPath} />
          <SkillGrowth
            entry={entry}
            onGraduate={handleGraduate}
            onForkToTrain={handleForkToTrain}
          />
        </View>
      ) : null}
      <DetailBody
        loading={detail.isLoading}
        error={detail.error}
        body={detail.data?.body ?? null}
        files={detail.data?.files ?? null}
      />
    </AdaptiveModalSheet>
  );
}

function DetailBadges({ entry }: { entry: SkillEntry }) {
  const { t } = useTranslation();
  return (
    <View style={styles.row}>
      <SkillBadge label={t(`skillsHub.scope.${entry.scope}`)} />
      {entry.owned ? <SkillBadge label={t("skillsHub.badges.owned")} tone="accent" /> : null}
      {entry.enabled ? null : <SkillBadge label={t("skillsHub.badges.disabled")} tone="warning" />}
      {entry.status === "invalid" ? (
        <SkillBadge label={t("skillsHub.badges.invalid")} tone="danger" />
      ) : null}
    </View>
  );
}

function DetailBody({
  loading,
  error,
  body,
  files,
}: {
  loading: boolean;
  error: unknown;
  body: string | null;
  files: { path: string; size: number; isScript: boolean }[] | null;
}) {
  const { t } = useTranslation();
  if (loading) return <Text style={styles.muted}>{t("skillsHub.detail.loading")}</Text>;
  if (error) {
    return (
      <Alert
        variant="error"
        title={t("skillsHub.detail.errorTitle")}
        description={skillErrorMessage(error)}
      />
    );
  }
  return (
    <View style={styles.block}>
      {files ? <SkillFileList files={files} /> : null}
      {body ? (
        <View style={styles.block}>
          <SectionTitle title={t("skillsHub.item.instructions")} />
          <MarkdownRenderer text={body} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[6] },
  block: { gap: theme.spacing[3] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  description: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, lineHeight: 20 },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  pathBlock: { gap: theme.spacing[1] },
  pathRow: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  path: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  metaCard: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
}));
