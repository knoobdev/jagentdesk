import { builtinClientRegistry } from "../builtin/loaded";
import { useBuiltinClientContributions } from "../builtin/surfaces";
import type { PluginTimelineItemProps } from "@jagentdesk/plugin/client";
import type { PluginTheme } from "@jagentdesk/plugin";
import React, { type ComponentType, useMemo } from "react";
import { Platform, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { PluginTimelineStreamItem } from "@/types/stream";
import { createPluginClientStateSource } from "../client-state/source";
import { useInstalledPlugin } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { useTranslation } from "react-i18next";

function resolvePluginPlatform(): "ios" | "android" | "web" {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

function TimelineItemUnavailable() {
  const { t } = useTranslation();
  return <Text style={styles.unavailable}>{t("settings.plugins.timelineUnavailable")}</Text>;
}

function parseRendererData(
  renderer:
    | { schema: { safeParse(value: unknown): { success: boolean; data?: unknown } } }
    | undefined,
  data: unknown,
) {
  if (!renderer) return null;
  try {
    const parsed = renderer.schema.safeParse(data);
    return parsed.success ? parsed : null;
  } catch (error) {
    console.warn("[Plugins] Timeline renderer schema failed", error);
    return null;
  }
}

function PluginTimelineItemBody({
  agentId,
  item,
  serverId,
  theme,
}: {
  agentId: string;
  item: PluginTimelineStreamItem;
  serverId: string;
  theme: PluginTheme;
}) {
  const plugin = useInstalledPlugin(serverId, item.pluginId);
  const renderer = plugin?.timelineRenderers.find(
    (candidate) => candidate.kind === item.itemKind && candidate.version === item.version,
  );
  const parsed = parseRendererData(renderer, item.data);
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const layout = useMemo(
    () => ({
      compact,
      platform: resolvePluginPlatform(),
    }),
    [compact],
  );
  const stateSource = useMemo(() => createPluginClientStateSource(serverId), [serverId]);

  if (!plugin || !renderer || !parsed || !client) {
    return <TimelineItemUnavailable />;
  }

  const Component = renderer.Component as ComponentType<PluginTimelineItemProps>;
  const props: PluginTimelineItemProps = {
    agentId,
    theme,
    host,
    layout,
    timestamp: item.timestamp,
    item: {
      type: "plugin",
      kind: item.itemKind,
      version: item.version,
      data: parsed.data,
    },
  };
  return (
    <SurfaceErrorBoundary installation={plugin} resetKey={item.data} Surface={Component}>
      <PluginRuntimeBoundary plugin={plugin} client={client} stateSource={stateSource}>
        <Component {...props} />
      </PluginRuntimeBoundary>
    </SurfaceErrorBoundary>
  );
}

const ThemedPluginTimelineItemBody = withUnistyles(PluginTimelineItemBody);

export function PluginTimelineItemView(props: {
  agentId: string;
  item: PluginTimelineStreamItem;
  serverId: string;
}) {
  const entries = useBuiltinClientContributions(props.serverId);
  const item = useMemo(
    () => ({
      type: "plugin" as const,
      kind: props.item.itemKind,
      version: props.item.version,
      data: props.item.data,
    }),
    [props.item],
  );
  const Renderer = [...entries]
    .find(([id]) => id === props.item.pluginId)?.[1]
    .timeline.get(props.item.itemKind);
  if (Renderer) return <Renderer serverId={props.serverId} item={item} />;
  if (builtinClientRegistry.hasPlugin(props.item.pluginId)) return null;
  return <ThemedPluginTimelineItemBody {...props} uniProps={pluginThemeMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  unavailable: {
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[2],
  },
}));
