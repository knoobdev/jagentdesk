// The app's Bots settings (spec 37.4.12), split by p176's settings map (Paseo #10933): "Enable bots"
// turns the host's `bots` built-in plugin on or off and sits in Host › Plugins; "Ask before a new
// Home Chat" is stored on this device and sits in This device › Chat & panes. Ported from Orca
// dfdb4fda (MIT) src/renderer/src/components/settings/bots/BotsSettingsPane.tsx:1-59.
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
      </SettingsCard>
    </SettingsSection>
  );
}

/** This device › Chat & panes › Bots: whether "New Home Chat" asks before it replaces a bot's chat. */
export function BotsDeviceSettingsSection() {
  const { t } = useTranslation();
  const ask = useBotsPreferences((state) => state.askNewHomeChat);
  const setAsk = useBotsPreferences((state) => state.setAskNewHomeChat);
  return (
    <SettingsSection title={t("bots.settingsBots.title")} testID="bots-device-settings">
      <SettingsCard>
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
      </SettingsCard>
    </SettingsSection>
  );
}
