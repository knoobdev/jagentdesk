// Settings › Plugins › Bots (spec 37.4.12): "Enable bots" turns the host's `bots` built-in plugin on
// or off; "Ask before a new Home Chat" is this device's. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/settings/bots/BotsSettingsPane.tsx:1-59.
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { useBuiltinPlugins } from "@/plugins/builtin/hooks";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useBotsPreferences } from "./preferences-store";

export function BotsAppSettingsSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const plugins = useBuiltinPlugins(serverId);
  const ask = useBotsPreferences((state) => state.askNewHomeChat);
  const setAsk = useBotsPreferences((state) => state.setAskNewHomeChat);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const bots = plugins.data?.plugins.find((plugin) => plugin.id === "bots");
  const { set } = plugins;
  const toggle = useCallback(
    async (enabled: boolean) => {
      setPending(true);
      setError(null);
      try {
        await set("bots", enabled, false);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setPending(false);
      }
    },
    [set],
  );
  if (!plugins.supported || !bots) return null;
  const enabled = bots.enabled && bots.available;
  return (
    <SettingsSection title={t("bots.settingsBots.title")} testID="bots-app-settings">
      {error ? <Alert variant="error" title={error} /> : null}
      <SettingsCard>
        <SettingsRow
          label={t("bots.settingsBots.enable")}
          hint={t("bots.settingsBots.enableDescription")}
        >
          <Switch
            value={enabled}
            onValueChange={toggle}
            disabled={pending || !plugins.connected || !plugins.data?.canManage || !bots.available}
            accessibilityLabel={t("bots.settingsBots.enable")}
            testID="bots-app-settings-enable"
          />
        </SettingsRow>
        {enabled ? (
          <SettingsRow
            label={t("bots.settingsBots.askNewHomeChat")}
            hint={t("bots.settingsBots.askNewHomeChatDescription")}
          >
            <Switch
              value={ask}
              onValueChange={setAsk}
              accessibilityLabel={t("bots.settingsBots.askNewHomeChat")}
              testID="bots-app-settings-ask-new-home-chat"
            />
          </SettingsRow>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
