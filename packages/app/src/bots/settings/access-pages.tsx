// Settings › Access pages (spec 37.4.8 item 6): Who can ask (every connector's allowed people,
// `bots.allowed.list`) and Skills (the home's `skills/`). Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/settings-view/BotWhoCanAskPage.tsx:1-117 and
// src/renderer/src/components/settings/bots/BotSkillsSection.tsx (own skills only; linked projects
// and "Tools" are deferred, spec 37.2.2).
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotAllowedPerson } from "@jagentdesk/protocol/bots/views";
import { Button } from "@/components/ui/button";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { botErrorMessage, botsKey, useBotsMutation, useBotsRead } from "@/bots/queries";
import { useBotPanelStore } from "@/bots/panel-store";
import { BotSettingsGroup, BotSettingsRow } from "./rows";

const SOURCE_ORDER: readonly BotAllowedPerson["source"][] = [
  "slack",
  "github",
  "gitlab",
  "telegram",
];
const SOURCE_NAMES: Record<BotAllowedPerson["source"], string> = {
  slack: "Slack",
  github: "GitHub",
  gitlab: "GitLab",
  telegram: "Telegram",
};

export function useAllowedPeople(serverId: string, botId: string) {
  return useBotsRead(
    serverId,
    "bots.allowed.list.request",
    { botId },
    { select: (payload) => payload.people },
  );
}

export function WhoCanAskPage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const people = useAllowedPeople(serverId, bot.id);
  const removeSlack = useBotsMutation(serverId, "bots.slack.allowed.remove.request");
  const groups = useMemo(
    () =>
      SOURCE_ORDER.map((source) => ({
        source,
        people: (people.data ?? []).filter((person) => person.source === source),
      })).filter((group) => group.people.length > 0),
    [people.data],
  );
  const openConnectors = useCallback(
    () => useBotPanelStore.getState().setTab(bot.id, "connectors"),
    [bot.id],
  );
  const remove = useCallback(
    (person: BotAllowedPerson) => {
      if (person.source !== "slack") return;
      removeSlack.mutate(
        { botId: bot.id, userId: person.id },
        { onError: (error) => toast?.error(botErrorMessage(error)) },
      );
    },
    [bot.id, removeSlack, toast],
  );
  if (people.isError) return <Text style={styles.muted}>{botErrorMessage(people.error)}</Text>;
  if (!people.data) return null;
  return (
    <View style={styles.page} testID="bot-settings-who-can-ask">
      <BotSettingsGroup title={t("bots.whoCanAsk.caption")}>
        <BotSettingsRow title={t("bots.whoCanAsk.you")} value={t("bots.whoCanAsk.owner")} />
      </BotSettingsGroup>
      {groups.length === 0 ? (
        <BotSettingsGroup foot={t("bots.jad.settings.whoCanAskEmpty", { name: bot.name })}>
          <BotSettingsRow
            title={t("bots.settingsBots.connectors")}
            onOpen={openConnectors}
            testID="bot-settings-who-can-ask-connectors"
          />
        </BotSettingsGroup>
      ) : null}
      {groups.map((group) => (
        <BotSettingsGroup key={group.source} title={SOURCE_NAMES[group.source]}>
          {group.people.map((person) => (
            <PersonRow
              key={`${person.source}:${person.id}`}
              person={person}
              onRemove={remove}
              removing={removeSlack.isPending}
            />
          ))}
        </BotSettingsGroup>
      ))}
    </View>
  );
}

function PersonRow({
  person,
  onRemove,
  removing,
}: {
  person: BotAllowedPerson;
  onRemove: (person: BotAllowedPerson) => void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(person), [onRemove, person]);
  // GitHub, GitLab and Telegram people are removed through bt4's connector RPCs
  // (bots-hooks-contract.md), which this build's protocol does not carry yet.
  const removable = person.source === "slack";
  return (
    <BotSettingsRow
      title={person.name}
      detail={
        removable
          ? null
          : t("bots.jad.settings.removeInConnector", { connector: SOURCE_NAMES[person.source] })
      }
    >
      {removable ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={removing}
          onPress={remove}
          accessibilityLabel={t("bots.whoCanAsk.removePerson", { name: person.name })}
          testID="bot-settings-remove-person"
        >
          {t("bots.settingsBots.skills.remove")}
        </Button>
      ) : undefined}
    </BotSettingsRow>
  );
}

/** The home's `skills/<name>/` folders; null until read. */
export function useBotOwnSkills(serverId: string, bot: Pick<Bot, "id" | "home">) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "skills", bot.id, bot.home],
    enabled: Boolean(client && connected && bot.home),
    dataShape: "list",
    staleTimeMs: 5000,
    queryFn: async (): Promise<string[]> => {
      if (!client || !bot.home) return [];
      try {
        const directory = await client.listDirectory(bot.home, "skills");
        return directory.entries
          .filter((entry) => entry.kind === "directory")
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b));
      } catch {
        // No skills/ folder yet: the bot has no skills of its own.
        return [];
      }
    },
  });
}

export function SkillsPage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const skills = useBotOwnSkills(serverId, bot);
  return (
    <View style={styles.page} testID="bot-settings-skills">
      <BotSettingsGroup
        title={t("bots.settingsBots.skills.own", { bot: bot.name })}
        aside={
          skills.data ? t("bots.settingsBots.skills.count", { count: skills.data.length }) : null
        }
        foot={bot.home ? `${bot.home}/skills` : undefined}
      >
        {skills.isPending ? (
          <Text style={styles.empty}>{t("bots.settingsBots.skills.reading")}</Text>
        ) : null}
        {skills.data?.length === 0 ? (
          <Text style={styles.empty}>{t("bots.settingsBots.skills.ownNone")}</Text>
        ) : null}
        {skills.data?.map((name) => (
          <BotSettingsRow key={name} title={name} detail={`skills/${name}/SKILL.md`} />
        ))}
      </BotSettingsGroup>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { gap: theme.spacing[3] },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  empty: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
