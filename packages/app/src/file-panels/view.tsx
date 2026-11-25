import { usePluginPanelTab } from "@/plugins/panel-tab";
import type { PluginFilePanelContribution, PluginFilePanelProps } from "@jagentdesk/plugin/client";
import { useCallback, useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FilePane } from "@/file-pane/pane";
import { useAppSettings } from "@/hooks/use-settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { usePanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useInstalledPlugins } from "@/plugins/registry";
import { PluginRuntimeBoundary } from "@/plugins/runtime-boundary";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { toPluginTheme } from "@/plugins/theme";
import type { InstalledPlugin } from "@/plugins/types";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useFileHandle, useFileHandleSnapshot } from "./file";
import { resolveFilePanel } from "./resolve";

interface FilePanelProps {
  workspaceId?: string | null;
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}
interface Candidate {
  id: string;
  builtin: boolean;
  title: string;
  files: PluginFilePanelContribution["files"] | "all";
  plugin?: InstalledPlugin;
  contribution?: PluginFilePanelContribution;
}
/** The existing CodeMirror editor and previews participate in the same panel selection as plugins. */
export const sourceFilePanel = {
  id: "builtin:source",
  builtin: true,
  title: "Editor",
  files: "all",
  Component: FilePane,
} as const;

export function FilePanelView(props: FilePanelProps) {
  const plugins = useInstalledPlugins();
  const candidates = useMemo<Candidate[]>(
    () => [
      sourceFilePanel,
      ...plugins
        .filter((plugin) => plugin.serverId === props.serverId)
        .flatMap((plugin) =>
          (plugin.filePanels ?? []).map((contribution) => ({
            id: `plugin:${plugin.id}/${contribution.id}`,
            builtin: false,
            title: contribution.title,
            files: contribution.files,
            plugin,
            contribution,
          })),
        ),
    ],
    [plugins, props.serverId],
  );
  return <ResolvedFilePanel {...props} candidates={candidates} />;
}

function ResolvedFilePanel({ candidates, ...props }: FilePanelProps & { candidates: Candidate[] }) {
  const pane = usePaneContext();
  const attributes = usePanelInstanceAttributes(pane);
  const { settings, updateSettings } = useAppSettings();
  const [choice, setChoice] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const target = useMemo(
    () =>
      resolveFilePreviewReadTarget({
        path: props.location.path,
        workspaceRoot: props.workspaceRoot,
      }),
    [props.location.path, props.workspaceRoot],
  );
  const handle = useFileHandle({
    serverId: props.serverId,
    target,
    absolutePath: props.location.path.startsWith("/")
      ? props.location.path
      : `${props.workspaceRoot}/${props.location.path}`,
    observing: true,
  });
  const snapshot = useFileHandleSnapshot(handle);
  const resolution = resolveFilePanel({
    file: { path: props.location.path, kind: snapshot.status === "ready" ? snapshot.kind : "text" },
    candidates,
    associations: settings.filePanelAssociations,
    choice,
  });
  const choose = useCallback(
    async (panelId: string) => {
      if (
        attributes.modified &&
        !(await confirmDialog({
          title: "Discard unsaved changes?",
          message: "Switching file panels discards unsaved changes.",
          destructive: true,
        }))
      )
        return;
      setChoice(panelId);
      setChoosing(false);
      await updateSettings({
        filePanelAssociations: {
          ...settings.filePanelAssociations,
          [resolution.selectorKey]: panelId,
        },
      });
    },
    [attributes.modified, resolution.selectorKey, settings.filePanelAssociations, updateSettings],
  );
  const showPicker = useCallback(() => setChoosing(true), []);
  const selected = resolution.panel;
  const Component = sourceFilePanel.Component;
  return (
    <View style={styles.container} testID="file-panel-host">
      {resolution.candidates.length > 1 ? (
        <View style={styles.toolbar}>
          <Text style={styles.label}>Open with</Text>
          <Button variant="ghost" size="sm" onPress={showPicker} testID="file-panel-picker">
            {selected?.title ?? "Choose a file panel"}
          </Button>
        </View>
      ) : null}
      {choosing || !selected ? (
        <View style={styles.choices}>
          {resolution.candidates.map((candidate) => (
            <PanelChoice key={candidate.id} candidate={candidate} choose={choose} />
          ))}
        </View>
      ) : null}
      {selected?.builtin ? <Component {...props} /> : null}
      {selected?.plugin && selected.contribution && handle ? (
        <PluginFileHost
          key={selected.id}
          plugin={selected.plugin}
          contribution={selected.contribution}
          file={handle.file}
          revision={props.navigationRevision}
          location={props.location}
        />
      ) : null}
    </View>
  );
}
function PanelChoice({
  candidate,
  choose,
}: {
  candidate: Candidate;
  choose(id: string): Promise<void>;
}) {
  const onPress = useCallback(() => {
    void choose(candidate.id);
  }, [choose, candidate.id]);
  return (
    <Button variant="outline" onPress={onPress} testID={`file-panel-choice-${candidate.id}`}>
      {candidate.title}
    </Button>
  );
}
function PluginFileHost({
  plugin,
  contribution,
  file,
  location,
  revision,
}: {
  plugin: InstalledPlugin;
  contribution: PluginFilePanelContribution;
  file: PluginFilePanelProps["file"];
  location: WorkspaceFileLocation;
  revision: number;
}) {
  const client = useHostRuntimeClient(plugin.serverId);
  const { tab } = usePluginPanelTab();
  const pluginLocation = useMemo(
    () => ({ lineStart: location.lineStart, lineEnd: location.lineEnd, revision }),
    [location.lineStart, location.lineEnd, revision],
  );
  const params = useMemo(
    () => ({ path: file.path, lineStart: location.lineStart, lineEnd: location.lineEnd }),
    [file.path, location.lineStart, location.lineEnd],
  );
  if (!client) return <Text style={styles.label}>Plugin host is offline.</Text>;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={contribution.Component}>
      <PluginRuntimeBoundary plugin={plugin} client={client}>
        <ThemedPluginFileContent
          contribution={contribution}
          file={file}
          tab={tab}
          location={pluginLocation}
          revision={revision}
          params={params}
          uniProps={themeMapping}
        />
      </PluginRuntimeBoundary>
    </SurfaceErrorBoundary>
  );
}
function PluginFileContent({
  contribution,
  theme,
  ...props
}: Pick<PluginFilePanelProps, "file" | "tab" | "location" | "theme" | "params" | "revision"> & {
  contribution: PluginFilePanelContribution;
}) {
  const { serverId, workspaceId } = usePaneContext();
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const navigation = usePluginHostNavigation(serverId);
  const host = useMemo(
    () => ({
      id: serverId,
      label: hosts.find((entry) => entry.serverId === serverId)?.label ?? serverId,
    }),
    [hosts, serverId],
  );
  const layout = useMemo(() => ({ compact, platform: resolvePlatform() }), [compact]);
  const Component = contribution.Component;
  return (
    <Component
      {...props}
      theme={theme}
      workspaceId={workspaceId}
      host={host}
      layout={layout}
      navigation={navigation}
    />
  );
}
function resolvePlatform(): "ios" | "android" | "web" {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}
const ThemedPluginFileContent = withUnistyles(PluginFileContent);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  choices: { padding: theme.spacing[3], gap: theme.spacing[2] },
}));
