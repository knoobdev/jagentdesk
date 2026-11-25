import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  builtinPluginCascade,
  type BuiltinPluginId,
  type BuiltinPluginListItem,
} from "@jagentdesk/protocol/builtin-plugins";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/screens/settings/settings-section";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useBuiltinPlugins } from "./hooks";

const EMPTY_PLUGINS: BuiltinPluginListItem[] = [];

function BuiltinPluginRow({
  plugin,
  plugins,
  pending,
  disabled,
  onToggle,
}: {
  plugin: BuiltinPluginListItem;
  plugins: BuiltinPluginListItem[];
  pending: boolean;
  disabled: boolean;
  onToggle(plugin: BuiltinPluginListItem, enabled: boolean): Promise<void>;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(
    (enabled: boolean) => {
      void onToggle(plugin, enabled);
    },
    [onToggle, plugin],
  );
  const hint = useMemo(() => {
    const names = plugin.requires
      .map((id) => plugins.find((entry) => entry.id === id)?.name ?? id)
      .join(", ");
    return [
      plugin.description,
      names ? t("builtinPlugins.requires", { names }) : null,
      plugin.unavailableReason,
    ]
      .filter(Boolean)
      .join("\n");
  }, [plugin, plugins, t]);
  const pendingBadge = useMemo(
    () =>
      pending ? (
        <StatusBadge label={t("builtinPlugins.updating")} variant="muted" />
      ) : (
        unavailableBadge(plugin.available, t("builtinPlugins.unavailable"))
      ),
    [pending, plugin.available, t],
  );
  return (
    <SettingsRow
      label={plugin.name}
      hint={hint}
      labelAccessory={pendingBadge}
      testID={`builtin-plugin-${plugin.id}`}
    >
      <Switch
        value={plugin.enabled && plugin.available}
        onValueChange={toggle}
        disabled={disabled || !plugin.available}
        accessibilityLabel={plugin.name}
      />
    </SettingsRow>
  );
}

export function BuiltinPluginsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const state = useBuiltinPlugins(serverId);
  const [pending, setPending] = useState<BuiltinPluginId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plugins = state.data?.plugins ?? EMPTY_PLUGINS;
  const { set, refetch } = state;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const toggle = useCallback(
    async (plugin: BuiltinPluginListItem, enabled: boolean) => {
      setPending(plugin.id);
      setError(null);
      try {
        const related = builtinPluginCascade(plugins, plugin.id, enabled);
        if (related.length) {
          const names = plugins
            .filter((entry) => related.includes(entry.id))
            .map((entry) => entry.name)
            .join(", ");
          const title = t(enabled ? "builtinPlugins.alsoTurnOn" : "builtinPlugins.alsoTurnOff", {
            names,
          });
          if (!(await confirmDialog({ title, message: title, destructive: !enabled }))) return;
        }
        await set(plugin.id, enabled, related.length > 0);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setPending(null);
      }
    },
    [plugins, set, t],
  );
  if (!state.supported) return null;
  return (
    <SettingsSection title={t("builtinPlugins.title")}>
      {state.isLoading ? <Alert title={t("builtinPlugins.loading")} /> : null}
      {state.isError ? (
        <Alert variant="error" title={state.error.message}>
          <Button variant="outline" size="sm" onPress={retry}>
            {t("builtinPlugins.retry")}
          </Button>
        </Alert>
      ) : null}
      {error ? <Alert variant="error" title={error} testID="builtin-plugin-error" /> : null}
      <SettingsCard>
        {plugins.map((plugin) => (
          <BuiltinPluginRow
            key={plugin.id}
            plugin={plugin}
            plugins={plugins}
            pending={pending === plugin.id}
            disabled={!state.connected || !state.data?.canManage || pending !== null}
            onToggle={toggle}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function unavailableBadge(available: boolean, label: string) {
  return available ? undefined : <StatusBadge label={label} variant="muted" />;
}
