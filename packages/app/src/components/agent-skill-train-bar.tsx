import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ThumbsUp, ThumbsDown, GraduationCap, ChevronDown, ChevronUp } from "lucide-react-native";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { useSessionStore } from "@/stores/session-store";
import { useSkillsStore, levelProgress } from "@/stores/skills-store";
import type { Theme } from "@/styles/theme";

const ThemedThumbsUp = withUnistyles(ThumbsUp);
const ThemedThumbsDown = withUnistyles(ThumbsDown);
const ThemedGraduationCap = withUnistyles(GraduationCap);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const accentFgColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const SKILL_ID_LABEL = "jagentdesk.skill.id";

/**
 * A floating bar shown inside an agent conversation when that agent was spawned
 * from a Skill (carries the jagentdesk.skill.id label). It lets you train the
 * skill directly from the run — rate the agent's work 👍/👎 and optionally add a
 * correction — which awards XP and grows the skill's instructions, exactly like
 * the Skills training screen but without leaving the conversation.
 */
export function AgentSkillTrainBar({ serverId, agentId }: { serverId: string; agentId: string }) {
  const skillId = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.labels[SKILL_ID_LABEL],
  );
  const agentTitle = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.title,
  );
  const skill = useSkillsStore((s) => (skillId ? s.skills.find((x) => x.id === skillId) : undefined));
  const recordTraining = useSkillsStore((s) => s.recordTraining);

  const [expanded, setExpanded] = useState(false);
  const [correction, setCorrection] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);

  const rate = useCallback(
    (rating: "up" | "down") => {
      if (!skill) return;
      recordTraining(skill.id, { task: agentTitle || skill.name, rating, correction });
      setCorrection("");
      setResetKey((k) => k + 1);
      setFlash(rating === "up" ? "+60 XP · approved" : "+15 XP · noted");
      setTimeout(() => setFlash(null), 1800);
    },
    [skill, agentTitle, correction, recordTraining],
  );

  if (!skill) return null;
  const prog = levelProgress(skill.xp);

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar}>
        <Pressable style={styles.head} onPress={() => setExpanded((v) => !v)}>
          <ThemedGraduationCap size={14} uniProps={accentColor} />
          <Text style={styles.title} numberOfLines={1}>
            Train {skill.name}
          </Text>
          <Text style={styles.level}>
            Lv {prog.level}
          </Text>
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedColor} />
          ) : (
            <ThemedChevronUp size={14} uniProps={mutedColor} />
          )}
        </Pressable>
        {flash ? <Text style={styles.flash}>{flash}</Text> : null}
        {expanded ? (
          <View style={styles.body}>
            <AdaptiveTextInput
              style={styles.input}
              resetKey={`corr-${resetKey}`}
              initialValue=""
              multiline
              placeholder="Correction (optional — taught to the skill)"
              onChangeText={setCorrection}
            />
            <View style={styles.rateRow}>
              <Pressable style={styles.reject} onPress={() => rate("down")}>
                <ThemedThumbsDown size={14} uniProps={mutedColor} />
                <Text style={styles.rejectText}>Needs work</Text>
              </Pressable>
              <Pressable style={styles.approve} onPress={() => rate("up")}>
                <ThemedThumbsUp size={14} uniProps={accentFgColor} />
                <Text style={styles.approveText}>Approve</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  wrap: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[3],
    zIndex: 20,
    maxWidth: 300,
  },
  bar: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: theme.spacing[2],
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  title: { flex: 1, minWidth: 0, fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.semibold, color: theme.colors.foreground },
  level: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  flash: { fontSize: theme.fontSize.xs, color: theme.colors.accent },
  body: { gap: theme.spacing[2] },
  input: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.xs,
    minHeight: 44,
  },
  rateRow: { flexDirection: "row", gap: theme.spacing[2] },
  approve: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1.5],
  },
  approveText: { fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.semibold, color: theme.colors.accentForeground },
  reject: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1.5],
  },
  rejectText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
