import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Brain, Plus, Search } from "lucide-react-native";
import type {
  MemoryProject,
  MemoryRecordWire,
  MemoryStatusWire,
} from "@jagentdesk/protocol/memory";
import type { MemoryScope } from "../shared/types";
import {
  Alert,
  Button,
  PageHeader,
  type PageHeaderPrimaryAction,
  useGumloopPageGutterStyle,
  useHostRuntimeIsConnected,
  useHostRuntimeClient,
  useIsCompactFormFactor,
  useToast,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { MemoryFilters, type KindFilter } from "./filters";
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
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<MemoryStatusWire | null>(null);
  const [editor, setEditor] = useState<MemoryEditorTarget | null>(null);
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const list = useMemoryList(serverId, {
    scope,
    projectId,
    query,
    kind: kind === "all" ? null : kind,
    status,
  });
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

  // Spec 42 §8 "Validate now": re-checks every lesson's citations in this project.
  const validateAll = useCallback(() => {
    if (!client || !projectId) return;
    client.validateMemories({ projectId }).then(
      ({ memories: checked }) => {
        const stale = checked.filter((memory) => memory.status === "stale").length;
        toast.show(t("memory.lesson.validatedAll", { count: checked.length, stale }));
        return undefined;
      },
      (error: unknown) => toast.error(error instanceof Error ? error.message : String(error)),
    );
  }, [client, projectId, t, toast]);

  // "Validate now" is the secondary action; "Add memory" is the page's primary one, which a
  // phone shows as the top bar's "+" (spec 38 §5).
  const headerActions = useMemo(
    () =>
      scope === "project" ? (
        <Button
          size="sm"
          variant="secondary"
          onPress={validateAll}
          disabled={!connected || !projectId}
          testID="memory-validate-all"
        >
          {t("memory.lesson.validate")}
        </Button>
      ) : null,
    [connected, projectId, scope, t, validateAll],
  );
  const addLabel = t("memory.add");
  const addDisabled = !connected || (scope === "project" && !projectId);
  const primaryAction = useMemo<PageHeaderPrimaryAction>(
    () => ({
      icon: Plus,
      label: addLabel,
      onPress: openCreate,
      disabled: addDisabled,
      testID: "memory-add",
    }),
    [addDisabled, addLabel, openCreate],
  );
  const selectedProject = projects.find((project) => project.projectId === projectId) ?? null;
  const tabs = useMemo(
    () => (
      <MemoryFilters
        compact={compact}
        scope={scope}
        onScopeChange={setScope}
        kind={kind}
        onKindChange={setKind}
        status={status}
        onStatusChange={setStatus}
        projects={projects}
        projectId={projectId}
        onProjectChange={setProjectId}
      />
    ),
    [compact, kind, projectId, projects, scope, status],
  );

  const memories = useMemo(() => pendingFirst(data?.memories ?? EMPTY_MEMORIES), [data]);
  const pendingCount = memories.filter((memory) => memory.status === "pending").length;
  const projectRoot = scope === "project" ? (selectedProject?.rootPath ?? null) : null;
  return (
    <View style={styles.root} testID="memory-screen">
      <PageHeader
        icon={Brain}
        title={t("memory.title")}
        description={t("memory.description")}
        actions={headerActions}
        primaryAction={primaryAction}
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
        {memories.map((memory, index) => (
          <View key={memory.id}>
            {pendingCount > 0 && index === 0 && memory.status === "pending" ? (
              <Text style={styles.sectionTitle} testID="memory-pending-heading">
                {t("memory.lesson.pendingHeading", { count: pendingCount })}
              </Text>
            ) : null}
            {pendingCount > 0 && index === pendingCount && memory.status !== "pending" ? (
              <View style={styles.sectionGap} />
            ) : null}
            <MemoryRow
              serverId={serverId}
              memory={memory}
              onEdit={openEdit}
              projectRoot={projectRoot}
            />
          </View>
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

/** Spec 42 §7: pending lessons from Capture lessons sit on top until the user reviews them. */
function pendingFirst(memories: MemoryRecordWire[]): MemoryRecordWire[] {
  const pending = memories.filter((memory) => memory.status === "pending");
  if (pending.length === 0) return memories;
  return [...pending, ...memories.filter((memory) => memory.status !== "pending")];
}

const EMPTY_PROJECTS: MemoryProject[] = [];
const EMPTY_MEMORIES: MemoryRecordWire[] = [];
const ThemedTextInput = withUnistyles(TextInput);
const placeholderColor = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });
const ThemedSearch = withUnistyles(Search);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  sectionGap: { height: theme.spacing[4] },
  // 16 px page padding on phones and classic themes; the Gumloop desktop gutter overrides it.
  content: {
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
    gap: 0,
  },
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
