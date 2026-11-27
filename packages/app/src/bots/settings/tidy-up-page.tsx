// Settings › Schedule › Memory upkeep (spec 37.4.8 item 3, 37.2.6): the nightly tidy-up, its last
// run with Review and "Undo tidy-up", and Tidy now. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/settings/bots/BotTidyUpSection.tsx:1-182 and
// src/renderer/src/components/bots/BotTidyUpReview.tsx:1-160.
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Bot, TidyUpEvery } from "@jagentdesk/protocol/bots/types";
import type { BotTidyUpSummary } from "@jagentdesk/protocol/bots/views";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { botErrorCode, botErrorMessage, useBotsMutation, useBotsRead } from "@/bots/queries";
import { useProviderLabel } from "./agent-group";
import { BotSettingsGroup, BotSettingsRow } from "./rows";
import {
  runMinutes,
  runStamp,
  TIDY_UP_EVERY_CHOICES,
  tidyUpEveryLabel,
  tidyUpLine,
  type Translate,
} from "./row-states";

/** "Nov 14, 3:12 AM · took 2 min". */
export function tidyUpRunMeta(run: BotTidyUpSummary, t: Translate): string {
  return [
    runStamp(run.at_ms),
    t("bots.settingsBots.tidyUp.took", { value: runMinutes(run.tookMs) }),
  ].join(" · ");
}

/** Each tidying change, as one line. */
export function tidiedLines(run: BotTidyUpSummary, t: Translate): string[] {
  return [
    ...(run.merged > 0 ? [t("bots.settingsBots.tidyUp.merged", { count: run.merged })] : []),
    ...run.replaced.map((fact) => t("bots.settingsBots.tidyUp.replaced", { fact })),
    ...run.filed.map(({ topic, count }) => t("bots.settingsBots.tidyUp.filed", { count, topic })),
    ...(run.moved > 0 ? [t("bots.settingsBots.tidyUp.moved", { count: run.moved })] : []),
  ];
}

export function TidyUpPage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const agent = useProviderLabel(serverId, bot.provider);
  const status = useBotsRead(
    serverId,
    "bots.tidy_up.status.request",
    { botId: bot.id },
    { select: (payload) => payload.tidyUp },
  );
  const update = useBotsMutation(serverId, "bots.update.request");
  const [reviewing, setReviewing] = useState(false);
  const view = status.data;
  const setting = view?.setting ?? bot.tidyUp ?? { on: true, every: "night" as const };
  const last = view?.last;
  const report = useCallback((error: unknown) => toast?.error(botErrorMessage(error)), [toast]);
  const change = useCallback(
    (next: { on?: boolean; every?: TidyUpEvery }) =>
      update.mutate({ botId: bot.id, patch: { tidyUp: next } }, { onError: report }),
    [bot.id, report, update],
  );
  const toggle = useCallback(() => change({ on: !setting.on }), [change, setting.on]);
  const options = useMemo(
    () =>
      TIDY_UP_EVERY_CHOICES.map((choice) => ({
        id: choice,
        value: choice,
        label: tidyUpEveryLabel(choice, t),
      })),
    [t],
  );
  const everyDisplay = useMemo(
    () => ({ label: tidyUpEveryLabel(setting.every, t) }),
    [setting.every, t],
  );
  const selectEvery = useCallback(
    (value: TidyUpEvery, _display: SelectFieldDisplay) => change({ every: value }),
    [change],
  );
  const { runNow, undoRun, running, undoing } = useTidyUpActions(
    serverId,
    bot,
    last,
    view?.running === true,
  );
  const openReview = useCallback(() => setReviewing(true), []);
  const closeReview = useCallback(() => setReviewing(false), []);
  const title = t("bots.settingsBots.tidyUp.title");
  return (
    <View style={styles.page} testID="bot-settings-tidy-up">
      <BotSettingsGroup>
        <BotSettingsRow title={title} detail={tidyUpLine(setting, last?.at_ms, t)}>
          <Switch value={setting.on} onValueChange={toggle} accessibilityLabel={title} />
        </BotSettingsRow>
      </BotSettingsGroup>
      {view?.turnedOff || !setting.on ? (
        <Text style={styles.note}>
          {view?.turnedOff
            ? t("bots.settingsBots.tidyUp.turnedOff", { error: view.turnedOff })
            : t("bots.settingsBots.tidyUp.onDescription")}
        </Text>
      ) : null}
      {setting.on ? (
        <>
          <BotSettingsGroup foot={t("bots.settingsBots.tidyUp.everyDescriptionAwake", { agent })}>
            <View style={styles.block}>
              <Text style={styles.label}>{t("bots.settingsBots.tidyUp.every")}</Text>
              <SelectField
                label={t("bots.settingsBots.tidyUp.every")}
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
          </BotSettingsGroup>
          <LastTidied
            last={last}
            error={view?.turnedOff ? undefined : view?.error}
            running={running}
            paused={bot.paused}
            onReview={openReview}
            onTidyNow={runNow}
          />
        </>
      ) : null}
      {last && reviewing ? (
        <TidyUpReview run={last} onClose={closeReview} onUndo={undoRun} undoing={undoing} />
      ) : null}
    </View>
  );
}

function useTidyUpActions(
  serverId: string,
  bot: Bot,
  last: BotTidyUpSummary | undefined,
  runningOnHost: boolean,
) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const tidyNow = useBotsMutation(serverId, "bots.tidy_up.run_now.request");
  const undo = useBotsMutation(serverId, "bots.tidy_up.undo.request");
  const runNow = useCallback(() => {
    tidyNow.mutate(
      { botId: bot.id },
      {
        onError: (error) => {
          const code = botErrorCode(error);
          if (code === "already_running") toast?.show(t("bots.settingsBots.tidyUp.nowRunning"));
          else if (code === "paused") toast?.show(t("bots.settingsBots.tidyUp.nowPaused"));
          else toast?.error(t("bots.settingsBots.tidyUp.nowFailed"));
        },
      },
    );
  }, [bot.id, t, tidyNow, toast]);
  const undoRun = useCallback(() => {
    if (!last) return;
    undo.mutate(
      { botId: bot.id, runId: last.runId },
      {
        onSuccess: (result) => {
          if (!result.undone) toast?.show(t("bots.settingsBots.tidyUp.undoSuperseded"));
        },
        onError: (error) =>
          toast?.error(
            botErrorCode(error) === "superseded"
              ? t("bots.settingsBots.tidyUp.undoSuperseded")
              : t("bots.settingsBots.tidyUp.undoFailed"),
          ),
      },
    );
  }, [bot.id, last, t, toast, undo]);
  return {
    runNow,
    undoRun,
    running: runningOnHost || tidyNow.isPending,
    undoing: undo.isPending,
  };
}

function LastTidied({
  last,
  error,
  running,
  paused,
  onReview,
  onTidyNow,
}: {
  last: BotTidyUpSummary | undefined;
  error: string | undefined;
  running: boolean;
  paused: boolean;
  onReview: () => void;
  onTidyNow: () => void;
}) {
  const { t } = useTranslation();
  const lastDetail = last
    ? `${tidyUpRunMeta(last, t)} · ${t("bots.settingsBots.tidyUp.changes", { count: last.changes })}`
    : t("bots.settingsBots.tidyUp.never");
  return (
    <BotSettingsGroup>
      <BotSettingsRow
        title={t("bots.settingsBots.tidyUp.lastTidied")}
        detail={error ? `${lastDetail}\n${error}` : lastDetail}
      >
        <View style={styles.actions}>
          {last ? (
            <Button size="xs" variant="ghost" onPress={onReview} testID="bot-settings-tidy-review">
              {t("bots.settingsBots.tidyUp.review")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={running || paused}
            onPress={onTidyNow}
            testID="bot-settings-tidy-now"
          >
            {running ? t("bots.settingsBots.tidyUp.tidying") : t("bots.settingsBots.tidyUp.now")}
          </Button>
        </View>
      </BotSettingsRow>
    </BotSettingsGroup>
  );
}

function ReviewGroup({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <View style={styles.reviewGroup}>
      <Text style={styles.reviewTitle}>{title}</Text>
      {lines.map((line) => (
        <Text key={line} style={styles.reviewLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** "Last night's tidy-up": what it changed, with Undo for the whole run. */
function TidyUpReview({
  run,
  onClose,
  onUndo,
  undoing,
}: {
  run: BotTidyUpSummary;
  onClose: () => void;
  onUndo: () => void;
  undoing: boolean;
}) {
  const { t } = useTranslation();
  // A nightly run reads as last night's; one from Tidy now during the day doesn't.
  const title =
    new Date(run.at_ms).getHours() < 9
      ? t("bots.settingsBots.tidyUp.reviewTitleNight")
      : t("bots.settingsBots.tidyUp.reviewTitle");
  const header = useMemo(() => ({ title, subtitle: tidyUpRunMeta(run, t) }), [run, t, title]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          size="sm"
          variant="ghost"
          disabled={run.undone || !run.rowId || undoing}
          onPress={onUndo}
          testID="bot-tidy-undo"
        >
          {t("bots.settingsBots.tidyUp.undoAll")}
        </Button>
        <Button size="sm" variant="default" onPress={onClose}>
          {t("bots.settingsBots.tidyUp.done")}
        </Button>
      </View>
    ),
    [onClose, onUndo, run.rowId, run.undone, t, undoing],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={520}
    >
      <View style={styles.review} testID="bot-tidy-review">
        <ReviewGroup title={t("bots.settingsBots.tidyUp.learned")} lines={run.learned} />
        <ReviewGroup title={t("bots.settingsBots.tidyUp.tidied")} lines={tidiedLines(run, t)} />
        <Text style={styles.note}>
          {run.undone
            ? t("bots.settingsBots.tidyUp.undone")
            : t("bots.settingsBots.tidyUp.undoNote")}
        </Text>
      </View>
    </AdaptiveModalSheet>
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
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  review: { gap: theme.spacing[4] },
  reviewGroup: { gap: theme.spacing[1.5] },
  reviewTitle: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  reviewLine: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  footer: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
}));
