import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { MutableDaemonConfigPatch, ProviderModelRef } from "@jagentdesk/protocol/messages";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ProviderModelListEditor } from "./provider-model-list-editor";

const DISABLED_FAILOVER = { enabled: false, order: [] };
const DISABLED_CHILDREN = { enabled: false, allowed: [] };

interface ListSetting {
  enabled: boolean;
  entries: ProviderModelRef[];
}

function ContinuityListCard({
  serverId,
  title,
  hint,
  value,
  toPatch,
  reorderable,
  testID,
}: {
  serverId: string;
  title: string;
  hint: string;
  value: ListSetting;
  toPatch: (next: ListSetting) => MutableDaemonConfigPatch;
  reorderable: boolean;
  testID: string;
}) {
  const { t } = useTranslation();
  const { patchConfig } = useDaemonConfig(serverId);
  const mutation = useMutation({
    mutationFn: async (next: ListSetting) => {
      const result = await patchConfig(toPatch(next));
      if (!result) throw new Error(t("workspace.terminal.hostDisconnected"));
      return result;
    },
  });
  const handleToggle = useCallback(
    (enabled: boolean) => mutation.mutate({ ...value, enabled }),
    [mutation, value],
  );
  const handleEntries = useCallback(
    (entries: ProviderModelRef[]) => mutation.mutate({ ...value, entries }),
    [mutation, value],
  );
  return (
    <View style={settingsStyles.card} testID={testID}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{title}</Text>
          <Text style={settingsStyles.rowHint}>{hint}</Text>
          {mutation.error ? (
            <Text style={settingsStyles.rowError}>{mutation.error.message}</Text>
          ) : null}
        </View>
        <Switch
          value={value.enabled}
          onValueChange={handleToggle}
          disabled={mutation.isPending}
          accessibilityLabel={title}
          testID={`${testID}-switch`}
        />
      </View>
      <View style={styles.editor}>
        <ProviderModelListEditor
          serverId={serverId}
          value={value.entries}
          onChange={handleEntries}
          disabled={mutation.isPending}
          reorderable={reorderable}
          testIDPrefix={testID}
        />
      </View>
    </View>
  );
}

/** Settings → host → Agents: failover and child agents on other providers (spec 40 §4–§6). */
export function ContinuitySettingsCards({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const isSupported = useHostFeature(serverId, "crossProviderContinuity");
  const { config } = useDaemonConfig(serverId);
  const failover = config?.agentFailover ?? DISABLED_FAILOVER;
  const children = config?.crossProviderChildren ?? DISABLED_CHILDREN;
  const failoverPatch = useCallback(
    (next: ListSetting): MutableDaemonConfigPatch => ({
      agentFailover: { enabled: next.enabled, order: next.entries },
    }),
    [],
  );
  const childrenPatch = useCallback(
    (next: ListSetting): MutableDaemonConfigPatch => ({
      crossProviderChildren: { enabled: next.enabled, allowed: next.entries },
    }),
    [],
  );
  const failoverValue = useMemo(
    () => ({ enabled: failover.enabled, entries: failover.order }),
    [failover.enabled, failover.order],
  );
  const childrenValue = useMemo(
    () => ({ enabled: children.enabled, entries: children.allowed }),
    [children.enabled, children.allowed],
  );
  if (!isConnected || !isSupported || !config) return null;
  return (
    <>
      <ContinuityListCard
        serverId={serverId}
        title={t("continuity.settings.failoverTitle")}
        hint={t("continuity.settings.failoverHint")}
        value={failoverValue}
        toPatch={failoverPatch}
        reorderable
        testID="host-page-failover-card"
      />
      <ContinuityListCard
        serverId={serverId}
        title={t("continuity.settings.childrenTitle")}
        hint={t("continuity.settings.childrenHint")}
        value={childrenValue}
        toPatch={childrenPatch}
        reorderable={false}
        testID="host-page-child-providers-card"
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  editor: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
}));
