import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { Plus, Sparkles } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SkillCatalogItem, SkillEntry } from "@jagentdesk/protocol/native-skills";
import { PageHeader } from "@/components/headers/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useSkillCatalog } from "@/stores/skills-store";
import { projectOptionsFromWorkspaces } from "@/skills/native-skill-logic";
import { groupSkillFamilies } from "@/skills/skill-families";
import { BrowseTab } from "@/skills/ui/browse-tab";
import { CatalogItemSheet } from "@/skills/ui/catalog-item-sheet";
import { InstalledTab } from "@/skills/ui/installed-tab";
import { ProjectSelect } from "@/skills/ui/scope-picker";
import { SkillsTabButton, SkillsTabRow } from "@/skills/ui/skill-chrome";
import { SkillDetailSheet } from "@/skills/ui/skill-detail-sheet";
import { SkillEditorSheet } from "@/skills/ui/skill-editor-sheet";
import { SourcesSheet } from "@/skills/ui/sources-sheet";
import type { SkillRowHandlers } from "@/skills/ui/skill-row";
import { useSkillActions } from "@/skills/ui/use-skill-actions";
import type { Theme } from "@/styles/theme";

type SkillsTab = "installed" | "browse";

/** Which sheet is open on top of the list. */
type SkillsSheet =
  | { kind: "detail"; skillId: string; cwd: string | null }
  | { kind: "item"; item: SkillCatalogItem }
  | { kind: "editor"; entry: SkillEntry | null }
  | { kind: "sources" }
  | null;

const EMPTY_WORKSPACES = new Map<string, WorkspaceDescriptor>();

function useBusyIds() {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const track = useCallback(async <T,>(skillId: string, work: () => Promise<T>): Promise<T> => {
    setBusyIds((prev) => new Set(prev).add(skillId));
    try {
      return await work();
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(skillId);
        return next;
      });
    }
  }, []);
  return { busyIds, track };
}

/**
 * Skills (rail "Skills", spec 22.6): one list for every provider. Installed
 * lists the daemon catalog grouped into families (22.6.1) with filters; Browse is
 * the merged marketplace of the user's sources (22.5) plus provider plugin
 * marketplaces. Everything goes through the
 * daemon RPCs, so desktop and mobile behave the same (spec 22.11 #8).
 */
export function SkillsScreen() {
  const { t } = useTranslation();
  const serverId = useHostRouteServerId() ?? "";
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const actions = useSkillActions(client);
  const { busyIds, track } = useBusyIds();

  const workspaces = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces ?? EMPTY_WORKSPACES,
  );
  const projects = useMemo(() => projectOptionsFromWorkspaces(workspaces.values()), [workspaces]);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [tab, setTab] = useState<SkillsTab>("installed");
  const [sheet, setSheet] = useState<SkillsSheet>(null);
  const installedSkills = useSkillCatalog(projectPath).skills;
  const installedCount = useMemo(
    () => groupSkillFamilies(installedSkills).length,
    [installedSkills],
  );

  const openSkill = useCallback(
    (entry: SkillEntry) =>
      setSheet({ kind: "detail", skillId: entry.skillId, cwd: entry.projectRoot ?? projectPath }),
    [projectPath],
  );
  const closeSheet = useCallback(() => setSheet(null), []);
  const openEditor = useCallback(
    (entry: SkillEntry | null) => setSheet({ kind: "editor", entry }),
    [],
  );
  const handleCreate = useCallback(() => openEditor(null), [openEditor]);
  const handleOpenItem = useCallback(
    (item: SkillCatalogItem) => setSheet({ kind: "item", item }),
    [],
  );
  const handleManageSources = useCallback(() => setSheet({ kind: "sources" }), []);

  const handlers = useMemo<SkillRowHandlers>(
    () => ({
      onOpen: openSkill,
      onToggleEnabled: (entry, enabled) => {
        void track(entry.skillId, () => actions.setEnabled(entry, enabled));
      },
      onCopyPath: (entry) => actions.copyPath(entry.realPath),
      onTrain: (entry) => {
        if (entry.owned) {
          openSkill(entry);
          return;
        }
        void actions.forkToTrain(entry).then((forked) => {
          if (forked) openSkill(forked);
          return undefined;
        });
      },
      onFork: (entry) => {
        void actions.fork(entry).then((forked) => {
          if (forked) openSkill(forked);
          return undefined;
        });
      },
      onUninstall: (entry) => {
        void track(entry.skillId, () => actions.uninstall(entry));
      },
    }),
    [actions, openSkill, track],
  );

  const headerActions = useMemo(
    () => (
      <Button
        size="sm"
        variant="default"
        leftIcon={Plus}
        onPress={handleCreate}
        disabled={!client}
        testID="skills-create"
      >
        {t("skillsHub.createSkill")}
      </Button>
    ),
    [client, handleCreate, t],
  );
  const selectInstalled = useCallback(() => setTab("installed"), []);
  const selectBrowse = useCallback(() => setTab("browse"), []);
  const installedLabel =
    installedCount > 0
      ? t("skillsHub.tabs.installedCount", { count: installedCount })
      : t("skillsHub.tabs.installed");

  return (
    <View style={styles.root} testID="skills-screen">
      <PageHeader
        icon={Sparkles}
        title={t("skillsHub.title")}
        description={t("skillsHub.subtitle")}
        actions={headerActions}
      />
      <View style={styles.bar}>
        <SkillsTabRow>
          <SkillsTabButton
            label={installedLabel}
            active={tab === "installed"}
            onPress={selectInstalled}
            testID="skills-tab-installed"
          />
          <SkillsTabButton
            label={t("skillsHub.tabs.browse")}
            active={tab === "browse"}
            onPress={selectBrowse}
            testID="skills-tab-browse"
          />
        </SkillsTabRow>
        <View style={styles.projectSelect}>
          <ProjectSelect
            label={t("skillsHub.project.label")}
            value={projectPath}
            projects={projects}
            onChange={setProjectPath}
            allowNone
            testID="skills-project-select"
          />
        </View>
      </View>
      {connected ? null : (
        <View style={styles.alert}>
          <Alert variant="warning" title={t("skillsHub.offline")} />
        </View>
      )}
      {tab === "installed" ? (
        <InstalledTab
          cwd={projectPath}
          busyIds={busyIds}
          handlers={handlers}
          onCopyWrittenPath={actions.copyPath}
        />
      ) : (
        <BrowseTab
          serverId={serverId}
          client={client}
          connected={connected}
          onOpenItem={handleOpenItem}
          onManageSources={handleManageSources}
        />
      )}
      <SkillsSheets
        sheet={sheet}
        serverId={serverId}
        client={client}
        actions={actions}
        projects={projects}
        projectPath={projectPath}
        onClose={closeSheet}
        onOpenSkill={openSkill}
        onEdit={openEditor}
      />
    </View>
  );
}

interface SkillsSheetsProps {
  sheet: SkillsSheet;
  serverId: string;
  client: ReturnType<typeof useHostRuntimeClient>;
  actions: ReturnType<typeof useSkillActions>;
  projects: ReturnType<typeof projectOptionsFromWorkspaces>;
  projectPath: string | null;
  onClose: () => void;
  onOpenSkill: (entry: SkillEntry) => void;
  onEdit: (entry: SkillEntry | null) => void;
}

function SkillsSheets({ sheet, ...props }: SkillsSheetsProps) {
  if (!sheet) return null;
  if (sheet.kind === "detail") {
    return (
      <SkillDetailSheet
        key={sheet.skillId}
        serverId={props.serverId}
        client={props.client}
        skillId={sheet.skillId}
        cwd={sheet.cwd}
        actions={props.actions}
        onClose={props.onClose}
        onEdit={props.onEdit}
        onOpenSkill={props.onOpenSkill}
      />
    );
  }
  if (sheet.kind === "sources") {
    return <SourcesSheet serverId={props.serverId} client={props.client} onClose={props.onClose} />;
  }
  if (sheet.kind === "item") {
    return (
      <CatalogItemSheet
        serverId={props.serverId}
        client={props.client}
        item={sheet.item}
        projects={props.projects}
        defaultProjectPath={props.projectPath}
        onClose={props.onClose}
      />
    );
  }
  return (
    <SkillEditorSheet
      serverId={props.serverId}
      client={props.client}
      entry={sheet.entry}
      projects={props.projects}
      defaultProjectPath={props.projectPath}
      onClose={props.onClose}
      onSaved={props.onOpenSkill}
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  projectSelect: { minWidth: 220, flexGrow: 1, maxWidth: 360 },
  alert: { paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[2] },
}));
