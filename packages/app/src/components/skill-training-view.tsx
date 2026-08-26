import { useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ThumbsUp,
  ThumbsDown,
  GraduationCap,
  Play,
  X,
  Check,
  Sparkles,
  Lightbulb,
  Pencil,
  Trash2,
} from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  useSkillsStore,
  levelProgress,
  approvalRate,
  graduationStatus,
  type Skill,
  type LearnedEntry,
} from "@/stores/skills-store";
import type { Theme } from "@/styles/theme";

const ThemedThumbsUp = withUnistyles(ThumbsUp);
const ThemedThumbsDown = withUnistyles(ThumbsDown);
const ThemedGraduationCap = withUnistyles(GraduationCap);
const ThemedPlay = withUnistyles(Play);
const ThemedX = withUnistyles(X);
const ThemedCheck = withUnistyles(Check);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedLightbulb = withUnistyles(Lightbulb);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentFgColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const okColor = (theme: Theme) => ({ color: theme.colors.palette.green[500] });
const dimColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/**
 * Read-only "Growth" view for a Skill: shows level/XP/tier, the graduation
 * checklist, this skill's stats, and everything the skill has *learned from real
 * conversations* — approved answers and agent-proposed lessons. There is no
 * hand-typed instruction input; knowledge only enters a skill by rating a real
 * assistant message 👍 (see AgentSkillTrainBar) or approving an agent-proposed
 * lesson. Learned entries can be reviewed and removed here.
 */
export function SkillTrainingView({
  skill,
  onClose,
  onUse,
}: {
  skill: Skill;
  onClose: () => void;
  onUse: (s: Skill) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const graduateSkill = useSkillsStore((s) => s.graduateSkill);
  const resolveProposedLearning = useSkillsStore((s) => s.resolveProposedLearning);

  const prog = levelProgress(skill.xp);
  const grad = graduationStatus(skill);
  const pct = Math.round(approvalRate(skill) * 100);
  const graduated = skill.status === "graduated";
  const learned = skill.learned ?? [];

  const handleGraduate = useCallback(() => graduateSkill(skill.id), [graduateSkill, skill.id]);
  const handleRunInAgent = useCallback(() => onUse(skill), [onUse, skill]);
  const handleApproveLesson = useCallback(
    (entryId: string) => resolveProposedLearning(skill.id, entryId, true),
    [resolveProposedLearning, skill.id],
  );
  const handleRemoveLesson = useCallback(
    (entryId: string) => resolveProposedLearning(skill.id, entryId, false),
    [resolveProposedLearning, skill.id],
  );

  const growth = (
    <View style={styles.side}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Growth</Text>
        <Text style={styles.levelBig}>
          Lv {prog.level} · {prog.tier}
        </Text>
        <Text style={styles.xpText}>
          {prog.atMax ? "Max level" : `${prog.inLevel}/${prog.forLevel} XP`}
        </Text>
        <View style={styles.xpTrack}>
          <View style={[styles.xpFill, { width: `${(prog.inLevel / prog.forLevel) * 100}%` }]} />
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Graduation checklist</Text>
        {grad.items.map((it) => (
          <View key={it.label} style={styles.checkRow}>
            {it.done ? (
              <ThemedCheck size={14} uniProps={okColor} />
            ) : (
              <View style={styles.checkEmpty} />
            )}
            <Text style={it.done ? styles.checkDone : styles.checkText}>{it.label}</Text>
            <Text style={styles.checkCount}>
              {it.have}/{it.need}
            </Text>
          </View>
        ))}
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>This skill</Text>
        <Stat label="Runs" value={String(skill.runs)} />
        <Stat label="Approval rate" value={`${pct}%`} />
        <Stat label="Lessons learned" value={String(learned.length)} />
        <Stat label="Consecutive 👍" value={String(skill.consecutiveApprovals)} />
      </View>
    </View>
  );

  const main = (
    <View style={styles.main}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Instructions</Text>
        <ScrollView style={styles.instrScroll} nestedScrollEnabled>
          {instructionLines(skill.instructions).map((line) => (
            <Text
              key={line.key}
              style={line.learned ? styles.instrLearned : styles.instrLine}
              selectable
            >
              {line.text || " "}
              {line.learned ? "  ← learned" : ""}
            </Text>
          ))}
        </ScrollView>
      </View>

      <View style={styles.panel}>
        <View style={styles.learnedHead}>
          <ThemedSparkles size={13} uniProps={accentColor} />
          <Text style={styles.panelTitle}>Learned from conversations</Text>
        </View>
        {learned.length === 0 ? (
          <Text style={styles.emptyText}>
            Nothing learned yet. In an agent using this skill, approve a reply 👍 or accept an
            agent-proposed lesson to teach it — no hand-typed instructions.
          </Text>
        ) : (
          learned.map((entry) => (
            <LearnedRow
              key={entry.id}
              entry={entry}
              onApprove={handleApproveLesson}
              onRemove={handleRemoveLesson}
            />
          ))
        )}
      </View>

      <Pressable style={styles.runBtn} onPress={handleRunInAgent}>
        <ThemedPlay size={14} uniProps={mutedColor} />
        <Text style={styles.runText}>Run this skill in an agent to test</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={styles.overlay}>
      <View style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.headIcon}>
            <Text style={styles.headIconText}>{skill.icon}</Text>
          </View>
          <View style={styles.headText}>
            <Text style={styles.headName} numberOfLines={1}>
              {skill.name}
            </Text>
            <Text style={styles.headSub}>
              {graduated ? "GRADUATED" : `TRAINING · LEVEL ${prog.level}`}
            </Text>
          </View>
          {!graduated ? (
            <Pressable
              style={grad.canGraduate ? styles.gradBtn : [styles.gradBtn, styles.gradBtnDisabled]}
              onPress={grad.canGraduate ? handleGraduate : undefined}
            >
              <ThemedGraduationCap size={15} uniProps={accentFgColor} />
              <Text style={styles.gradBtnText}>
                {grad.canGraduate
                  ? "Graduate to Skill"
                  : `${grad.items.filter((i) => !i.done).length} checks left`}
              </Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.closeBtn} onPress={onClose} accessibilityLabel="Close growth">
            <ThemedX size={18} uniProps={mutedColor} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={isCompact ? styles.bodyCompact : styles.body}>
          {main}
          {growth}
        </ScrollView>
      </View>
    </View>
  );
}

const LEARNED_LABEL: Record<LearnedEntry["source"], string> = {
  "approved-answer": "Approved answer",
  proposed: "Proposed lesson",
  correction: "Correction",
};

function instructionLines(instructions: string): { key: string; text: string; learned: boolean }[] {
  return instructions.split("\n").map((text, idx) => ({
    key: `instr-${idx}`,
    text,
    learned: text.includes("(learned)"),
  }));
}

function iconForLearned(source: LearnedEntry["source"]) {
  if (source === "approved-answer") return ThemedThumbsUp;
  if (source === "correction") return ThemedPencil;
  return ThemedLightbulb;
}

function LearnedRow({
  entry,
  onApprove,
  onRemove,
}: {
  entry: LearnedEntry;
  onApprove: (entryId: string) => void;
  onRemove: (entryId: string) => void;
}) {
  const pending = entry.source === "proposed" && !entry.approved;
  const label = LEARNED_LABEL[entry.source];
  const approve = useCallback(() => onApprove(entry.id), [onApprove, entry.id]);
  const remove = useCallback(() => onRemove(entry.id), [onRemove, entry.id]);
  const Icon = iconForLearned(entry.source);

  return (
    <View style={pending ? [styles.learnedRow, styles.learnedRowPending] : styles.learnedRow}>
      <View style={styles.learnedTopRow}>
        <Icon size={12} uniProps={pending ? accentColor : okColor} />
        <Text style={styles.learnedSource}>{pending ? "Proposed lesson · pending" : label}</Text>
        {!pending ? (
          <Pressable style={styles.iconBtn} onPress={remove} accessibilityLabel="Remove lesson">
            <ThemedTrash size={13} uniProps={dimColor} />
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.learnedText} selectable>
        {entry.content}
      </Text>
      {pending ? (
        <View style={styles.learnedActions}>
          <Pressable style={styles.rejectBtn} onPress={remove}>
            <ThemedThumbsDown size={13} uniProps={mutedColor} />
            <Text style={styles.rejectText}>Reject</Text>
          </Pressable>
          <Pressable style={styles.approveBtn} onPress={approve}>
            <ThemedCheck size={13} uniProps={accentFgColor} />
            <Text style={styles.approveText}>Approve</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  sheet: {
    width: "100%",
    maxWidth: 1040,
    maxHeight: "92%",
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headIcon: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  headIconText: { fontSize: 20 },
  headText: { flex: 1, minWidth: 0 },
  headName: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  headSub: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    letterSpacing: 0.5,
  },
  gradBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  gradBtnDisabled: { opacity: 0.5 },
  gradBtnText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  closeBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  body: { flexDirection: "row", gap: theme.spacing[4], padding: theme.spacing[4] },
  bodyCompact: { flexDirection: "column", gap: theme.spacing[4], padding: theme.spacing[4] },
  main: { flex: 2, minWidth: 0, gap: theme.spacing[4] },
  side: { flex: 1, minWidth: 0, gap: theme.spacing[4] },
  panel: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  panelTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  levelBig: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  xpText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  xpTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  xpFill: { height: 8, borderRadius: 4, backgroundColor: theme.colors.accent },
  instrScroll: { maxHeight: 200 },
  instrLine: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, lineHeight: 20 },
  instrLearned: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.green[500],
    lineHeight: 20,
  },
  learnedHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  emptyText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, lineHeight: 18 },
  learnedRow: {
    gap: theme.spacing[1.5],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  learnedRowPending: { borderColor: theme.colors.accent },
  learnedTopRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  learnedSource: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  learnedText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground, lineHeight: 19 },
  learnedActions: { flexDirection: "row", gap: theme.spacing[2], marginTop: theme.spacing[1] },
  iconBtn: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  approveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1.5],
  },
  approveText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  rejectBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1.5],
  },
  rejectText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[2],
  },
  runText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
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
  checkCount: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  statRow: { flexDirection: "row", justifyContent: "space-between" },
  statLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  statValue: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
}));
