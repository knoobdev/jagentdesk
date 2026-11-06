import { default as React, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react-native";
import { useQueryClient } from "@tanstack/react-query";
import type {
  FigmaConnection,
  FigmaFile,
  FigmaLinkFile,
  FigmaNode,
  FigmaPage,
  FigmaProjectFile,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { callFigma, errorMessage } from "@/figma/api";
import {
  invalidateFigmaFiles,
  useFigmaConnections,
  useFigmaFiles,
  useFigmaLinkStatus,
  useFigmaNodes,
  useFigmaOutline,
  useFigmaSectionChildren,
  useFigmaTeamFiles,
  useFigmaTeamProjects,
  useFigmaTeams,
} from "@/figma/queries";
import { useFigmaGlobalNav, type FigmaNav } from "@/figma/nav";
import { childSummaries, type SectionAwareSummary } from "@/figma/canvas/section-outline";
import { useHostFeature } from "@/runtime/host-features";
import { parseFigmaFileUrl, parseFigmaTeamUrl } from "@/figma/url-parse";
import {
  BrowseFilesRow,
  BrowseGuidanceRow,
  canBrowseFigmaFiles,
  describeFigmaApiError,
} from "@/figma/browse-files";

// The left column while the Figma section is open (spec 32.5), owned the way the Jira column owns
// its navigation: connections with their auth state; under the selected connection its files —
// Pinned, Recent, and the files Figma Link reports open right now — plus added teams and their
// projects; when a file is open, its pages and the layer tree of the selected frame, searchable
// by name. Rows drive the Figma screen's route params. The primary add is Browse files
// (ADR-0038, desktop only); the URL-paste rows sit under an explicit Advanced disclosure so a
// bad paste parses client-side first and never leaves the column.

// Theme-reactive icons. `withUnistyles(Component, mappings)` keeps the color on the theme
// (light + dark) without the `uniProps` prop, which leaks onto the DOM node on web and draws
// a "React does not recognize the uniProps prop" warning on every Figma page.
const ThemedChevronDown = withUnistyles(ChevronDown, (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));
const ThemedChevronLeft = withUnistyles(ChevronLeft, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedChevronRight = withUnistyles(ChevronRight, (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));
const ThemedExternalMuted = withUnistyles(ExternalLink, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedExternalFaint = withUnistyles(ExternalLink, (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));
const ThemedFileMuted = withUnistyles(FileText, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedFileFaint = withUnistyles(FileText, (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));
const ThemedFolder = withUnistyles(Folder, (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));
const ThemedPlus = withUnistyles(Plus, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedSearch = withUnistyles(Search, (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
}));
const ThemedUsers = withUnistyles(Users, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedX = withUnistyles(X, (theme: Theme) => ({ color: theme.colors.foregroundMuted }));

type Go = FigmaNav["go"];

const DOT_STYLE = {
  connected: "dotGreen",
  needs_reauth: "dotYellow",
  error: "dotRed",
} as const;

function groupFiles(files: readonly FigmaFile[]) {
  const pinned = files.filter((file) => file.pinned);
  const recent = files
    .filter((file) => !file.pinned)
    .sort((a, b) => (b.lastOpenedAt_ms ?? 0) - (a.lastOpenedAt_ms ?? 0));
  return { pinned, recent };
}

function matchesSearch(node: { name: string }, needle: string): boolean {
  if (!needle) return true;
  return node.name.toLowerCase().includes(needle.toLowerCase());
}

// The indentation of nested layer rows is fixed at render; 4px per level.
function themeSpacing(level: number): number {
  return level * 4;
}

function FileRow({
  serverId,
  file,
  active,
  go,
}: {
  serverId: string;
  file: FigmaFile;
  active: boolean;
  go: Go;
}) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const open = useCallback(
    () => go({ fileKey: file.fileKey, pageId: null, nodeId: null, version: null }),
    [file.fileKey, go],
  );
  const togglePin = useCallback(
    (event?: { stopPropagation?: () => void }) => {
      event?.stopPropagation?.();
      void callFigma(client, "figma.files.pin.request", {
        fileKey: file.fileKey,
        pinned: !file.pinned,
      }).then(() => invalidateFigmaFiles(queryClient, serverId));
    },
    [client, file.fileKey, file.pinned, queryClient, serverId],
  );
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const pinLabel = useMemo(
    () => (file.pinned ? `Unpin ${file.name}` : `Pin ${file.name}`),
    [file.name, file.pinned],
  );
  return (
    // The row is a View wrapper holding two sibling Pressables: a Pressable inside a Pressable
    // renders nested <button>s on web and React warns ("<button> cannot be a descendant of
    // <button>") — the pin must not live inside the open target.
    <View style={active ? styles.rowActive : styles.row}>
      <Pressable
        style={styles.rowMain}
        onPress={open}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        testID={`figma-nav-file-${file.fileKey}`}
      >
        <ThemedFileMuted size={13} />
        <Text style={active ? styles.rowLabelActive : styles.rowLabel} numberOfLines={1}>
          {file.name || file.fileKey}
        </Text>
        {file.linked ? <ThemedExternalFaint size={12} /> : null}
      </Pressable>
      <Pressable
        hitSlop={8}
        onPress={togglePin}
        accessibilityRole="button"
        accessibilityLabel={pinLabel}
        testID={`figma-nav-pin-${file.fileKey}`}
        style={styles.pinButton}
      >
        <Text style={styles.pinText}>{file.pinned ? "★" : "☆"}</Text>
      </Pressable>
    </View>
  );
}

function AddByUrlRow({
  placeholder,
  parse,
  add,
  testID,
  onAdded,
}: {
  placeholder: string;
  parse: (input: string) => unknown;
  add: (url: string) => Promise<unknown>;
  testID: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!parse(trimmed)) {
      setError("That is not a Figma URL.");
      return;
    }
    try {
      await add(trimmed);
      setValue("");
      setError(null);
      setOpen(false);
      onAdded();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [add, onAdded, parse, value]);
  const openForm = useCallback(() => setOpen(true), []);
  const closeForm = useCallback(() => setOpen(false), []);
  const submitEditing = useCallback(() => {
    void submit();
  }, [submit]);
  if (!open) {
    return (
      <Pressable
        style={styles.addRow}
        onPress={openForm}
        accessibilityRole="button"
        testID={`${testID}-open`}
      >
        <ThemedPlus size={13} />
        <Text style={styles.addRowLabel}>{placeholder}</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.addForm}>
      <TextInput
        value={value}
        onChangeText={setValue}
        onSubmitEditing={submitEditing}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.addInput}
        testID={`${testID}-input`}
      />
      <Pressable
        onPress={submitEditing}
        accessibilityRole="button"
        testID={`${testID}-submit`}
        style={styles.pinButton}
      >
        <Text style={styles.pinText}>Add</Text>
      </Pressable>
      <Pressable
        onPress={closeForm}
        accessibilityRole="button"
        testID={`${testID}-cancel`}
        style={styles.pinButton}
      >
        <ThemedX size={12} />
      </Pressable>
      {error ? <Text style={styles.empty}>{error}</Text> : null}
    </View>
  );
}

function AddFileRow({ serverId, connectionId }: { serverId: string; connectionId: string }) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const { go } = useFigmaGlobalNav();
  const addFile = useCallback(
    async (url: string) => {
      const response = await callFigma(client, "figma.files.add.request", { connectionId, url });
      if (response.file) {
        go({ fileKey: response.file.fileKey, pageId: null, nodeId: null, version: null });
      }
      return response;
    },
    [client, connectionId, go],
  );
  const onAdded = useCallback(
    () => invalidateFigmaFiles(queryClient, serverId),
    [queryClient, serverId],
  );
  return (
    <AddByUrlRow
      placeholder="Add file by URL"
      testID="figma-nav-add-file"
      parse={parseFigmaFileUrl}
      add={addFile}
      onAdded={onAdded}
    />
  );
}

function AddTeamRow({ serverId, connectionId }: { serverId: string; connectionId: string }) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const addTeam = useCallback(
    (url: string) => callFigma(client, "figma.teams.add.request", { connectionId, url }),
    [client, connectionId],
  );
  const onAdded = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["figma", serverId, "teams", connectionId] }),
    [connectionId, queryClient, serverId],
  );
  return (
    <AddByUrlRow
      placeholder="Add team by URL"
      testID="figma-nav-add-team"
      parse={parseFigmaTeamUrl}
      add={addTeam}
      onAdded={onAdded}
    />
  );
}

function TeamFileRow({ file, indent, go }: { file: FigmaProjectFile; indent: 1 | 2; go: Go }) {
  const open = useCallback(
    () => go({ fileKey: file.fileKey, pageId: null, nodeId: null, version: null }),
    [file.fileKey, go],
  );
  return (
    <Pressable
      style={[styles.row, indent === 2 ? styles.indent2 : styles.indent1]}
      onPress={open}
      accessibilityRole="button"
      testID={`figma-nav-team-file-${file.fileKey}`}
    >
      <ThemedFileFaint size={12} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {file.name}
      </Text>
    </Pressable>
  );
}

function TeamProjectFiles({
  serverId,
  connectionId,
  projectId,
  go,
}: {
  serverId: string;
  connectionId: string;
  projectId: string;
  go: Go;
}) {
  const files = useFigmaTeamFiles(serverId, connectionId, projectId);
  if (files.isLoading) return <Text style={styles.empty}>Loading files…</Text>;
  if (files.error) return <Text style={styles.empty}>{files.error.message}</Text>;
  return (
    <>
      {(files.data ?? []).map((file) => (
        <TeamFileRow key={file.fileKey} file={file} indent={2} go={go} />
      ))}
    </>
  );
}

function ProjectRow({
  serverId,
  connectionId,
  project,
  expanded,
  onToggle,
  go,
}: {
  serverId: string;
  connectionId: string;
  project: { id: string; name: string };
  expanded: boolean;
  onToggle: (projectId: string, wasExpanded: boolean) => void;
  go: Go;
}) {
  const toggle = useCallback(
    () => onToggle(project.id, expanded),
    [expanded, onToggle, project.id],
  );
  return (
    <View>
      <Pressable
        style={[styles.row, styles.indent1]}
        onPress={toggle}
        accessibilityRole="button"
        testID={`figma-nav-project-${project.id}`}
      >
        {expanded ? <ThemedChevronDown size={12} /> : <ThemedChevronRight size={12} />}
        <ThemedFolder size={12} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {project.name}
        </Text>
      </Pressable>
      {expanded ? (
        <TeamProjectFiles
          serverId={serverId}
          connectionId={connectionId}
          projectId={project.id}
          go={go}
        />
      ) : null}
    </View>
  );
}

function TeamProjects({
  serverId,
  connectionId,
  teamId,
  go,
}: {
  serverId: string;
  connectionId: string;
  teamId: string;
  go: Go;
}) {
  const projects = useFigmaTeamProjects(serverId, connectionId, teamId);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const toggle = useCallback((projectId: string, wasExpanded: boolean) => {
    setOpenProject(wasExpanded ? null : projectId);
  }, []);
  if (projects.isLoading) return <Text style={styles.empty}>Loading projects…</Text>;
  if (projects.error) return <Text style={styles.empty}>{projects.error.message}</Text>;
  return (
    <>
      {(projects.data ?? []).map((project) => (
        <ProjectRow
          key={project.id}
          serverId={serverId}
          connectionId={connectionId}
          project={project}
          expanded={openProject === project.id}
          onToggle={toggle}
          go={go}
        />
      ))}
    </>
  );
}

function TeamRow({
  serverId,
  connectionId,
  teamId,
  teamName,
  go,
}: {
  serverId: string;
  connectionId: string;
  teamId: string;
  teamName: string;
  go: Go;
}) {
  const [expanded, setExpanded] = useState(false);
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const remove = useCallback(() => {
    void callFigma(client, "figma.teams.remove.request", { connectionId, teamId }).then(() =>
      queryClient.invalidateQueries({ queryKey: ["figma", serverId, "teams", connectionId] }),
    );
  }, [client, connectionId, queryClient, serverId, teamId]);
  const toggle = useCallback(() => {
    setExpanded((previous) => !previous);
  }, []);
  return (
    <View>
      <Pressable
        style={styles.row}
        onPress={toggle}
        onLongPress={remove}
        accessibilityRole="button"
        testID={`figma-nav-team-${teamId}`}
      >
        {expanded ? <ThemedChevronDown size={12} /> : <ThemedChevronRight size={12} />}
        <ThemedUsers size={13} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {teamName}
        </Text>
      </Pressable>
      {expanded ? (
        <TeamProjects serverId={serverId} connectionId={connectionId} teamId={teamId} go={go} />
      ) : null}
    </View>
  );
}

function LayerChevron({ hasChildren, expanded }: { hasChildren: boolean; expanded: boolean }) {
  if (!hasChildren) return null;
  return expanded ? <ThemedChevronDown size={11} /> : <ThemedChevronRight size={11} />;
}

function LayerNodeRow({
  node,
  depth,
  selectedNodeId,
  onSelect,
  search,
}: {
  node: FigmaNode;
  depth: number;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
  search: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = useMemo(
    () => (node.children ?? []).filter((child) => matchesSearch(child, search)),
    [node.children, search],
  );
  const hasChildren = children.length > 0;
  const press = useCallback(() => {
    if (hasChildren) setExpanded((previous) => !previous);
    onSelect(node.id);
  }, [hasChildren, node.id, onSelect]);
  const rowStyle = useMemo(
    () => [styles.row, { paddingLeft: themeSpacing(3) + themeSpacing(6) + depth * 12 }],
    [depth],
  );
  return (
    <View>
      <Pressable
        style={rowStyle}
        onPress={press}
        accessibilityRole="button"
        testID={`figma-nav-layer-${node.id}`}
      >
        <LayerChevron hasChildren={hasChildren} expanded={expanded} />
        <Text
          style={selectedNodeId === node.id ? styles.rowLabelActive : styles.rowLabel}
          numberOfLines={1}
        >
          {node.name}
        </Text>
        <Text style={styles.rowSub}>{node.type}</Text>
      </Pressable>
      {expanded
        ? children.map((child) => (
            <LayerNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedNodeId={selectedNodeId}
              onSelect={onSelect}
              search={search}
            />
          ))
        : null}
    </View>
  );
}

function FrameLayers({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: unknown;
  children: React.ReactNode;
}) {
  if (loading) return <Text style={styles.empty}>Loading layers…</Text>;
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <Text style={styles.empty}>{message}</Text>;
  }
  return <View>{children}</View>;
}

// ── Outline tree (ADR-0039) ─────────────────────────────────────────────────
// The depth-3 outline delivers a FLAT, ordered list of frame summaries with an
// OPTIONAL `parentId` and a SECTION-only `childrenLoaded`. Rows render strictly
// by parentId (siblings keep the order the API returned); a SECTION expands to
// its real child summaries when the outline carried them, and to a depth-1
// snapshot read — its own cache namespace, the outline's pinned version — when
// they are still unknown. The sidebar never loads a full SECTION subtree and
// never prefetches sections just because the file opened; only expanding a
// REAL frame pulls its full tree (useFigmaNodes). Hosts without the
// figmaNodeDepth capability get a disabled section row plus an update hint —
// no speculative full-Section fallback.

interface OutlineTree {
  roots: SectionAwareSummary[];
  byParent: Map<string, SectionAwareSummary[]>;
}

const NO_CHILDREN = new Map<string, SectionAwareSummary[]>();

function buildOutlineTree(frames: readonly SectionAwareSummary[]): OutlineTree {
  const roots: SectionAwareSummary[] = [];
  const byParent = new Map<string, SectionAwareSummary[]>();
  for (const summary of frames) {
    const parent = summary.parentId ?? null;
    if (parent) {
      const bucket = byParent.get(parent);
      if (bucket) bucket.push(summary);
      else byParent.set(parent, [summary]);
    } else {
      roots.push(summary);
    }
  }
  return { roots, byParent };
}

// Page-child rows start at the old indent1 inset and step 12px per nesting
// level, so section children line up under their parent section.
function outlineRowIndent(depth: number): number {
  return themeSpacing(3) + themeSpacing(2) + depth * 12;
}

interface OutlineRowProps {
  serverId: string;
  fileKey: string;
  /** Route-pinned version for full-tree reads (old behavior, unchanged). */
  version: string | null;
  /** Snapshot version the displayed outline came from; required for depth-1. */
  pinnedVersion: string | null;
  canReadNodeDepth: boolean;
  /** One-open-per-page rule, shared by frames and sections; node ids are
   * file-global, so a set keyed by id nests correctly at every level. */
  expandedIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  onSelectFrame: (frameId: string) => void;
  onSelectNode: (nodeId: string) => void;
  onToggleSection: (sectionId: string, wasExpanded: boolean) => void;
  search: string;
}

function FrameRow({
  serverId,
  fileKey,
  version,
  frame,
  depth,
  expanded,
  selectedNodeId,
  onSelectFrame,
  onSelectNode,
  search,
}: OutlineRowProps & { frame: SectionAwareSummary; depth: number; expanded: boolean }) {
  // The subtree under a frame is fetched from figma.file.nodes only once that frame is open
  // (32.5.2) — the outline alone carries just the frame summaries.
  const nodes = useFigmaNodes(serverId, fileKey, expanded ? [frame.id] : [], version);
  const frameNode = expanded ? (nodes.data?.nodes?.[frame.id] ?? null) : null;
  const children = useMemo(
    () => (frameNode?.children ?? []).filter((child) => matchesSearch(child, search)),
    [frameNode, search],
  );
  const press = useCallback(() => onSelectFrame(frame.id), [frame.id, onSelectFrame]);
  return (
    <View>
      <Pressable
        style={[styles.row, { paddingLeft: outlineRowIndent(depth) }]}
        onPress={press}
        accessibilityRole="button"
        testID={`figma-nav-frame-${frame.id}`}
      >
        {expanded ? <ThemedChevronDown size={12} /> : <ThemedChevronRight size={12} />}
        <Text
          style={selectedNodeId === frame.id ? styles.rowLabelActive : styles.rowLabel}
          numberOfLines={1}
        >
          {frame.name}
        </Text>
      </Pressable>
      {expanded ? (
        <FrameLayers loading={nodes.isLoading} error={nodes.error}>
          {children.map((node) => (
            <LayerNodeRow
              key={node.id}
              node={node}
              depth={0}
              selectedNodeId={selectedNodeId}
              onSelect={onSelectNode}
              search={search}
            />
          ))}
        </FrameLayers>
      ) : null}
    </View>
  );
}

function SectionRow({
  serverId,
  fileKey,
  version,
  pinnedVersion,
  canReadNodeDepth,
  section,
  byParent,
  depth,
  expanded,
  expandedIds,
  selectedNodeId,
  onSelectFrame,
  onSelectNode,
  onToggleSection,
  search,
}: OutlineRowProps & {
  section: SectionAwareSummary;
  byParent: OutlineTree["byParent"];
  depth: number;
  expanded: boolean;
}) {
  const knownChildren = useMemo(() => byParent.get(section.id) ?? [], [byParent, section.id]);
  // Unknown children = the outline did NOT flatten this section (nested
  // sections at the depth-3 boundary carry childrenLoaded:false; a summary
  // with no flag at all reads the same way). Only expanding reads depth 1.
  const childrenUnknown = knownChildren.length === 0 && section.childrenLoaded !== true;
  const expandable = knownChildren.length > 0 || childrenUnknown;
  // The shallow read needs the host capability AND the outline's pinned
  // version; the helper stays disabled (never a full-subtree guess) without
  // either, and the row is disabled with an update hint when the host lacks it.
  const shallow = useFigmaSectionChildren(
    serverId,
    fileKey,
    expanded && childrenUnknown && canReadNodeDepth ? section.id : null,
    pinnedVersion,
  );
  const lazyChildren = useMemo(() => {
    if (!expanded || !childrenUnknown) return [];
    const node = shallow.data?.nodes?.[section.id] ?? null;
    return node ? childSummaries(node) : [];
  }, [childrenUnknown, expanded, section.id, shallow.data]);
  const press = useCallback(() => {
    if (expandable) onToggleSection(section.id, expandedIds.has(section.id));
  }, [expandable, expandedIds, onToggleSection, section.id]);
  const nested: OutlineRowProps = {
    serverId,
    fileKey,
    version,
    pinnedVersion,
    canReadNodeDepth,
    expandedIds,
    selectedNodeId,
    onSelectFrame,
    onSelectNode,
    onToggleSection,
    search,
  };
  let openChildren: React.ReactNode = null;
  if (expanded) {
    openChildren = childrenUnknown ? (
      <FrameLayers loading={shallow.isLoading} error={shallow.error}>
        <OutlineRows
          {...nested}
          summaries={lazyChildren}
          byParent={NO_CHILDREN}
          depth={depth + 1}
        />
      </FrameLayers>
    ) : (
      <OutlineRows {...nested} summaries={knownChildren} byParent={byParent} depth={depth + 1} />
    );
  }
  return (
    <View>
      <Pressable
        style={[styles.row, { paddingLeft: outlineRowIndent(depth) }]}
        onPress={press}
        accessibilityRole="button"
        disabled={childrenUnknown && !canReadNodeDepth}
        testID={`figma-nav-section-${section.id}`}
      >
        <LayerChevron hasChildren={expandable} expanded={expanded} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {section.name}
        </Text>
      </Pressable>
      {expandable && childrenUnknown && !canReadNodeDepth ? (
        <Text
          style={[styles.rowSub, { paddingLeft: outlineRowIndent(depth + 1) }]}
          testID={`figma-nav-section-${section.id}-update-hint`}
        >
          Update the host to browse sections.
        </Text>
      ) : null}
      {openChildren}
    </View>
  );
}

function OutlineRows({
  summaries,
  byParent,
  depth,
  ...rows
}: OutlineRowProps & {
  summaries: readonly SectionAwareSummary[];
  byParent: OutlineTree["byParent"];
  depth: number;
}) {
  return (
    <>
      {summaries
        .filter((summary) => matchesSearch(summary, rows.search))
        .map((summary) =>
          summary.type === "SECTION" ? (
            <SectionRow
              key={summary.id}
              {...rows}
              section={summary}
              byParent={byParent}
              depth={depth}
              expanded={rows.expandedIds.has(summary.id)}
            />
          ) : (
            <FrameRow
              key={summary.id}
              {...rows}
              frame={summary}
              depth={depth}
              expanded={rows.expandedIds.has(summary.id)}
            />
          ),
        )}
    </>
  );
}

function PageRow({
  serverId,
  fileKey,
  version,
  pinnedVersion,
  canReadNodeDepth,
  page,
  go,
  expandedIds,
  selectedNodeId,
  onToggleFrame,
  onToggleSection,
  onSelectNode,
  search,
  onSearchChange,
}: {
  serverId: string;
  fileKey: string;
  version: string | null;
  pinnedVersion: string | null;
  canReadNodeDepth: boolean;
  page: FigmaPage;
  go: Go;
  expandedIds: ReadonlySet<string>;
  selectedNodeId: string | null;
  onToggleFrame: (pageId: string, frameId: string, wasExpanded: boolean) => void;
  onToggleSection: (pageId: string, sectionId: string, wasExpanded: boolean) => void;
  onSelectNode: (nodeId: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { location } = useFigmaGlobalNav();
  const selected = location.pageId === page.id;
  const selectPage = useCallback(() => {
    go({ pageId: page.id, nodeId: null });
  }, [go, page.id]);
  const selectFrame = useCallback(
    (frameId: string) => onToggleFrame(page.id, frameId, expandedIds.has(frameId)),
    [expandedIds, onToggleFrame, page.id],
  );
  const toggleSection = useCallback(
    (sectionId: string, wasExpanded: boolean) => onToggleSection(page.id, sectionId, wasExpanded),
    [onToggleSection, page.id],
  );
  // The flat summaries become a hierarchy strictly through parentId.
  const tree = useMemo(
    () => buildOutlineTree(page.frames as readonly SectionAwareSummary[]),
    [page.frames],
  );
  const searchRow = useMemo(
    () => (
      <View style={[styles.row, styles.indent1]}>
        <ThemedSearch size={12} />
        <TextInput
          value={search}
          onChangeText={onSearchChange}
          placeholder="Search layers"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
          testID="figma-nav-layer-search"
        />
      </View>
    ),
    [onSearchChange, search],
  );
  return (
    <View>
      <Pressable
        style={selected ? styles.rowActive : styles.row}
        onPress={selectPage}
        accessibilityRole="button"
        testID={`figma-nav-page-${page.id}`}
      >
        {selected ? <ThemedChevronDown size={12} /> : <ThemedChevronRight size={12} />}
        <Text style={selected ? styles.rowLabelActive : styles.rowLabel} numberOfLines={1}>
          {page.name}
        </Text>
      </Pressable>
      {selected ? (
        <>
          {searchRow}
          <OutlineRows
            serverId={serverId}
            fileKey={fileKey}
            version={version}
            pinnedVersion={pinnedVersion}
            canReadNodeDepth={canReadNodeDepth}
            expandedIds={expandedIds}
            selectedNodeId={selectedNodeId}
            onSelectFrame={selectFrame}
            onSelectNode={onSelectNode}
            onToggleSection={toggleSection}
            search={search}
            summaries={tree.roots}
            byParent={tree.byParent}
            depth={0}
          />
        </>
      ) : null}
    </View>
  );
}

function PagesAndLayers({
  serverId,
  fileKey,
  version,
  go,
}: {
  serverId: string;
  fileKey: string;
  version: string | null;
  go: Go;
}) {
  const { location } = useFigmaGlobalNav();
  const outline = useFigmaOutline(serverId, fileKey, version);
  const canReadNodeDepth = useHostFeature(serverId, "figmaNodeDepth");
  const [search, setSearch] = useState("");
  const pages = useMemo(() => outline.data?.pages ?? [], [outline.data]);
  // The outline response pins the snapshot its tree came from; depth-1 section
  // reads must run against the SAME version (the handler requires a non-empty
  // one — null here simply keeps the shallow read disabled, never a fallback).
  const pinnedVersion = outline.data?.version ?? null;
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const openRow = useCallback((rowId: string, wasExpanded: boolean) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (wasExpanded) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);
  const toggleFrame = useCallback(
    (pageId: string, frameId: string, wasExpanded: boolean) => {
      go({ pageId, nodeId: frameId });
      openRow(frameId, wasExpanded);
    },
    [go, openRow],
  );
  const toggleSection = useCallback(
    (_pageId: string, sectionId: string, wasExpanded: boolean) => {
      // Expanding a section is tree navigation, not a canvas selection: the
      // selected node stays where it was, only the row opens.
      openRow(sectionId, wasExpanded);
    },
    [openRow],
  );
  const selectNode = useCallback((nodeId: string) => go({ nodeId }), [go]);
  const changeSearch = useCallback((value: string) => setSearch(value), []);
  if (outline.isLoading) return <Text style={styles.empty}>Loading pages…</Text>;
  if (outline.error) return <Text style={styles.empty}>{outline.error.message}</Text>;
  return (
    <>
      <Text style={styles.sectionLabel}>Pages</Text>
      {pages.map((page) => (
        <PageRow
          key={page.id}
          serverId={serverId}
          fileKey={fileKey}
          version={version}
          pinnedVersion={pinnedVersion}
          canReadNodeDepth={canReadNodeDepth}
          page={page}
          go={go}
          expandedIds={location.pageId === page.id ? expandedIds : EMPTY_IDS}
          selectedNodeId={location.nodeId}
          onToggleFrame={toggleFrame}
          onToggleSection={toggleSection}
          onSelectNode={selectNode}
          search={search}
          onSearchChange={changeSearch}
        />
      ))}
    </>
  );
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

function ConnectionRow({
  connection,
  selected,
  go,
}: {
  connection: FigmaConnection;
  selected: boolean;
  go: Go;
}) {
  const open = useCallback(
    () =>
      go({
        connectionId: connection.id,
        fileKey: null,
        pageId: null,
        nodeId: null,
        version: null,
      }),
    [connection.id, go],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const subtitle = useMemo(() => {
    if (connection.authState === "connected") return connection.account.email ?? "Connected";
    return connection.lastError ?? "Sign in again";
  }, [connection.account.email, connection.authState, connection.lastError]);
  return (
    <Pressable
      style={selected ? styles.rowActive : styles.row}
      onPress={open}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      testID={`figma-nav-connection-${connection.id}`}
    >
      <View style={styles[DOT_STYLE[connection.authState]]} />
      <View style={styles.rowText}>
        <Text style={selected ? styles.rowLabelActive : styles.rowLabel} numberOfLines={1}>
          {connection.account.handle}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function LinkedFileRow({ file, go }: { file: FigmaLinkFile; go: Go }) {
  const open = useCallback(
    () => go({ fileKey: file.fileKey, pageId: null, nodeId: null, version: null }),
    [file.fileKey, go],
  );
  return (
    <Pressable
      style={styles.row}
      onPress={open}
      accessibilityRole="button"
      testID={`figma-nav-linked-${file.fileKey}`}
    >
      <ThemedExternalMuted size={13} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {file.fileName}
      </Text>
      {file.pageName ? <Text style={styles.rowSub}>{file.pageName}</Text> : null}
    </Pressable>
  );
}

function OpenInFigmaSection({ serverId }: { serverId: string }) {
  const { go } = useFigmaGlobalNav();
  const link = useFigmaLinkStatus(serverId);
  const openNow = useMemo(
    () => (link.data?.files ?? []).filter((file) => file.paired),
    [link.data],
  );
  if (openNow.length === 0) return null;
  return (
    <>
      <Text style={styles.sectionLabel}>Open in Figma</Text>
      {openNow.map((file) => (
        <LinkedFileRow key={file.fileKey} file={file} go={go} />
      ))}
    </>
  );
}

// Everything under a CONNECTED account: the Browse-first Files section (URL
// paste lives under the Advanced disclosure), Teams, and the Figma Link rows.
function ConnectedTree({
  serverId,
  connectionId,
  fileKey,
  go,
}: {
  serverId: string;
  connectionId: string;
  fileKey: string | null;
  go: Go;
}) {
  const files = useFigmaFiles(serverId, connectionId);
  const teams = useFigmaTeams(serverId, connectionId);
  const { pinned, recent } = useMemo(() => groupFiles(files.data ?? []), [files.data]);
  const teamList = useMemo(() => teams.data ?? [], [teams.data]);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const toggleAdvanced = useCallback(() => setAdvancedOpen((previous) => !previous), []);
  return (
    <>
      <Text style={styles.sectionLabel}>Files</Text>
      {/* Browse files is the primary add (ADR-0038). It needs the native
          pick, so non-desktop sessions get guidance instead of a fake
          picker, and the URL-paste rows stay reachable under Advanced. */}
      {canBrowseFigmaFiles() ? (
        <BrowseFilesRow serverId={serverId} connectionId={connectionId} />
      ) : (
        <BrowseGuidanceRow />
      )}
      {files.isLoading ? <Text style={styles.empty}>Loading files…</Text> : null}
      {files.error ? (
        <Text style={styles.emptyError} testID="figma-nav-files-error">
          {describeFigmaApiError(files.error)}
        </Text>
      ) : null}
      {pinned.length > 0 ? (
        <>
          <Text style={[styles.rowSub, styles.groupLabel]}>Pinned</Text>
          {pinned.map((file) => (
            <FileRow
              key={file.fileKey}
              serverId={serverId}
              file={file}
              active={fileKey === file.fileKey}
              go={go}
            />
          ))}
        </>
      ) : null}
      {recent.length > 0 ? (
        <>
          <Text style={[styles.rowSub, styles.groupLabel]}>Recent</Text>
          {recent.slice(0, 8).map((file) => (
            <FileRow
              key={file.fileKey}
              serverId={serverId}
              file={file}
              active={fileKey === file.fileKey}
              go={go}
            />
          ))}
        </>
      ) : null}
      {!files.isLoading && !files.error && !pinned.length && !recent.length ? (
        <Text style={styles.empty} testID="figma-nav-files-empty">
          No files yet. Use Browse files, or paste a URL under Advanced.
        </Text>
      ) : null}

      <Text style={styles.sectionLabel}>Teams</Text>
      {teams.isLoading ? <Text style={styles.empty}>Loading teams…</Text> : null}
      {teams.error ? (
        <Text style={styles.emptyError} testID="figma-nav-teams-error">
          {describeFigmaApiError(teams.error)}
        </Text>
      ) : null}
      {teamList.map((team) => (
        <TeamRow
          key={team.teamId}
          serverId={serverId}
          connectionId={connectionId}
          teamId={team.teamId}
          teamName={team.name}
          go={go}
        />
      ))}
      {!teams.isLoading && !teams.error && !teamList.length ? (
        <Text style={styles.empty} testID="figma-nav-teams-empty">
          No teams yet. Add a team by URL under Advanced.
        </Text>
      ) : null}

      <Pressable
        style={styles.advancedRow}
        onPress={toggleAdvanced}
        accessibilityRole="button"
        testID="figma-nav-advanced"
      >
        <Text style={styles.advancedLabel}>{advancedOpen ? "▾" : "▸"} Advanced</Text>
      </Pressable>
      {advancedOpen ? (
        <View testID="figma-nav-advanced-panel">
          <AddFileRow serverId={serverId} connectionId={connectionId} />
          <AddTeamRow serverId={serverId} connectionId={connectionId} />
        </View>
      ) : null}
      <OpenInFigmaSection serverId={serverId} />
    </>
  );
}

export function SidebarFigmaNav({ serverId }: { serverId: string }) {
  const { location, go } = useFigmaGlobalNav();
  const connections = useFigmaConnections(serverId);
  const list = useMemo(() => connections.data ?? [], [connections.data]);
  const selected = useMemo(
    () => list.find((c) => c.id === location.connectionId) ?? list[0] ?? null,
    [list, location.connectionId],
  );
  const leave = useCallback(() => router.push("/"), []);
  const openLink = useCallback(() => go({ view: "link" }), [go]);
  const openConnect = useCallback(() => go({ view: "connect" }), [go]);
  return (
    <View style={styles.root} testID="sidebar-figma-nav-panel">
      <View style={styles.header}>
        <Pressable
          style={styles.back}
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Leave Figma"
          testID="sidebar-figma-leave"
        >
          <ThemedChevronLeft size={16} />
        </Pressable>
        <Pressable
          style={styles.headerTitleRow}
          onPress={openConnect}
          accessibilityRole="button"
          accessibilityLabel="Figma connections"
          testID="sidebar-figma-connections"
        >
          <Text style={styles.headerTitle}>Figma</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.sectionLabel}>Connections</Text>
        {list.length === 0 && !connections.isLoading ? (
          <Text style={styles.empty}>No connection yet</Text>
        ) : null}
        {list.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            selected={connection.id === selected?.id}
            go={go}
          />
        ))}

        {selected && selected.authState === "connected" ? (
          <ConnectedTree
            serverId={serverId}
            connectionId={selected.id}
            fileKey={location.fileKey}
            go={go}
          />
        ) : null}

        {location.fileKey ? (
          <PagesAndLayers
            serverId={serverId}
            fileKey={location.fileKey}
            version={location.version}
            go={go}
          />
        ) : null}

        <Pressable
          style={styles.row}
          onPress={openLink}
          accessibilityRole="button"
          testID="figma-nav-link"
        >
          <ThemedExternalMuted size={13} />
          <Text style={styles.rowLabel}>Figma Link…</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const row = (theme: Theme) =>
  ({
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  }) as const;

const dot = (theme: Theme) =>
  ({ width: 8, height: 8, borderRadius: theme.borderRadius.full }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  back: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: theme.spacing[3] },
  sectionLabel: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  groupLabel: {
    paddingHorizontal: theme.spacing[3] + theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  row: row(theme),
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowActive: {
    ...row(theme),
    backgroundColor: theme.colors.surfaceSidebarHover ?? theme.colors.surface2,
  },
  indent1: { paddingLeft: theme.spacing[3] + theme.spacing[2] },
  indent2: { paddingLeft: theme.spacing[3] + theme.spacing[6] },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { flexShrink: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowLabelActive: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  rowSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  pinButton: { paddingHorizontal: theme.spacing[1] },
  pinText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  addRow: row(theme),
  addRowLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  addForm: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface0,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    paddingVertical: 0,
  },
  empty: {
    paddingHorizontal: theme.spacing[3] + theme.spacing[6],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  emptyError: {
    paddingHorizontal: theme.spacing[3] + theme.spacing[6],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[500],
  },
  advancedRow: row(theme),
  advancedLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  dotGreen: { ...dot(theme), backgroundColor: theme.colors.palette.green[500] },
  dotYellow: { ...dot(theme), backgroundColor: theme.colors.palette.amber[500] },
  dotRed: { ...dot(theme), backgroundColor: theme.colors.palette.red[500] },
}));
