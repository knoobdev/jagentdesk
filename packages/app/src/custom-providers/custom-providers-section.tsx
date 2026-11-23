import { useBuiltinPluginEnabled } from "@/plugins/builtin/hooks";
import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronRight, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { settingsStyles } from "@/styles/settings";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useCustomProvidersList, type CustomProvidersLoadState } from "./use-custom-providers-list";
import {
  CustomProviderFormSheet,
  type CustomProviderEditorTarget,
} from "./custom-provider-form-sheet";
import type { SshServerOption } from "./custom-provider-form-model";
import type { ApiProviderRecord, EnvProviderSummary } from "./types";

// "Custom API providers" group on Settings → Providers (spec 34.8): the list of
// daemon-managed providers, the add/edit sheet, and the read-only env-based group.
// Desktop and mobile share this component.

type TestTone = "success" | "danger" | "muted";

function shortenBaseUrl(url: string, max = 36): string {
  const stripped = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (stripped.length <= max) {
    return stripped;
  }
  return `${stripped.slice(0, Math.max(1, max - 1))}…`;
}

function testTone(record: ApiProviderRecord, lastTest: Record<string, boolean>): TestTone {
  const outcome = lastTest[record.id];
  if (outcome === true) return "success";
  if (outcome === false) return "danger";
  return "muted";
}

const ThemedChevronRight = withUnistyles(ChevronRight, (theme) => ({
  size: theme.iconSize.sm,
  color: theme.colors.foregroundMuted,
}));
const ThemedPlus = withUnistyles(Plus, (theme) => ({
  size: 16,
  color: theme.colors.foreground,
}));

function CustomProviderRow({
  record,
  isFirst,
  lastTest,
  onPress,
}: {
  record: ApiProviderRecord;
  isFirst: boolean;
  lastTest: Record<string, boolean>;
  onPress: (record: ApiProviderRecord) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(record), [onPress, record]);
  const rowStyle = useCallback(
    () => [settingsStyles.row, !isFirst && settingsStyles.rowBorder],
    [isFirst],
  );
  const modelCount =
    record.models.length === 1
      ? t("settings.providers.customProviders.models.one")
      : t("settings.providers.customProviders.models.many", { count: record.models.length });
  const subtitle = [
    t(`settings.providers.customProviders.protocol.${record.protocol}`),
    shortenBaseUrl(record.baseUrl),
    t(`settings.providers.customProviders.route.${record.via}`),
  ].join(" · ");
  const dotStyle = {
    success: styles.dotSuccess,
    danger: styles.dotDanger,
    muted: styles.dotMuted,
  }[testTone(record, lastTest)];
  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t("settings.providers.customProviders.openEditor", {
        name: record.label,
      })}
      testID={`custom-provider-row-${record.id}`}
    >
      <View style={styles.rowContent}>
        <View style={styles.textColumn}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {record.label}
          </Text>
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Text style={styles.modelCount}>{modelCount}</Text>
        <View style={dotStyle} />
        <ThemedChevronRight />
      </View>
    </Pressable>
  );
}

function EnvProviderRow({ env, isFirst }: { env: EnvProviderSummary; isFirst: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, !isFirst && settingsStyles.rowBorder]}>
      <View style={styles.textColumn}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {env.label}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {t("settings.providers.customProviders.envExtends", { extends: env.extends })}
        </Text>
      </View>
    </View>
  );
}

function ListStateMessage({ state }: { state: CustomProvidersLoadState }) {
  const { t } = useTranslation();
  if (state.status === "connecting") {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.providers.unavailable")}</Text>
      </View>
    );
  }
  if (state.status === "loading") {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.providers.loading")}</Text>
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.errorText}>{state.message}</Text>
      </View>
    );
  }
  return null;
}

export function CustomProvidersSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const sshEnabled = useBuiltinPluginEnabled(serverId, "ssh-servers");
  const isConnected = useHostRuntimeIsConnected(serverId);
  const daemonClient = useHostRuntimeClient(serverId);
  const { state, refresh } = useCustomProvidersList(daemonClient, isConnected);
  const [editor, setEditor] = useState<CustomProviderEditorTarget | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [sshServers, setSshServers] = useState<readonly SshServerOption[]>([]);
  const [lastTestByProvider, setLastTestByProvider] = useState<Record<string, boolean>>({});

  const openEditor = useCallback(
    async (target: CustomProviderEditorTarget) => {
      setEditorKey((current) => current + 1);
      setEditor(target);
      if (!daemonClient || !sshEnabled) {
        setSshServers([]);
        return;
      }
      try {
        const result = await daemonClient.sshServersList();
        if (!result.error) {
          setSshServers(result.servers.map((server) => ({ id: server.id, label: server.label })));
        }
      } catch {
        // The server picker renders its empty text; the route still works.
      }
    },
    [daemonClient, sshEnabled],
  );

  const openCreateEditor = useCallback(() => {
    void openEditor({ mode: "create", record: null });
  }, [openEditor]);

  const openUpdateEditor = useCallback(
    (record: ApiProviderRecord) => {
      void openEditor({ mode: "update", record });
    },
    [openEditor],
  );

  const handleClose = useCallback(() => setEditor(null), []);

  const handleSaved = useCallback(() => {
    setEditor(null);
    void refresh();
  }, [refresh]);

  const handleTested = useCallback((recordId: string | null, ok: boolean) => {
    if (!recordId) {
      return;
    }
    setLastTestByProvider((current) => ({ ...current, [recordId]: ok }));
  }, []);

  const loaded = state.status === "loaded" ? state : null;

  return (
    <>
      <SettingsSection
        title={t("settings.providers.customProviders.title")}
        testID="host-page-custom-providers-card"
        style={styles.sectionSpacing}
      >
        {loaded ? (
          <View style={settingsStyles.card}>
            {loaded.providers.length === 0 ? (
              <Text style={styles.emptyText}>{t("settings.providers.customProviders.empty")}</Text>
            ) : (
              loaded.providers.map((record, index) => (
                <CustomProviderRow
                  key={record.id}
                  record={record}
                  isFirst={index === 0}
                  lastTest={lastTestByProvider}
                  onPress={openUpdateEditor}
                />
              ))
            )}
            <Pressable
              style={[settingsStyles.row, styles.addRow]}
              onPress={openCreateEditor}
              accessibilityRole="button"
              accessibilityLabel={t("settings.providers.customProviders.add")}
              testID="custom-provider-add"
            >
              <View style={styles.addRowContent}>
                <ThemedPlus />
                <Text style={styles.addRowText}>{t("settings.providers.customProviders.add")}</Text>
              </View>
            </Pressable>
          </View>
        ) : (
          <ListStateMessage state={state} />
        )}
      </SettingsSection>

      {loaded && loaded.envProviders.length > 0 ? (
        <SettingsSection
          title={t("settings.providers.customProviders.envTitle")}
          testID="host-page-env-providers-card"
          style={styles.sectionSpacing}
        >
          <View style={settingsStyles.card}>
            {loaded.envProviders.map((env, index) => (
              <EnvProviderRow key={env.id} env={env} isFirst={index === 0} />
            ))}
          </View>
        </SettingsSection>
      ) : null}

      {editor ? (
        <CustomProviderFormSheet
          key={`${editor.mode}-${editor.record?.id ?? "create"}-${editorKey}`}
          client={daemonClient}
          target={editor}
          sshServers={sshServers}
          sshEnabled={sshEnabled}
          onClose={handleClose}
          onSaved={handleSaved}
          onTested={handleTested}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionSpacing: {
    marginBottom: theme.spacing[4],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  rowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  modelCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  dotSuccess: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.statusSuccess,
  },
  dotDanger: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.statusDanger,
  },
  dotMuted: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
  },
  addRow: {
    minHeight: 48,
  },
  addRowContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  addRowText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
