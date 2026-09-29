import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { Check, GraduationCap } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { levelProgress } from "@jagentdesk/protocol/skills";
import type { SkillEntry, SkillTraining } from "@jagentdesk/protocol/native-skills";
import { Button } from "@/components/ui/button";
import { trainingApprovalRate, trainingChecklist } from "@/skills/native-skill-logic";
import { SectionTitle, SkillBadge } from "@/skills/ui/skill-chrome";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const okColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function XpBar({ training }: { training: SkillTraining }) {
  const { t } = useTranslation();
  const prog = levelProgress(training.xp);
  const fillStyle = useMemo(
    () => [
      styles.xpFill,
      { width: `${Math.round((prog.inLevel / prog.forLevel) * 100)}%` as const },
    ],
    [prog.forLevel, prog.inLevel],
  );
  return (
    <View style={styles.xpBlock}>
      <View style={styles.xpHead}>
        <Text style={styles.level}>
          {t("skillsHub.detail.level", { level: prog.level, tier: prog.tier })}
        </Text>
        <Text style={styles.muted}>
          {prog.atMax
            ? t("skillsHub.detail.maxLevel")
            : t("skillsHub.detail.xp", { have: prog.inLevel, need: prog.forLevel })}
        </Text>
      </View>
      <View style={styles.xpTrack}>
        <View style={fillStyle} />
      </View>
    </View>
  );
}

function Checklist({ training }: { training: SkillTraining }) {
  const { t } = useTranslation();
  const { items } = trainingChecklist(training);
  return (
    <View style={styles.checklist}>
      {items.map((item) => (
        <View key={item.id} style={styles.checkRow}>
          {item.done ? (
            <ThemedCheck size={14} uniProps={okColor} />
          ) : (
            <View style={styles.checkEmpty} />
          )}
          <Text style={item.done ? styles.checkDone : styles.checkText}>
            {t(`skillsHub.detail.checklist.${item.id}`)}
          </Text>
          <Text style={styles.muted}>
            {item.have}/{item.need}
          </Text>
        </View>
      ))}
    </View>
  );
}

interface SkillGrowthProps {
  entry: SkillEntry;
  onGraduate: (entry: SkillEntry) => void;
  onForkToTrain: (entry: SkillEntry) => void;
}

/**
 * Training state of a skill (spec 22.9): XP/level/graduation kept from the
 * previous design, read from the lock file via `SkillEntry.training`. Lessons
 * live in SKILL.md (`<!-- jagentdesk:lessons -->`), rendered in the body below.
 */
export function SkillGrowth({ entry, onGraduate, onForkToTrain }: SkillGrowthProps) {
  const { t } = useTranslation();
  const handleGraduate = useCallback(() => onGraduate(entry), [entry, onGraduate]);
  const handleFork = useCallback(() => onForkToTrain(entry), [entry, onForkToTrain]);
  const training = entry.training;
  if (!entry.owned || !training) {
    return (
      <View style={styles.block}>
        <SectionTitle title={t("skillsHub.detail.growth")} />
        <Text style={styles.muted}>{t("skillsHub.detail.notOwnedHint")}</Text>
        <View style={styles.row}>
          <Button
            variant="outline"
            size="sm"
            onPress={handleFork}
            testID="skills-detail-fork-train"
          >
            {t("skillsHub.confirm.fork")}
          </Button>
        </View>
      </View>
    );
  }
  const graduated = training.status === "graduated";
  const { canGraduate } = trainingChecklist(training);
  const rate = Math.round(trainingApprovalRate(training) * 100);
  return (
    <View style={styles.block} testID="skills-detail-growth">
      <SectionTitle title={t("skillsHub.detail.growth")} />
      <View style={styles.row}>
        <SkillBadge
          label={t(graduated ? "skillsHub.badges.graduated" : "skillsHub.badges.training")}
          tone={graduated ? "accent" : "muted"}
        />
      </View>
      <XpBar training={training} />
      <View style={styles.stats}>
        <Stat label={t("skillsHub.detail.runs")} value={String(training.runs)} />
        <Stat label={t("skillsHub.detail.approvalRate")} value={`${rate}%`} />
        <Stat label={t("skillsHub.detail.lessons")} value={String(training.lessons)} />
        <Stat label={t("skillsHub.detail.streak")} value={String(training.consecutiveApprovals)} />
      </View>
      {graduated ? null : <Checklist training={training} />}
      {graduated ? null : (
        <View style={styles.row}>
          <Button
            variant="default"
            size="sm"
            leftIcon={GraduationCap}
            onPress={handleGraduate}
            disabled={!canGraduate}
            testID="skills-detail-graduate"
          >
            {t("skillsHub.detail.graduate")}
          </Button>
        </View>
      )}
      <Text style={styles.muted}>{t("skillsHub.detail.trainHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  block: { gap: theme.spacing[2] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  xpBlock: { gap: theme.spacing[1] },
  xpHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  level: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  xpTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  xpFill: { height: 6, borderRadius: 3, backgroundColor: theme.colors.accent },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  stat: {
    minWidth: 96,
    flexGrow: 1,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    gap: 2,
  },
  statValue: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  statLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  checklist: { gap: theme.spacing[1.5] },
  checkRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  checkEmpty: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  checkText: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  checkDone: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.foreground },
}));
