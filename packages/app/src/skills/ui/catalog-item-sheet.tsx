import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  SkillCatalogItem,
  SkillEntry,
  SkillPluginInstallResult,
} from "@jagentdesk/protocol/native-skills";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { refreshSkillCatalogs } from "@/stores/skills-store";
import {
  isScriptPath,
  shortRevision,
  skillErrorCode,
  skillErrorMessage,
  type SkillProjectOption,
} from "@/skills/native-skill-logic";
import { skillsBrowseQueryKey } from "@/skills/ui/browse-tab";
import {
  ScopePicker,
  scopeIsComplete,
  scopeRequest,
  type ScopeValue,
} from "@/skills/ui/scope-picker";
import { MetaRow, SectionTitle, SkillBadge } from "@/skills/ui/skill-chrome";
import { SkillFileList, SkillTrustWarning } from "@/skills/ui/skill-files";
import type { Theme } from "@/styles/theme";

interface ConflictState {
  message: string;
  rename: string;
}

function ItemMeta({ item }: { item: SkillCatalogItem }) {
  const { t } = useTranslation();
  const revision = shortRevision(item.revision);
  return (
    <View style={styles.metaCard}>
      <MetaRow label={t("skillsHub.item.source")} value={item.origin} />
      {revision ? <MetaRow label={t("skillsHub.item.revision")} value={revision} /> : null}
      <MetaRow
        label={t("skillsHub.item.kind")}
        value={t(item.kind === "plugin" ? "skillsHub.badges.plugin" : "skillsHub.badges.skill")}
      />
      {item.provider ? (
        <MetaRow label={t("skillsHub.item.provider")} value={item.provider} />
      ) : null}
      {item.category ? (
        <MetaRow label={t("skillsHub.item.category")} value={item.category} />
      ) : null}
    </View>
  );
}

function PluginCommand({ command }: { command: string[] }) {
  const { t } = useTranslation();
  return (
    <View style={styles.block}>
      <Text style={styles.label}>{t("skillsHub.item.command")}</Text>
      <Text style={styles.code} selectable>
        {command.join(" ")}
      </Text>
      <Text style={styles.hint}>{t("skillsHub.item.commandHint")}</Text>
    </View>
  );
}

/** The provider CLI result of a plugin install (ADR-0022 decision 5: shown to the user). */
function PluginOutput({ result }: { result: SkillPluginInstallResult }) {
  const { t } = useTranslation();
  const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
  return (
    <View style={styles.block} testID="skills-plugin-output">
      <Alert
        variant={result.ok ? "success" : "error"}
        title={
          result.ok
            ? t("skillsHub.item.pluginOk")
            : t("skillsHub.item.pluginFailed", { code: String(result.exitCode ?? "–") })
        }
        description={result.command.join(" ")}
      />
      <Text style={styles.label}>{t("skillsHub.item.output")}</Text>
      <ScrollView style={styles.outputScroll} nestedScrollEnabled>
        <Text style={styles.code} selectable>
          {output || "—"}
        </Text>
      </ScrollView>
    </View>
  );
}

interface ConflictPanelProps {
  conflict: ConflictState;
  installing: boolean;
  onRenameChange: (value: string) => void;
  onInstallAs: () => void;
  onCancel: () => void;
}

/** Spec 22.11 #4: nothing is written on a name clash; offer rename or cancel. */
function ConflictPanel({
  conflict,
  installing,
  onRenameChange,
  onInstallAs,
  onCancel,
}: ConflictPanelProps) {
  const { t } = useTranslation();
  const name = conflict.rename.trim();
  return (
    <View style={styles.block} testID="skills-install-conflict">
      <Alert
        variant="warning"
        title={t("skillsHub.item.conflictTitle")}
        description={`${conflict.message}\n${t("skillsHub.item.conflictHint")}`}
      />
      <Text style={styles.label}>{t("skillsHub.item.renameLabel")}</Text>
      <AdaptiveTextInput
        style={styles.input}
        initialValue={conflict.rename}
        onChangeText={onRenameChange}
        autoCapitalize="none"
        autoCorrect={false}
        testID="skills-install-rename"
      />
      <View style={styles.row}>
        <Button variant="outline" size="sm" onPress={onCancel}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={onInstallAs}
          loading={installing}
          disabled={!name}
          testID="skills-install-as"
        >
          {t("skillsHub.item.installAs", { name: name || "…" })}
        </Button>
      </View>
    </View>
  );
}

interface InstallSectionProps {
  item: SkillCatalogItem;
  scope: ScopeValue;
  onScopeChange: (value: ScopeValue) => void;
  projects: SkillProjectOption[];
  installing: boolean;
  error: string | null;
  onInstall: () => void;
}

function InstallSection(props: InstallSectionProps) {
  const { t } = useTranslation();
  const { item } = props;
  if (item.installed) {
    return <Alert variant="success" title={t("skillsHub.item.alreadyInstalled")} />;
  }
  if (item.invalidReason) {
    return (
      <Alert variant="error" title={t("skillsHub.item.invalid", { reason: item.invalidReason })} />
    );
  }
  const complete = scopeIsComplete(props.scope);
  return (
    <View style={styles.block}>
      <ScopePicker
        label={t("skillsHub.item.scope")}
        value={props.scope}
        onChange={props.onScopeChange}
        projects={props.projects}
      />
      {item.installCommand ? <PluginCommand command={item.installCommand} /> : null}
      {complete ? null : <Text style={styles.error}>{t("skillsHub.item.projectRequired")}</Text>}
      {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
      <View style={styles.row}>
        <Button
          variant="default"
          onPress={props.onInstall}
          loading={props.installing}
          disabled={!complete}
          testID="skills-install-submit"
        >
          {t(item.kind === "plugin" ? "skillsHub.item.installPlugin" : "skillsHub.item.install")}
        </Button>
      </View>
    </View>
  );
}

export interface CatalogItemSheetProps {
  serverId: string;
  client: DaemonClient | null;
  item: SkillCatalogItem;
  projects: SkillProjectOption[];
  /** Pre-selected project for "This project" (the screen's project filter). */
  defaultProjectPath: string | null;
  onClose: () => void;
  onInstalled?: (skill: SkillEntry) => void;
}

function useInstallFlow(props: CatalogItemSheetProps, scope: ScopeValue) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { client, item, serverId, onClose, onInstalled } = props;
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [pluginResult, setPluginResult] = useState<SkillPluginInstallResult | null>(null);

  const run = useCallback(
    async (rename?: string) => {
      if (!client) return;
      setInstalling(true);
      setError(null);
      try {
        const result = await client.installSkill({
          item: { source: item.source, itemId: item.itemId },
          ...scopeRequest(scope),
          ...(rename ? { rename } : {}),
        });
        setConflict(null);
        void queryClient.invalidateQueries({ queryKey: skillsBrowseQueryKey(serverId) });
        refreshSkillCatalogs();
        if (result.plugin) {
          setPluginResult(result.plugin);
          return;
        }
        toast.show(t("skillsHub.item.installed", { name: result.skill?.name ?? item.name }), {
          variant: "success",
        });
        if (result.skill) onInstalled?.(result.skill);
        onClose();
      } catch (installError) {
        const message = skillErrorMessage(installError);
        if (skillErrorCode(installError) === "skill_name_conflict") {
          setConflict((prev) => ({ message, rename: prev?.rename ?? `${item.name}-jagentdesk` }));
        } else {
          setError(message);
        }
      } finally {
        setInstalling(false);
      }
    },
    [client, item, onClose, onInstalled, queryClient, scope, serverId, t, toast],
  );
  return { installing, error, conflict, setConflict, pluginResult, run };
}

/** Browse detail + install flow (spec 22.6 detail, 22.8 trust, 22.11 #4 conflict). */
export function CatalogItemSheet(props: CatalogItemSheetProps) {
  const { t } = useTranslation();
  const { item, onClose, projects, defaultProjectPath } = props;
  const [scope, setScope] = useState<ScopeValue>({
    scope: "global",
    projectPath: defaultProjectPath,
  });
  const flow = useInstallFlow(props, scope);
  const { setConflict, run } = flow;
  const header = useMemo<SheetHeader>(
    () => ({ title: item.name, subtitle: item.origin, back: { onPress: onClose } }),
    [item.name, item.origin, onClose],
  );
  const files = useMemo(
    () => item.files.map((path) => ({ path, isScript: isScriptPath(path) })),
    [item.files],
  );
  const handleInstall = useCallback(() => void run(), [run]);
  const handleRename = useCallback(
    (rename: string) => setConflict((prev) => (prev ? { ...prev, rename } : prev)),
    [setConflict],
  );
  const handleInstallAs = useCallback(
    () => void run(flow.conflict?.rename.trim()),
    [flow.conflict?.rename, run],
  );
  const handleCancelConflict = useCallback(() => setConflict(null), [setConflict]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      testID="skills-catalog-item-sheet"
      contentStyle={styles.body}
      desktopMaxWidth={640}
    >
      <View style={styles.badges}>
        <SkillBadge
          label={t(item.kind === "plugin" ? "skillsHub.badges.plugin" : "skillsHub.badges.skill")}
        />
        {item.hasScripts ? (
          <SkillBadge label={t("skillsHub.badges.scripts")} tone="warning" />
        ) : null}
        {item.installed ? (
          <SkillBadge label={t("skillsHub.badges.installed")} tone="success" />
        ) : null}
      </View>
      {item.description ? <Text style={styles.description}>{item.description}</Text> : null}
      <SkillTrustWarning />
      <SkillFileList files={files} />
      {flow.conflict ? (
        <ConflictPanel
          conflict={flow.conflict}
          installing={flow.installing}
          onRenameChange={handleRename}
          onInstallAs={handleInstallAs}
          onCancel={handleCancelConflict}
        />
      ) : (
        <InstallSection
          item={item}
          scope={scope}
          onScopeChange={setScope}
          projects={projects}
          installing={flow.installing}
          error={flow.error}
          onInstall={handleInstall}
        />
      )}
      {flow.pluginResult ? <PluginOutput result={flow.pluginResult} /> : null}
      <ItemMeta item={item} />
      {item.body ? (
        <View style={styles.block}>
          <SectionTitle title={t("skillsHub.item.instructions")} />
          <MarkdownRenderer text={item.body} />
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[4], paddingBottom: theme.spacing[6] },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  description: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, lineHeight: 20 },
  block: { gap: theme.spacing[2] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  error: { fontSize: theme.fontSize.xs, color: theme.colors.statusDanger },
  code: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
  },
  outputScroll: { maxHeight: 240 },
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
  metaCard: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
}));
