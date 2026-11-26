import { useCallback, useMemo } from "react";
import { useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { BotSchedule } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/form-field";
import { Alert } from "@/components/ui/alert";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useBotSchedules, useBotsMutation } from "./queries";
import { styles } from "./styles";
import { ScheduleFormModel } from "./schedule-model";
import { Input, QueryNotice, ErrorNotice } from "./ui";
import { Hint } from "./help";
function ScheduleSheet({
  serverId,
  botId,
  schedule,
  onClose,
}: {
  serverId: string;
  botId: string;
  schedule: BotSchedule | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [model] = useState(() => new ScheduleFormModel(schedule));
  const draft = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [invalid, setInvalid] = useState(false);
  const save = useBotsMutation(serverId, "bots.schedules.save.request");
  const header = useMemo(
    () => ({ title: t(schedule ? "bots.editSchedule" : "bots.newSchedule") }),
    [t, schedule],
  );
  const submit = useCallback(
    function submit() {
      const input = model.input();
      setInvalid(!input);
      if (input)
        save.mutate({ botId, scheduleId: schedule?.id, schedule: input }, { onSuccess: onClose });
    },
    [model, setInvalid, save, botId, schedule, onClose],
  );
  const setName = useCallback(
    function setName(value: string) {
      model.set("name", value);
    },
    [model],
  );
  const setCron = useCallback(
    function setCron(value: string) {
      model.set("cron", value);
    },
    [model],
  );
  const setTimezone = useCallback(
    function setTimezone(value: string) {
      model.set("timezone", value);
    },
    [model],
  );
  const setPrompt = useCallback(
    function setPrompt(value: string) {
      model.set("prompt", value);
    },
    [model],
  );
  const setEnabled = useCallback(
    function setEnabled(value: boolean) {
      model.set("enabled", value);
    },
    [model],
  );
  return (
    <AdaptiveModalSheet visible onClose={onClose} onDismiss={onClose} header={header}>
      <ScrollView contentContainerStyle={styles.body}>
        <Input
          label={t("bots.name")}
          value={draft.name}
          onChange={setName}
          testID="bot-schedule-name"
        />
        <Input
          label={t("bots.cron")}
          value={draft.cron}
          onChange={setCron}
          testID="bot-schedule-cron"
        />
        <Input label={t("bots.timezone")} value={draft.timezone ?? ""} onChange={setTimezone} />
        <Input
          label={t("bots.prompt")}
          value={draft.prompt}
          onChange={setPrompt}
          multiline
          testID="bot-schedule-prompt"
        />
        <Field label={t("bots.enabled")}>
          <Switch
            value={draft.enabled}
            onValueChange={setEnabled}
            accessibilityLabel={t("bots.enabled")}
          />
        </Field>
        {invalid ? <Alert variant="error" title={t("bots.scheduleValidation")} /> : null}
        <ErrorNotice error={save.error} />
        <Button
          onPress={submit}
          disabled={save.isPending}
          loading={save.isPending}
          testID="bot-schedule-save"
        >
          {t("bots.save")}
        </Button>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}
function ScheduleRow({
  serverId,
  botId,
  schedule,
  edit,
}: {
  serverId: string;
  botId: string;
  schedule: BotSchedule;
  edit: (schedule: BotSchedule) => void;
}) {
  const { t } = useTranslation();
  const remove = useBotsMutation(serverId, "bots.schedules.delete.request");
  const open = useCallback(
    function open() {
      edit(schedule);
    },
    [edit, schedule],
  );
  const deleteSchedule = useCallback(
    async function deleteSchedule() {
      if (
        await confirmDialog({
          title: t("bots.deleteSchedule"),
          message: schedule.name,
          destructive: true,
        })
      )
        remove.mutate({ botId, scheduleId: schedule.id });
    },
    [t, schedule, remove, botId],
  );
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{schedule.name}</Text>
      <Text style={styles.muted}>
        {schedule.cron} · {schedule.timezone ?? "UTC"} ·{" "}
        {t(schedule.enabled ? "bots.enabled" : "bots.paused")}
      </Text>
      <Text style={styles.text}>{schedule.prompt}</Text>
      <Text style={styles.muted}>
        {t("bots.nextRun", { time: new Date(schedule.nextRunAt_ms).toLocaleString() })}
      </Text>
      <View style={styles.row}>
        <Button size="sm" variant="outline" onPress={open}>
          {t("bots.editSchedule")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={remove.isPending}
          loading={remove.isPending}
          onPress={deleteSchedule}
        >
          {t("bots.delete")}
        </Button>
      </View>
      <ErrorNotice error={remove.error} />
    </View>
  );
}
export function BotSchedules({ serverId, botId }: { serverId: string; botId: string }) {
  const { t } = useTranslation();
  const schedules = useBotSchedules(serverId, botId);
  const [editing, setEditing] = useState<{
    schedule: BotSchedule | null;
  } | null>(null);
  const create = useCallback(
    function create() {
      setEditing({ schedule: null });
    },
    [setEditing],
  );
  const edit = useCallback(
    function edit(schedule: BotSchedule) {
      setEditing({ schedule });
    },
    [setEditing],
  );
  const close = useCallback(
    function close() {
      setEditing(null);
    },
    [setEditing],
  );
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Button onPress={create} testID="bot-new-schedule">
        {t("bots.newSchedule")}
      </Button>
      <QueryNotice query={schedules} />
      {schedules.isSuccess && !schedules.data.length ? (
        <Hint testID="bot-schedules-empty">{t("bots.help.schedules")}</Hint>
      ) : null}
      {schedules.data?.map((schedule) => (
        <ScheduleRow
          key={schedule.id}
          serverId={serverId}
          botId={botId}
          schedule={schedule}
          edit={edit}
        />
      ))}
      {editing ? (
        <ScheduleSheet
          key={editing.schedule?.id ?? "new"}
          serverId={serverId}
          botId={botId}
          schedule={editing.schedule}
          onClose={close}
        />
      ) : null}
    </ScrollView>
  );
}
