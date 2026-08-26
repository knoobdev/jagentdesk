import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ThumbsUp, ThumbsDown, GraduationCap, Play, X, Check } from "lucide-react-native";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  useSkillsStore,
  levelProgress,
  approvalRate,
  graduationStatus,
  type Skill,
} from "@/stores/skills-store";
import type { Theme } from "@/styles/theme";

const ThemedThumbsUp = withUnistyles(ThumbsUp);
const ThemedThumbsDown = withUnistyles(ThumbsDown);
const ThemedGraduationCap = withUnistyles(GraduationCap);
const ThemedPlay = withUnistyles(Play);
const ThemedX = withUnistyles(X);
const ThemedCheck = withUnistyles(Check);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentFgColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
const okColor = (theme: Theme) => ({ color: theme.colors.palette.green[500] });
const dimColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/**
 * Training surface for a Skill: give it a task, rate the run 👍/👎, and optionally
 * add a correction that is appended to the skill's instructions ("learned"). Each
 * rating awards XP toward the next level; once the graduation checklist is met the
 * skill can Graduate. Matches docs/design/skills/mock2-train.png.
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
  const recordTraining = useSkillsStore((s) => s.recordTraining);
  const graduateSkill = useSkillsStore((s) => s.graduateSkill);

  const [task, setTask] = useState("");
  const [correction, setCorrection] = useState("");
  const [resetKey, setResetKey] = useState(0);

  const prog = levelProgress(skill.xp);
  const grad = graduationStatus(skill);
  const pct = Math.round(approvalRate(skill) * 100);
  const graduated = skill.status === "graduated";

  const rate = useCallback(
    (rating: "up" | "down") => {
      if (!task.trim()) return;
      recordTraining(skill.id, { task, rating, correction });
      setTask("");
      setCorrection("");
      setResetKey((k) => k + 1);
    },
    [task, correction, recordTraining, skill.id],
  );

  const handleGraduate = useCallback(() => graduateSkill(skill.id), [graduateSkill, skill.id]);
  const handleRunInAgent = useCallback(() => onUse(skill), [onUse, skill]);

  const growth = (
    <View style={styles.side}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Growth</Text>
        <Text style={styles.levelBig}>
          Lv {prog.level} · {prog.tier}
        </Text>
        <Text style={styles.xpText}>{prog.atMax ? "Max level" : `${prog.inLevel}/${prog.forLevel} XP`}</Text>
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
        <Stat label="Examples saved" value={String(skill.examples.length)} />
        <Stat label="Consecutive 👍" value={String(skill.consecutiveApprovals)} />
      </View>
    </View>
  );

  const main = (
    <View style={styles.main}>
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Instructions</Text>
        <ScrollView style={styles.instrScroll} nestedScrollEnabled>
          {skill.instructions.split("\n").map((line, i) => {
            const learned = line.includes("(learned)");
            return (
              <Text key={i} style={learned ? styles.instrLearned : styles.instrLine} selectable>
                {line || " "}
                {learned ? "  ← learned" : ""}
              </Text>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Train by example</Text>
        <Text style={styles.fieldLabel}>Task you gave the skill</Text>
        <AdaptiveTextInput
          style={styles.input}
          resetKey={`task-${resetKey}`}
          initialValue=""
          placeholder="e.g. Diagnose why api-7c9d keeps restarting"
          onChangeText={setTask}
        />
        <Text style={styles.fieldLabel}>Correction (optional — taught to the skill)</Text>
        <AdaptiveTextInput
          style={styles.inputMulti}
          resetKey={`corr-${resetKey}`}
          initialValue=""
          multiline
          placeholder="e.g. Always check the previous container's exit code first"
          onChangeText={setCorrection}
        />
        <View style={styles.rateRow}>
          <Pressable style={styles.rejectBtn} onPress={() => rate("down")}>
            <ThemedThumbsDown size={15} uniProps={mutedColor} />
            <Text style={styles.rejectText}>Needs work</Text>
          </Pressable>
          <Pressable style={styles.approveBtn} onPress={() => rate("up")}>
            <ThemedThumbsUp size={15} uniProps={accentFgColor} />
            <Text style={styles.approveText}>Approve</Text>
          </Pressable>
        </View>
        <Pressable style={styles.runBtn} onPress={handleRunInAgent}>
          <ThemedPlay size={14} uniProps={mutedColor} />
          <Text style={styles.runText}>Run this skill in an agent to test</Text>
        </Pressable>
      </View>

      {skill.examples.length > 0 ? (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Recent examples</Text>
          {skill.examples.slice(0, 6).map((ex) => (
            <View key={ex.id} style={styles.exRow}>
              {ex.rating === "up" ? (
                <ThemedThumbsUp size={12} uniProps={okColor} />
              ) : (
                <ThemedThumbsDown size={12} uniProps={dimColor} />
              )}
              <Text style={styles.exTask} numberOfLines={1}>
                {ex.task}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
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
          <Pressable style={styles.closeBtn} onPress={onClose} accessibilityLabel="Close training">
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
  headName: { fontSize: theme.fontSize.lg, fontWeight: theme.fontWeight.bold, color: theme.colors.foreground },
  headSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted, letterSpacing: 0.5 },
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
  gradBtnText: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.semibold, color: theme.colors.accentForeground },
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
  levelBig: { fontSize: theme.fontSize.xl, fontWeight: theme.fontWeight.bold, color: theme.colors.foreground },
  xpText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  xpTrack: { height: 8, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" },
  xpFill: { height: 8, borderRadius: 4, backgroundColor: theme.colors.accent },
  instrScroll: { maxHeight: 200 },
  instrLine: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, lineHeight: 20 },
  instrLearned: { fontSize: theme.fontSize.sm, color: theme.colors.palette.green[500], lineHeight: 20 },
  fieldLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, marginTop: theme.spacing[1] },
  input: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
  },
  inputMulti: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    minHeight: 60,
  },
  rateRow: { flexDirection: "row", gap: theme.spacing[2], marginTop: theme.spacing[1] },
  approveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
  },
  approveText: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.semibold, color: theme.colors.accentForeground },
  rejectBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
  },
  rejectText: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium, color: theme.colors.foregroundMuted },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    marginTop: theme.spacing[1],
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
  statValue: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.semibold, color: theme.colors.foreground },
  exRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  exTask: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
