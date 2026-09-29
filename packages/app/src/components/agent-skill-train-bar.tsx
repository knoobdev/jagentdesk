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
  Copy,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { levelProgress } from "@jagentdesk/protocol/skills";
import type { SkillEntry } from "@jagentdesk/protocol/native-skills";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useSkillCatalog } from "@/stores/skills-store";
import {
  useAgentSkillsStore,
  selectAttachedSkillIds,
  selectInjectedSkillIds,
} from "@/stores/agent-skills-store";
import {
  buildLegacyIdMap,
  conciseLessonFrom,
  normalizeSkillIds,
  skillErrorMessage,
} from "@/skills/native-skill-logic";
import { useSkillActions } from "@/skills/ui/use-skill-actions";
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
const ThemedCopy = withUnistyles(Copy);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const accentFgColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface LatestReply {
  text: string;
  messageId: string;
}

/** The most recent assistant_message in an agent's timeline — what 👍/👎 rates. */
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

/** One selectable skill in the train bar (shown when the agent uses several). */
function SkillChip({
  skill,
  active,
  onSelect,
}: {
  skill: SkillEntry;
  active: boolean;
  onSelect: (skillId: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(skill.skillId), [onSelect, skill.skillId]);
  return (
    <Pressable
      style={active ? [styles.skillChip, styles.skillChipActive] : styles.skillChip}
      onPress={handlePress}
    >
      <Text style={active ? styles.skillChipTextActive : styles.skillChipText} numberOfLines={1}>
        {skill.name}
      </Text>
    </Pressable>
  );
}

/** Skills active on the agent (attached ∪ already invoked), resolved against the catalog. */
function useActiveSkills(serverId: string, agentId: string): SkillEntry[] {
  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? null,
  );
  const catalog = useSkillCatalog(agentCwd);
  const attachedIds = useAgentSkillsStore(selectAttachedSkillIds(agentId));
  const injectedIds = useAgentSkillsStore(selectInjectedSkillIds(agentId));
  return useMemo(() => {
    const legacyMap = buildLegacyIdMap(catalog.skills);
    const ids = normalizeSkillIds([...attachedIds, ...injectedIds], legacyMap);
    const byId = new Map(catalog.skills.map((entry) => [entry.skillId, entry]));
    return ids.map((id) => byId.get(id)).filter((entry): entry is SkillEntry => Boolean(entry));
  }, [attachedIds, catalog.skills, injectedIds]);
}

function useFlash() {
  const [flash, setFlash] = useState<string | null>(null);
  const show = useCallback((message: string) => {
    setFlash(message);
    setTimeout(() => setFlash(null), 1800);
  }, []);
  return { flash, show };
}

interface RatingRowProps {
  enabled: boolean;
  onGood: () => void;
  onNeedsWork: () => void;
}

function RatingRow({ enabled, onGood, onNeedsWork }: RatingRowProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.rateRow}>
      <Pressable
        style={enabled ? styles.reject : [styles.reject, styles.disabled]}
        onPress={enabled ? onNeedsWork : undefined}
        testID="skill-train-needs-work"
      >
        <ThemedThumbsDown size={14} uniProps={mutedColor} />
        <Text style={styles.rejectText}>{t("skillsHub.train.needsWork")}</Text>
      </Pressable>
      <Pressable
        style={enabled ? styles.approve : [styles.approve, styles.disabled]}
        onPress={enabled ? onGood : undefined}
        testID="skill-train-good"
      >
        <ThemedThumbsUp size={14} uniProps={accentFgColor} />
        <Text style={styles.approveText}>{t("skillsHub.train.good")}</Text>
      </Pressable>
    </View>
  );
}

interface ProposalBoxProps {
  lesson: string;
  onApprove: () => void;
  onSkip: () => void;
}

function ProposalBox({ lesson, onApprove, onSkip }: ProposalBoxProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.proposalBox} testID="skill-train-proposal">
      <View style={styles.proposalHead}>
        <ThemedLightbulb size={13} uniProps={accentColor} />
        <Text style={styles.proposalTitle}>{t("skillsHub.train.proposalTitle")}</Text>
      </View>
      <Text style={styles.proposalText}>{lesson}</Text>
      <View style={styles.rateRow}>
        <Pressable style={styles.reject} onPress={onSkip} testID="skill-train-skip">
          <ThemedX size={13} uniProps={mutedColor} />
          <Text style={styles.rejectText}>{t("skillsHub.train.skip")}</Text>
        </Pressable>
        <Pressable style={styles.approve} onPress={onApprove} testID="skill-train-approve">
          <ThemedCheck size={13} uniProps={accentFgColor} />
          <Text style={styles.approveText}>{t("skillsHub.train.approve")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ForkPrompt({ skill, onFork }: { skill: SkillEntry; onFork: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.proposalBox} testID="skill-train-fork-prompt">
      <Text style={styles.proposalTitle}>{t("skillsHub.train.forkPrompt")}</Text>
      <Text style={styles.proposalText}>{t("skillsHub.train.forkHint", { name: skill.name })}</Text>
      <Pressable style={styles.approve} onPress={onFork} testID="skill-train-fork">
        <ThemedCopy size={13} uniProps={accentFgColor} />
        <Text style={styles.approveText}>{t("skillsHub.train.fork")}</Text>
      </Pressable>
    </View>
  );
}

interface TrainingInput {
  serverId: string;
  agentId: string;
  skill: SkillEntry | undefined;
  latest: LatestReply | undefined;
  showFlash: (message: string) => void;
}

/** 👍 → proposed lesson → approve → `skills.learn` (spec 22.9); 👎 records a negative run. */
function useTraining({ serverId, agentId, skill, latest, showFlash }: TrainingInput) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const actions = useSkillActions(client);
  const replaceAttached = useAgentSkillsStore((state) => state.replaceAttached);
  const [proposalFor, setProposalFor] = useState<string | null>(null);
  const [doneFor, setDoneFor] = useState<string | null>(null);

  const learn = useCallback(
    async (lesson: string, approved: boolean, flashKey: string) => {
      if (!client || !skill || !latest) return;
      setDoneFor(latest.messageId);
      setProposalFor(null);
      try {
        await client.learnSkill({
          skillId: skill.skillId,
          lesson,
          approved,
          agentId,
          ...(skill.projectRoot ? { cwd: skill.projectRoot } : {}),
        });
        showFlash(t(flashKey));
      } catch (error) {
        setDoneFor(null);
        showFlash(skillErrorMessage(error));
      }
    },
    [agentId, client, latest, showFlash, skill, t],
  );
  const lesson = latest ? conciseLessonFrom(latest.text) : "";
  const onGood = useCallback(() => {
    if (latest) setProposalFor(latest.messageId);
  }, [latest]);
  const onNeedsWork = useCallback(
    () => void learn(lesson, false, "skillsHub.train.noted"),
    [learn, lesson],
  );
  const onApprove = useCallback(
    () => void learn(lesson, true, "skillsHub.train.lessonSaved"),
    [learn, lesson],
  );
  const onSkip = useCallback(() => void learn("", true, "skillsHub.train.recorded"), [learn]);
  const onFork = useCallback(() => {
    if (!skill) return;
    void actions.fork(skill).then((forked) => {
      if (forked) {
        replaceAttached(agentId, skill.skillId, forked.skillId);
        showFlash(t("skillsHub.train.forked", { name: forked.name }));
      }
      return undefined;
    });
  }, [actions, agentId, replaceAttached, showFlash, skill, t]);

  const handled = Boolean(latest && latest.messageId === doneFor);
  const showProposal = Boolean(latest && latest.messageId === proposalFor && !handled);
  return { lesson, handled, showProposal, onGood, onNeedsWork, onApprove, onSkip, onFork };
}

/**
 * A floating bar inside an agent conversation when that agent uses skills
 * (attached in the composer or auto-loaded). Training happens from the real
 * conversation — no hand-typed instructions (spec 22.9):
 *  - 👍 on the agent's latest reply proposes a one-line lesson (text heuristic,
 *    no model call); Save lesson writes it into SKILL.md's lessons section and
 *    awards XP, Skip lesson only records the approval.
 *  - 👎 records a negative run.
 *  - A skill JAgentDesk does not own is never edited: the bar offers to create
 *    an owned copy first and switches the agent to it.
 */
export function AgentSkillTrainBar({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const streamItems = useSessionStore((state) =>
    state.sessions[serverId]?.agentStreamTail?.get(agentId),
  );
  const activeSkills = useActiveSkills(serverId, agentId);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { flash, show: showFlash } = useFlash();

  const skill = useMemo<SkillEntry | undefined>(
    () => activeSkills.find((entry) => entry.skillId === selectedId) ?? activeSkills[0],
    [activeSkills, selectedId],
  );
  const latest = useMemo(() => latestReplyOf(streamItems), [streamItems]);
  const training = useTraining({ serverId, agentId, skill, latest, showFlash });
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);

  if (!skill) return null;
  const level = levelProgress(skill.training?.xp ?? 0).level;

  return (
    <View style={styles.wrap} pointerEvents="box-none" testID="agent-skill-train-bar">
      <View style={styles.bar}>
        <Pressable style={styles.head} onPress={toggleExpanded}>
          <ThemedGraduationCap size={14} uniProps={accentColor} />
          <Text style={styles.title} numberOfLines={1}>
            {t("skillsHub.train.title", { name: skill.name })}
          </Text>
          {training.showProposal && !expanded ? <View style={styles.dot} /> : null}
          {skill.training ? (
            <Text style={styles.level}>{t("skillsHub.train.level", { level })}</Text>
          ) : null}
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedColor} />
          ) : (
            <ThemedChevronUp size={14} uniProps={mutedColor} />
          )}
        </Pressable>
        {flash ? <Text style={styles.flash}>{flash}</Text> : null}
        {expanded ? (
          <TrainBody
            activeSkills={activeSkills}
            skill={skill}
            latest={latest}
            training={training}
            onSelectSkill={setSelectedId}
          />
        ) : null}
      </View>
    </View>
  );
}

function TrainBody({
  activeSkills,
  skill,
  latest,
  training,
  onSelectSkill,
}: {
  activeSkills: SkillEntry[];
  skill: SkillEntry;
  latest: LatestReply | undefined;
  training: ReturnType<typeof useTraining>;
  onSelectSkill: (skillId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.body}>
      {activeSkills.length > 1 ? (
        <View style={styles.skillPicker}>
          {activeSkills.map((entry) => (
            <SkillChip
              key={entry.skillId}
              skill={entry}
              active={entry.skillId === skill.skillId}
              onSelect={onSelectSkill}
            />
          ))}
        </View>
      ) : null}
      {skill.owned ? (
        <>
          <Text style={styles.caption}>{t("skillsHub.train.latestReply")}</Text>
          {latest ? (
            <Text style={styles.replyPreview} numberOfLines={3}>
              {latest.text}
            </Text>
          ) : (
            <Text style={styles.waiting}>{t("skillsHub.train.waiting")}</Text>
          )}
          <RatingRow
            enabled={Boolean(latest) && !training.handled}
            onGood={training.onGood}
            onNeedsWork={training.onNeedsWork}
          />
          {training.showProposal ? (
            <ProposalBox
              lesson={training.lesson}
              onApprove={training.onApprove}
              onSkip={training.onSkip}
            />
          ) : null}
        </>
      ) : (
        <ForkPrompt skill={skill} onFork={training.onFork} />
      )}
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
