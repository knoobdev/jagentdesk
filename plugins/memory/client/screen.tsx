import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Brain, Plus, Search } from "lucide-react-native";
import type { MemoryProject, MemoryRecordWire } from "@jagentdesk/protocol/memory";
import type { MemoryScope } from "../shared/types";
import {
  Alert,
  Button,
  PageHeader,
  SegmentedControl,
  SelectField,
  type SegmentedControlOption,
  useGumloopPageGutterStyle,
  useHostRuntimeIsConnected,
  useIsCompactFormFactor,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { MemoryEditorSheet, type MemoryEditorTarget } from "./memory-editor-sheet";
import { MEMORY_COLUMN_WIDTHS, MemoryRow } from "./memory-row";
import { useMemoryList } from "./use-memory";

/**
 * Memory (spec 41 §5): what agents remember, per project and global. Desktop and phone share the
 * screen; phones get two-line rows.
 */
export function MemoryScreen({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const compact = useIsCompactFormFactor();
  const gutter = useGumloopPageGutterStyle();
  const [scope, setScope] = useState<MemoryScope>("project");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<MemoryEditorTarget | null>(null);
  const list = useMemoryList(serverId, { scope, projectId, query });
  const data = list.status === "ready" ? list.data : null;
  const projects = data?.projects ?? EMPTY_PROJECTS;

  // Default to the first project once the host lists them.
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.projectId);
  }, [projectId, projects]);

  const openCreate = useCallback(
    () => setEditor({ kind: "create", scope, projectId: scope === "project" ? projectId : null }),
    [projectId, scope],
  );
  const openEdit = useCallback(
    (memory: MemoryRecordWire) => setEditor({ kind: "edit", memory }),
    [],
  );
  const closeEditor = useCallback(() => setEditor(null), []);

  const headerActions = useMemo(
    () => (
      <Button
        size="sm"
        variant="default"
        leftIcon={Plus}
        onPress={openCreate}
        disabled={!connected || (scope === "project" && !projectId)}
        testID="memory-add"
      >
        {t("memory.add")}
      </Button>
    ),
    [connected, openCreate, projectId, scope, t],
  );

  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        id: project.projectId,
        value: project.projectId,
        label: project.name,
        description: project.rootPath,
      })),
    [projects],
  );
  const selectedProject = projects.find((project) => project.projectId === projectId) ?? null;
  const selectedDisplay = useMemo(
    () => (selectedProject ? { label: selectedProject.name } : null),
    [selectedProject],
  );
  const scopeOptions = useMemo<SegmentedControlOption<MemoryScope>[]>(
    () => [
      { value: "project", label: t("memory.tabs.project"), testID: "memory-tab-project" },
      { value: "global", label: t("memory.tabs.global"), testID: "memory-tab-global" },
    ],
    [t],
  );

  const tabs = useMemo(
    () => (
      <View style={styles.bar}>
        <SegmentedControl
          options={scopeOptions}
          value={scope}
          onValueChange={setScope}
          testID="memory-tabs"
        />
        {scope === "project" ? (
          <View style={styles.projectSelect}>
            <SelectField
              label={t("memory.project.label")}
              value={projectId}
              selectedDisplay={selectedDisplay}
              options={projectOptions}
              onChange={setProjectId}
              placeholder={t("memory.project.label")}
              emptyText={t("memory.project.none")}
              field={false}
              size="sm"
              testID="memory-project-select"
            />
          </View>
        ) : null}
      </View>
    ),
    [projectId, projectOptions, scope, scopeOptions, selectedDisplay, t],
  );

  const memories = data?.memories ?? EMPTY_MEMORIES;
  return (
    <View style={styles.root} testID="memory-screen">
      <PageHeader
        icon={Brain}
        title={t("memory.title")}
        description={t("memory.description")}
        actions={headerActions}
        tabs={tabs}
      />
      <ScrollView contentContainerStyle={[styles.content, gutter]}>
        {connected ? null : <Alert variant="warning" title={t("memory.offline")} />}
        <View style={styles.searchBox}>
          <ThemedSearch size={18} uniProps={mutedColor} />
          <ThemedTextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t("memory.search")}
            uniProps={placeholderColor}
            style={styles.searchInput}
            testID="memory-search"
          />
        </View>
        {list.status === "error" ? <Alert variant="error" title={list.error} /> : null}
        {compact || memories.length === 0 ? null : (
          <View style={styles.headerRow}>
            <Text style={[styles.columnHeader, styles.flexColumn]}>
              {t("memory.columns.memory")}
            </Text>
            <Text style={[styles.columnHeader, styles.sourceColumn]}>
              {t("memory.columns.source")}
            </Text>
            <Text style={[styles.columnHeader, styles.usedColumn]}>{t("memory.columns.used")}</Text>
            <Text style={[styles.columnHeader, styles.lastUsedColumn]}>
              {t("memory.columns.lastUsed")}
            </Text>
            <View style={styles.actionsColumn} />
          </View>
        )}
        {memories.map((memory) => (
          <MemoryRow key={memory.id} serverId={serverId} memory={memory} onEdit={openEdit} />
        ))}
        {list.status === "ready" && memories.length === 0 ? (
          <Text style={styles.empty} testID="memory-empty">
            {query.trim() ? t("memory.noMatch") : t("memory.empty")}
          </Text>
        ) : null}
      </ScrollView>
      {editor ? (
        <MemoryEditorSheet serverId={serverId} target={editor} onClose={closeEditor} />
      ) : null}
    </View>
  );
}

const EMPTY_PROJECTS: MemoryProject[] = [];
const EMPTY_MEMORIES: MemoryRecordWire[] = [];
const ThemedTextInput = withUnistyles(TextInput);
const placeholderColor = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });
const ThemedSearch = withUnistyles(Search);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  projectSelect: { minWidth: 220, maxWidth: 360, flexGrow: 1 },
  content: { paddingTop: theme.spacing[4], paddingBottom: theme.spacing[8], gap: 0 },
  searchBox: {
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
  },
  searchInput: { flex: 1, fontSize: 14, color: theme.colors.foreground, height: 44 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  columnHeader: { fontSize: 14, color: theme.colors.foregroundMuted },
  flexColumn: { flex: 1 },
  sourceColumn: { width: MEMORY_COLUMN_WIDTHS.source },
  usedColumn: { width: MEMORY_COLUMN_WIDTHS.used },
  lastUsedColumn: { width: MEMORY_COLUMN_WIDTHS.lastUsed },
  actionsColumn: { width: MEMORY_COLUMN_WIDTHS.actions },
  empty: {
    fontSize: 14,
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[6],
    textAlign: "center",
  },
}));
