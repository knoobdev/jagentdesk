import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MemorySettingsWire } from "@jagentdesk/protocol/memory";
import {
  FormTextInput,
  SettingsSection,
  Switch,
  settingsStyles,
  useHostRuntimeClient,
  useToast,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { useMemorySettings } from "./use-memory";

/** Settings → host → Memory (spec 41 §3.4): Memory, auto-inject, and the token limit. */
export function MemorySettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const state = useMemorySettings(serverId);
  const settings = state.status === "ready" ? state.data : null;
  const [tokenCap, setTokenCap] = useState("");
  useEffect(() => {
    if (settings) setTokenCap(String(settings.tokenCap));
  }, [settings]);

  const update = useCallback(
    (patch: Partial<MemorySettingsWire>) => {
      client
        ?.setMemorySettings(patch)
        .catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : String(error)),
        );
    },
    [client, toast],
  );
  const setEnabled = useCallback((enabled: boolean) => update({ enabled }), [update]);
  const setAutoInject = useCallback((autoInject: boolean) => update({ autoInject }), [update]);
  const commitTokenCap = useCallback(() => {
    const value = Number.parseInt(tokenCap, 10);
    if (Number.isFinite(value) && value !== settings?.tokenCap) update({ tokenCap: value });
    else if (settings) setTokenCap(String(settings.tokenCap));
  }, [settings, tokenCap, update]);

  return (
    <SettingsSection title={t("memory.settings.title")} testID="memory-settings">
      <View style={settingsStyles.card}>
        <SettingRow title={t("memory.settings.enabled")} hint={t("memory.settings.enabledHint")}>
          <Switch
            value={settings?.enabled ?? false}
            disabled={!settings}
            onValueChange={setEnabled}
            testID="memory-settings-enabled"
          />
        </SettingRow>
        <SettingRow
          title={t("memory.settings.autoInject")}
          hint={t("memory.settings.autoInjectHint")}
          bordered
        >
          <Switch
            value={settings?.autoInject ?? false}
            disabled={!settings || !settings.enabled}
            onValueChange={setAutoInject}
            testID="memory-settings-auto-inject"
          />
        </SettingRow>
        <SettingRow title={t("memory.settings.tokenCap")} bordered>
          <FormTextInput
            value={tokenCap}
            onChangeText={setTokenCap}
            onBlur={commitTokenCap}
            onSubmitEditing={commitTokenCap}
            keyboardType="number-pad"
            size="sm"
            editable={Boolean(settings?.enabled && settings.autoInject)}
            style={styles.number}
            testID="memory-settings-token-cap"
          />
        </SettingRow>
      </View>
    </SettingsSection>
  );
}

function SettingRow({
  title,
  hint,
  bordered,
  children,
}: {
  title: string;
  hint?: string;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={[settingsStyles.row, bordered ? settingsStyles.rowBorder : null]}>
      <View style={styles.textColumn}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  textColumn: { flex: 1, minWidth: 0, gap: 2 },
  hint: { fontSize: 13, color: theme.colors.foregroundMuted },
  number: { width: 96 },
}));
