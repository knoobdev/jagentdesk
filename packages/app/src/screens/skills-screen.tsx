import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Sparkles, Plus, Play, Pencil, Trash2, X, Dumbbell, GraduationCap } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { uniqueTitle } from "@/utils/unique-title";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { SkillTrainingView } from "@/components/skill-training-view";
import { useSkillsStore, levelProgress, approvalRate, type Skill } from "@/stores/skills-store";
import type { Theme } from "@/styles/theme";

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedPlus = withUnistyles(Plus);
const ThemedPlay = withUnistyles(Play);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const ThemedX = withUnistyles(X);
const ThemedDumbbell = withUnistyles(Dumbbell);
const ThemedGraduationCap = withUnistyles(GraduationCap);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const accentFgColor = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type SkillFilter = "all" | "training" | "graduated";

interface EditState {
  id: string | null;
  name: string;
  icon: string;
  description: string;
  instructions: string;
  tags: string;
}

const EMPTY_EDIT: EditState = {
  id: null,
  name: "",
  icon: "✦",
  description: "",
  instructions: "",
  tags: "",
};

function SkillCard({
  skill,
  onUse,
  onTrain,
  onEdit,
  onDelete,
}: {
  skill: Skill;
  onUse: (s: Skill) => void;
  onTrain: (s: Skill) => void;
  onEdit: (s: Skill) => void;
  onDelete: (s: Skill) => void;
}) {
  const handleUse = useCallback(() => onUse(skill), [onUse, skill]);
  const handleTrain = useCallback(() => onTrain(skill), [onTrain, skill]);
  const handleEdit = useCallback(() => onEdit(skill), [onEdit, skill]);
  const handleDelete = useCallback(() => onDelete(skill), [onDelete, skill]);
  const prog = levelProgress(skill.xp);
  const graduated = skill.status === "graduated";
  const pct = Math.round(approvalRate(skill) * 100);
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardIcon}>
          <Text style={styles.cardIconText}>{skill.icon}</Text>
        </View>
        <Text style={styles.cardName} numberOfLines={1}>
          {skill.name}
        </Text>
        <View style={graduated ? styles.badgeGrad : styles.badgeTrain}>
          <Text style={graduated ? styles.badgeGradText : styles.badgeTrainText}>
            {graduated ? "GRADUATED" : "TRAINING"}
          </Text>
        </View>
      </View>
      <Text style={styles.cardDesc} numberOfLines={2}>
        {skill.description || "No description"}
      </Text>

      <View style={styles.levelRow}>
        <Text style={styles.levelLabel}>
          Lv {prog.level} · {prog.tier}
        </Text>
        <Text style={styles.xpText}>
          {prog.atMax ? "MAX" : `${prog.inLevel}/${prog.forLevel} XP`}
        </Text>
      </View>
      <View style={styles.xpTrack}>
        <View style={[styles.xpFill, { width: `${(prog.inLevel / prog.forLevel) * 100}%` }]} />
      </View>
      <Text style={styles.statsLine}>
        {skill.runs} runs · {pct}% approved · {skill.examples.length} examples
      </Text>

      {skill.tags.length > 0 ? (
        <View style={styles.tags}>
          {skill.tags.slice(0, 4).map((tag) => (
            <Text key={tag} style={styles.tag}>
              {tag}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.cardFoot}>
        <Pressable style={styles.usebtn} onPress={handleUse}>
          <ThemedPlay size={14} uniProps={accentFgColor} />
          <Text style={styles.usebtnText}>Use</Text>
        </Pressable>
        <Pressable style={styles.trainBtn} onPress={handleTrain}>
          <ThemedDumbbell size={14} uniProps={accentColor} />
          <Text style={styles.trainBtnText}>Train</Text>
        </Pressable>
        <Pressable style={styles.iconBtn} onPress={handleEdit} accessibilityLabel="Edit skill">
          <ThemedPencil size={15} uniProps={mutedColor} />
        </Pressable>
        <Pressable style={styles.iconBtn} onPress={handleDelete} accessibilityLabel="Delete skill">
          <ThemedTrash size={15} uniProps={mutedColor} />
        </Pressable>
      </View>
    </View>
  );
}

export function SkillsScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  const skills = useSkillsStore((s) => s.skills);
  const addSkill = useSkillsStore((s) => s.addSkill);
  const updateSkill = useSkillsStore((s) => s.updateSkill);
  const removeSkill = useSkillsStore((s) => s.removeSkill);

  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const provider = providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const firstWorkspace = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces.values().next().value,
  );
  const cwd = firstWorkspace?.workspaceDirectory ?? null;
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);

  const [edit, setEdit] = useState<EditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [trainingId, setTrainingId] = useState<string | null>(null);
  const trainingSkill = useMemo(
    () => (trainingId ? (skills.find((s) => s.id === trainingId) ?? null) : null),
    [trainingId, skills],
  );
  const filteredSkills = useMemo(
    () => (filter === "all" ? skills : skills.filter((s) => s.status === filter)),
    [filter, skills],
  );
  const handleTrain = useCallback((skill: Skill) => setTrainingId(skill.id), []);

  const contentContainerStyle = useMemo(
    () => [styles.content, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const handleUse = useCallback(
    (skill: Skill) => {
      if (!client || !provider || !cwd) {
        setError("Connect a host and add a project to use a skill.");
        return;
      }
      setError(null);
      // Don't spawn duplicate "K8s Doctor" agents when a skill is used twice —
      // suffix a counter against the existing agent titles.
      const title = uniqueTitle(
        skill.name,
        agents ? Array.from(agents.values(), (a) => a.title) : [],
      );
      void client
        .createAgent({
          provider,
          cwd,
          systemPrompt: skill.instructions,
          title,
          labels: { "jagentdesk.skill.id": skill.id, "jagentdesk.skill.name": skill.name },
        })
        .then((agent) => {
          navigateToAgent({ serverId, agentId: agent.id });
          return undefined;
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to start skill"));
    },
    [client, provider, cwd, serverId, agents],
  );

  const handleNew = useCallback(() => setEdit({ ...EMPTY_EDIT }), []);
  const handleEdit = useCallback(
    (skill: Skill) =>
      setEdit({
        id: skill.id,
        name: skill.name,
        icon: skill.icon,
        description: skill.description,
        instructions: skill.instructions,
        tags: skill.tags.join(", "),
      }),
    [],
  );
  const handleDelete = useCallback((skill: Skill) => removeSkill(skill.id), [removeSkill]);
  const handleCancel = useCallback(() => setEdit(null), []);
  const handleSave = useCallback(() => {
    if (!edit || !edit.instructions.trim()) return;
    const draft = {
      name: edit.name,
      icon: edit.icon,
      description: edit.description,
      instructions: edit.instructions,
      tags: edit.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };
    if (edit.id) {
      updateSkill(edit.id, draft);
    } else {
      addSkill(draft);
    }
    setEdit(null);
  }, [edit, addSkill, updateSkill]);

  const setField = useCallback(
    (key: keyof EditState, value: string) =>
      setEdit((prev) => (prev ? { ...prev, [key]: value } : prev)),
    [],
  );
  const setIcon = useCallback((v: string) => setField("icon", v), [setField]);
  const setName = useCallback((v: string) => setField("name", v), [setField]);
  const setDescription = useCallback((v: string) => setField("description", v), [setField]);
  const setInstructions = useCallback((v: string) => setField("instructions", v), [setField]);
  const setTags = useCallback((v: string) => setField("tags", v), [setField]);

  return (
    <View style={styles.root}>
      <ScrollView style={styles.container} contentContainerStyle={contentContainerStyle}>
        <View style={styles.headerRow}>
          <ThemedSparkles size={20} uniProps={accentColor} />
          <Text style={styles.header}>Skills</Text>
          <Pressable style={styles.createBtn} onPress={handleNew}>
            <ThemedPlus size={15} uniProps={accentFgColor} />
            <Text style={styles.createBtnText}>Create skill</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Train your agents into reusable assistants. Teach a skill by example, watch it level up,
          then invoke it anytime — your personal expert on tap.
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.filterRow}>
          {(["all", "training", "graduated"] as const).map((f) => (
            <Pressable
              key={f}
              style={filter === f ? [styles.filterTab, styles.filterTabActive] : styles.filterTab}
              onPress={() => setFilter(f)}
            >
              <Text style={filter === f ? styles.filterTabTextActive : styles.filterTabText}>
                {f === "all" ? "All" : f === "training" ? "In training" : "Graduated"}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.grid}>
          {filteredSkills.map((skill) => (
            <View key={skill.id} style={isCompact ? styles.cellFull : styles.cellHalf}>
              <SkillCard
                skill={skill}
                onUse={handleUse}
                onTrain={handleTrain}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            </View>
          ))}
          {filteredSkills.length === 0 ? (
            <Text style={styles.empty}>
              {filter === "all"
                ? "No skills yet. Create your first assistant."
                : `No ${filter === "training" ? "in-training" : "graduated"} skills yet.`}
            </Text>
          ) : null}
        </View>
      </ScrollView>

      {trainingSkill ? (
        <SkillTrainingView
          skill={trainingSkill}
          onClose={() => setTrainingId(null)}
          onUse={handleUse}
        />
      ) : null}

      {edit ? (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{edit.id ? "Edit skill" : "New skill"}</Text>
              <Pressable style={styles.iconBtn} onPress={handleCancel} accessibilityLabel="Close">
                <ThemedX size={17} uniProps={mutedColor} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetBodyContent}>
              <View style={styles.fieldRow}>
                <View style={styles.iconField}>
                  <Text style={styles.label}>Icon</Text>
                  <AdaptiveTextInput
                    style={styles.iconInput}
                    initialValue={edit.icon}
                    onChangeText={setIcon}
                    resetKey={`icon-${edit.id ?? "new"}`}
                  />
                </View>
                <View style={styles.nameField}>
                  <Text style={styles.label}>Name</Text>
                  <AdaptiveTextInput
                    style={styles.input}
                    initialValue={edit.name}
                    onChangeText={setName}
                    placeholder="e.g. Release Captain"
                    resetKey={`name-${edit.id ?? "new"}`}
                  />
                </View>
              </View>
              <Text style={styles.label}>Description</Text>
              <AdaptiveTextInput
                style={styles.input}
                initialValue={edit.description}
                onChangeText={setDescription}
                placeholder="What this assistant does"
                resetKey={`desc-${edit.id ?? "new"}`}
              />
              <Text style={styles.label}>Instructions (the skill’s system prompt)</Text>
              <AdaptiveTextInput
                style={styles.textarea}
                initialValue={edit.instructions}
                onChangeText={setInstructions}
                placeholder="How the agent should behave when this skill is used…"
                multiline
                resetKey={`instr-${edit.id ?? "new"}`}
              />
              <Text style={styles.label}>Tags (comma-separated)</Text>
              <AdaptiveTextInput
                style={styles.input}
                initialValue={edit.tags}
                onChangeText={setTags}
                placeholder="release, git, ci"
                resetKey={`tags-${edit.id ?? "new"}`}
              />
            </ScrollView>
            <View style={styles.sheetFoot}>
              <Pressable style={styles.cancelBtn} onPress={handleCancel}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={
                  edit.instructions.trim() ? styles.saveBtn : [styles.saveBtn, styles.saveDisabled]
                }
                onPress={handleSave}
                disabled={!edit.instructions.trim()}
              >
                <Text style={styles.saveBtnText}>{edit.id ? "Save" : "Create skill"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1 },
  content: { padding: theme.spacing[4], paddingBottom: theme.spacing[8] },
  headerRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  header: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  createBtn: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  createBtnText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[2],
    lineHeight: 20,
  },
  error: {
    marginTop: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
  },
  cellFull: { width: "100%" },
  cellHalf: { width: "48.5%" },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[4],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  cardIconText: { fontSize: 20 },
  cardName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  cardDesc: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
    minHeight: 36,
  },
  badgeTrain: {
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    backgroundColor: theme.colors.surface2,
  },
  badgeTrainText: {
    fontSize: 9,
    fontWeight: theme.fontWeight.bold,
    letterSpacing: 0.5,
    color: theme.colors.foregroundMuted,
  },
  badgeGrad: {
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    backgroundColor: theme.colors.accent,
  },
  badgeGradText: {
    fontSize: 9,
    fontWeight: theme.fontWeight.bold,
    letterSpacing: 0.5,
    color: theme.colors.accentForeground,
  },
  levelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  levelLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  xpText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  xpTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  xpFill: { height: 6, borderRadius: 3, backgroundColor: theme.colors.accent },
  statsLine: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  trainBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  trainBtnText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accent,
  },
  filterRow: { flexDirection: "row", gap: theme.spacing[2] },
  filterTab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  filterTabActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  filterTabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  filterTabTextActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  tag: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  cardFoot: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  usebtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
  },
  usebtnText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  iconBtn: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  sheet: {
    width: "100%",
    maxWidth: 560,
    maxHeight: "88%",
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  sheetBody: { paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[3] },
  sheetBodyContent: { paddingBottom: theme.spacing[6] },
  fieldRow: { flexDirection: "row", gap: theme.spacing[3] },
  iconField: { width: 72 },
  nameField: { flex: 1 },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[1.5],
    marginTop: theme.spacing[3],
  },
  input: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  iconInput: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: 20,
    textAlign: "center",
    color: theme.colors.foreground,
  },
  textarea: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    minHeight: 120,
    textAlignVertical: "top",
  },
  sheetFoot: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  cancelBtn: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  cancelBtnText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  saveBtn: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  saveDisabled: { opacity: 0.5 },
  saveBtnText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
}));
