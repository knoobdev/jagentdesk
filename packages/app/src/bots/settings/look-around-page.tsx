// Settings › Schedule › Look around (spec 37.4.8 item 3, 37.2.6). Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/settings/bots/BotLookAroundSection.tsx:1-225.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { botLookAround } from "@jagentdesk/protocol/bots/rules";
import type { Bot, LookAroundEvery } from "@jagentdesk/protocol/bots/types";
import type { BotUpNextState } from "@jagentdesk/protocol/bots/views";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { botErrorCode, botErrorMessage, useBotsMutation, useBotsRead } from "@/bots/queries";
import { useProviderLabel } from "./agent-group";
import { BotSettingsGroup, BotSettingsRow } from "./rows";
import {
  LOOK_AROUND_EVERY_CHOICES,
  lookAroundEveryLabel,
  lookAroundLine,
  runMinutes,
  runStamp,
  type Translate,
} from "./row-states";

const FOCUS_MAX = 500;

/** "Nov 14, 12:04 PM · took 3 min · 4 suggestions", or when the first look comes. */
function lastLookedText(state: BotUpNextState | undefined, count: number, t: Translate): string {
  if (!state?.lastLookedAt_ms) {
    return state?.nextAt_ms
      ? t("bots.settingsBots.lookAround.firstLook", { time: runStamp(state.nextAt_ms) })
      : t("bots.settingsBots.lookAround.notArmed");
  }
  return [
    runStamp(state.lastLookedAt_ms),
    t("bots.settingsBots.lookAround.took", { value: runMinutes(state.tookMs ?? 0) }),
    t("bots.settingsBots.lookAround.suggestions", { value: count }),
  ].join(" · ");
}

export function LookAroundPage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const setting = botLookAround(bot);
  const agent = useProviderLabel(serverId, bot.provider);
  const upNext = useBotsRead(serverId, "bots.suggestions.list.request", { botId: bot.id });
  const update = useBotsMutation(serverId, "bots.update.request");
  const lookNow = useBotsMutation(serverId, "bots.look_around.run_now.request");
  const [focus, setFocus] = useState(setting.focus);
  const [savedFocus, setSavedFocus] = useState(setting.focus);
  useEffect(() => {
    // Changed elsewhere (the bot, asked in chat): follow it unless the owner is typing.
    if (setting.focus === savedFocus) return;
    setSavedFocus(setting.focus);
    setFocus((current) => (current.trim() === savedFocus ? setting.focus : current));
  }, [setting.focus, savedFocus]);
  const report = useCallback((error: unknown) => toast?.error(botErrorMessage(error)), [toast]);
  // Only the changed field, so quick edits and the bot's own chat edits never undo each other.
  const change = useCallback(
    (next: { on?: boolean; every?: LookAroundEvery; weekdaysOnly?: boolean; focus?: string }) =>
      update.mutate({ botId: bot.id, patch: { lookAround: next } }, { onError: report }),
    [bot.id, report, update],
  );
  const saveFocus = useCallback(() => {
    const typed = focus.trim();
    if (typed !== setting.focus) change({ focus: typed });
  }, [change, focus, setting.focus]);
  const options = useMemo(
    () =>
      LOOK_AROUND_EVERY_CHOICES.map((choice) => ({
        id: choice,
        value: choice,
        label: lookAroundEveryLabel(choice, t),
      })),
    [t],
  );
  const everyDisplay = useMemo(
    () => ({ label: lookAroundEveryLabel(setting.every, t) }),
    [setting.every, t],
  );
  const selectEvery = useCallback(
    (value: LookAroundEvery, _display: SelectFieldDisplay) => change({ every: value }),
    [change],
  );
  const toggle = useCallback(() => change({ on: !setting.on }), [change, setting.on]);
  const toggleWeekdays = useCallback(
    () => change({ weekdaysOnly: !setting.weekdaysOnly }),
    [change, setting.weekdaysOnly],
  );
  const state = upNext.data?.state;
  const look = useCallback(() => {
    lookNow.mutate(
      { botId: bot.id },
      {
        onError: (error) => {
          const code = botErrorCode(error);
          if (code === "already_running") toast?.show(t("bots.upNext.lookNowRunning"));
          else if (code === "paused") toast?.show(t("bots.upNext.lookNowPaused"));
          else toast?.error(t("bots.upNext.lookNowFailed"));
        },
      },
    );
  }, [bot.id, lookNow, t, toast]);
  const running = state?.running === true || lookNow.isPending;
  const title = t("bots.settingsBots.lookAround.title");
  return (
    <View style={styles.page} testID="bot-settings-look-around">
      <BotSettingsGroup>
        <BotSettingsRow title={title} detail={lookAroundLine(setting, state?.lastLookedAt_ms, t)}>
          <Switch value={setting.on} onValueChange={toggle} accessibilityLabel={title} />
        </BotSettingsRow>
      </BotSettingsGroup>
      {setting.on ? null : (
        <Text style={styles.note}>{t("bots.settingsBots.lookAround.onDescription")}</Text>
      )}
      {setting.on ? (
        <>
          <BotSettingsGroup foot={t("bots.settingsBots.lookAround.everyDescription", { agent })}>
            <View style={styles.block}>
              <Text style={styles.label}>{t("bots.settingsBots.lookAround.every")}</Text>
              <SelectField
                label={t("bots.settingsBots.lookAround.every")}
                field={false}
                value={setting.every}
                selectedDisplay={everyDisplay}
                options={options}
                onChange={selectEvery}
                placeholder={everyDisplay.label}
                emptyText=""
                size="sm"
              />
            </View>
            <BotSettingsRow title={t("bots.settingsBots.lookAround.weekdaysOnly")}>
              <Switch
                value={setting.weekdaysOnly}
                onValueChange={toggleWeekdays}
                accessibilityLabel={t("bots.settingsBots.lookAround.weekdaysOnly")}
              />
            </BotSettingsRow>
          </BotSettingsGroup>
          <BotSettingsGroup foot={t("bots.settingsBots.lookAround.focusDescription")}>
            <View style={styles.block}>
              <Text style={styles.label}>{t("bots.settingsBots.lookAround.focus")}</Text>
              <FormTextInput
                value={focus}
                initialValue={setting.focus}
                webControlled
                onChangeText={setFocus}
                onBlur={saveFocus}
                onSubmitEditing={saveFocus}
                maxLength={FOCUS_MAX}
                placeholder={t("bots.settingsBots.lookAround.focusPlaceholder")}
                accessibilityLabel={t("bots.settingsBots.lookAround.focus")}
                size="sm"
                testID="bot-settings-look-for"
              />
            </View>
          </BotSettingsGroup>
          <BotSettingsGroup>
            <BotSettingsRow
              title={t("bots.settingsBots.lookAround.lastLooked")}
              detail={[
                lastLookedText(state, upNext.data?.suggestions.length ?? 0, t),
                state?.turnedOff ?? state?.error ?? null,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <Button
                size="xs"
                variant="outline"
                disabled={running || bot.paused}
                onPress={look}
                testID="bot-settings-look-now"
              >
                {running ? t("bots.settingsBots.lookAround.looking") : t("bots.upNext.lookNow")}
              </Button>
            </BotSettingsRow>
          </BotSettingsGroup>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { gap: theme.spacing[3] },
  note: {
    paddingHorizontal: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  block: { gap: theme.spacing[1.5], paddingVertical: 10, paddingHorizontal: theme.spacing[3] },
  label: { fontSize: theme.fontSize.sm, fontWeight: "500", color: theme.colors.foreground },
}));
