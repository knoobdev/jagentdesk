import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ThumbsUp,
  ThumbsDown,
  GraduationCap,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Check,
  X,
} from "lucide-react-native";
import { useSessionStore } from "@/stores/session-store";
import { useSkillsStore, levelProgress, type Skill } from "@/stores/skills-store";
import { useAgentSkillsStore, selectAttachedSkillIds } from "@/stores/agent-skills-store";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";

const ThemedThumbsUp = withUnistyles(ThumbsUp);
const ThemedThumbsDown = withUnistyles(ThumbsDown);
const ThemedGraduationCap = withUnistyles(GraduationCap);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedLightbulb = withUnistyles(Lightbulb);
const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const accentFgColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface LatestReply {
  text: string;
  messageId: string;
}

/** The most recent assistant_message in an agent's timeline — its text is what a
 * 👍 captures as skill knowledge and what an agent-proposed lesson is derived from. */
function latestReplyOf(items: StreamItem[] | undefined): LatestReply | undefined {
  if (!items) return undefined;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "assistant_message" && item.text.trim()) {
      return { text: item.text.trim(), messageId: item.messageId ?? item.id };
    }
  }
  return undefined;
}

/** Derive a short, one-line "lesson" the agent proposes from its last reply. A real
 * LLM-generated proposal can replace this later; the store wiring is identical. */
function conciseLessonFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return firstSentence.length > 160 ? `${firstSentence.slice(0, 159)}…` : firstSentence;
}

/** One selectable skill in the train bar's picker (shown when the agent uses
 * more than one skill). Extracted so its onPress is a stable callback. */
function SkillChip({
  skill,
  active,
  onSelect,
}: {
  skill: Skill;
  active: boolean;
  onSelect: (skillId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(skill.id), [onSelect, skill.id]);
  return (
    <Pressable
      style={active ? [styles.skillChip, styles.skillChipActive] : styles.skillChip}
      onPress={handlePress}
    >
      <Text style={active ? styles.skillChipTextActive : styles.skillChipText} numberOfLines={1}>
        {skill.icon} {skill.name}
      </Text>
    </Pressable>
  );
}

/**
 * A floating bar shown inside an agent conversation when that agent is using one
 * or more Skills. Since the B3 redesign a skill is ATTACHED to an existing agent
 * (composer skill picker → useAgentSkillsStore) or auto-loaded by message match —
 * it is no longer a label on a skill-spawned agent — so the trainable skills are
 * the union of the agent's attached + injected skill ids, resolved against the
 * daemon-owned skills store. Training happens from the REAL conversation — no
 * hand-typed instructions:
 *  - 👍 / 👎 on the agent's latest reply: 👍 captures that reply's text as approved
 *    knowledge (learnFromMessage, rating "up"); 👎 records a negative run.
 *  - "Suggested lesson": the agent proposes a concise lesson derived from its last
 *    reply; Approve keeps it (proposeLearning + resolveProposedLearning), Reject drops it.
 * When several skills are active the user picks which one this reply trains.
 */
export function AgentSkillTrainBar({ serverId, agentId }: { serverId: string; agentId: string }) {
  const streamItems = useSessionStore((state) =>
    state.sessions[serverId]?.agentStreamTail?.get(agentId),
  );
  const skills = useSkillsStore((s) => s.skills);
  const attachedIds = useAgentSkillsStore(selectAttachedSkillIds(agentId));
  const injectedIds = useAgentSkillsStore((s) => s.injected[agentId]);
  const learnFromMessage = useSkillsStore((s) => s.learnFromMessage);
  const proposeLearning = useSkillsStore((s) => s.proposeLearning);
  const resolveProposedLearning = useSkillsStore((s) => s.resolveProposedLearning);

  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // messageId of the reply whose proposed lesson the user already acted on/dismissed.
  const [proposalDoneFor, setProposalDoneFor] = useState<string | null>(null);
  // Which active skill the reply trains when the agent uses more than one.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Skills active on this agent: manually attached ∪ auto-loaded (injected),
  // resolved against the daemon-owned list (drops any that no longer exist).
  const activeSkills = useMemo<Skill[]>(() => {
    const ids = Array.from(new Set<string>([...attachedIds, ...(injectedIds ?? [])]));
    return ids.map((id) => skills.find((s) => s.id === id)).filter((s): s is Skill => Boolean(s));
  }, [attachedIds, injectedIds, skills]);

  const skill = useMemo<Skill | undefined>(() => {
    if (activeSkills.length === 0) return undefined;
    return activeSkills.find((s) => s.id === selectedId) ?? activeSkills[0];
  }, [activeSkills, selectedId]);

  const latest = useMemo(() => latestReplyOf(streamItems), [streamItems]);

  const showFlash = useCallback((message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1800);
  }, []);

  const skillIdValue = skill?.id;
  const rate = useCallback(
    (rating: "up" | "down") => {
      if (!skillIdValue || !latest) return;
      learnFromMessage(skillIdValue, { content: latest.text, rating, messageId: latest.messageId });
      showFlash(rating === "up" ? "+60 XP · learned this reply" : "+15 XP · noted");
    },
    [skillIdValue, latest, learnFromMessage, showFlash],
  );

  const approveLesson = useCallback(() => {
    if (!skillIdValue || !latest) return;
    const entryId = proposeLearning(skillIdValue, conciseLessonFrom(latest.text), latest.messageId);
    resolveProposedLearning(skillIdValue, entryId, true);
    setProposalDoneFor(latest.messageId);
    showFlash("Lesson saved to skill");
  }, [skillIdValue, latest, proposeLearning, resolveProposedLearning, showFlash]);

  const rejectLesson = useCallback(() => {
    if (latest) setProposalDoneFor(latest.messageId);
  }, [latest]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);
  const rateUp = useCallback(() => rate("up"), [rate]);
  const rateDown = useCallback(() => rate("down"), [rate]);

  if (!skill) return null;
  const prog = levelProgress(skill.xp);
  const proposal =
    latest && latest.messageId !== proposalDoneFor ? conciseLessonFrom(latest.text) : null;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar}>
        <Pressable style={styles.head} onPress={toggleExpanded}>
          <ThemedGraduationCap size={14} uniProps={accentColor} />
          <Text style={styles.title} numberOfLines={1}>
            Train {skill.name}
          </Text>
          {proposal && !expanded ? <View style={styles.dot} /> : null}
          <Text style={styles.level}>Lv {prog.level}</Text>
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedColor} />
          ) : (
            <ThemedChevronUp size={14} uniProps={mutedColor} />
          )}
        </Pressable>
        {flash ? <Text style={styles.flash}>{flash}</Text> : null}
        {expanded ? (
          <View style={styles.body}>
            {activeSkills.length > 1 ? (
              <View style={styles.skillPicker}>
                {activeSkills.map((s) => (
                  <SkillChip
                    key={s.id}
                    skill={s}
                    active={s.id === skill.id}
                    onSelect={setSelectedId}
                  />
                ))}
              </View>
            ) : null}
            <Text style={styles.caption}>Latest reply</Text>
            {latest ? (
              <Text style={styles.replyPreview} numberOfLines={3}>
                {latest.text}
              </Text>
            ) : (
              <Text style={styles.waiting}>Waiting for the agent to reply…</Text>
            )}
            <View style={styles.rateRow}>
              <Pressable
                style={latest ? styles.reject : [styles.reject, styles.disabled]}
                onPress={latest ? rateDown : undefined}
              >
                <ThemedThumbsDown size={14} uniProps={mutedColor} />
                <Text style={styles.rejectText}>Needs work</Text>
              </Pressable>
              <Pressable
                style={latest ? styles.approve : [styles.approve, styles.disabled]}
                onPress={latest ? rateUp : undefined}
              >
                <ThemedThumbsUp size={14} uniProps={accentFgColor} />
                <Text style={styles.approveText}>Approve reply</Text>
              </Pressable>
            </View>

            {proposal ? (
              <View style={styles.proposalBox}>
                <View style={styles.proposalHead}>
                  <ThemedLightbulb size={13} uniProps={accentColor} />
                  <Text style={styles.proposalTitle}>Agent proposes a lesson</Text>
                </View>
                <Text style={styles.proposalText}>{proposal}</Text>
                <View style={styles.rateRow}>
                  <Pressable style={styles.reject} onPress={rejectLesson}>
                    <ThemedX size={13} uniProps={mutedColor} />
                    <Text style={styles.rejectText}>Reject</Text>
                  </Pressable>
                  <Pressable style={styles.approve} onPress={approveLesson}>
                    <ThemedCheck size={13} uniProps={accentFgColor} />
                    <Text style={styles.approveText}>Approve</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
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
    maxWidth: 320,
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
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.accent },
  level: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  flash: { fontSize: theme.fontSize.xs, color: theme.colors.accent },
  body: { gap: theme.spacing[2] },
  skillPicker: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  skillChip: {
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    maxWidth: 150,
  },
  skillChipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  skillChipText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  skillChipTextActive: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  caption: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  replyPreview: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 17,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    paddingLeft: theme.spacing[2],
  },
  waiting: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    fontStyle: "italic",
  },
  rateRow: { flexDirection: "row", gap: theme.spacing[2] },
  disabled: { opacity: 0.4 },
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
  approveText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
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
  proposalBox: {
    gap: theme.spacing[1.5],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface0,
  },
  proposalHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  proposalTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  proposalText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 17,
  },
}));
