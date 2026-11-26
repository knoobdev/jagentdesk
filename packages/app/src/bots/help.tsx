import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { CircleHelp } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { NAME_SLOT, helpSegments, howToAskKeys } from "./help-model";
import { useBotSlackStatus } from "./queries";
import { styles } from "./styles";

const ThemedCircleHelp = withUnistyles(CircleHelp);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const helpIcon = <ThemedCircleHelp size={18} uniProps={mutedIconMapping} />;
const STEPS = ["bots.help.step1", "bots.help.step2", "bots.help.step3"] as const;

/** One help sentence: 13 px muted text, wrapping. */
export function Hint({ children, testID }: { children: string; testID?: string }) {
  return (
    <Text style={styles.hint} testID={testID}>
      {children}
    </Text>
  );
}

/** A help sentence naming the bot, with its `<code>` part (what to type) set as code. */
function NamedHint({ i18nKey, name, testID }: { i18nKey: string; name: string; testID?: string }) {
  const { t } = useTranslation();
  const segments = helpSegments(t(i18nKey, { name: NAME_SLOT }), name);
  return (
    <Text style={styles.hint} testID={testID}>
      {segments.map((segment) =>
        segment.code ? (
          <Text key={segment.start} style={styles.hintCode}>
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

function Steps() {
  const { t } = useTranslation();
  return (
    <View style={styles.helpSteps}>
      {STEPS.map((key) => (
        <Hint key={key}>{t(key)}</Hint>
      ))}
    </View>
  );
}

/** Before the first bot: what a bot is in three steps, and the way to make one. */
export function TeammateCard({ onNewBot, testID }: { onNewBot: () => void; testID?: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.helpTitle}>{t("bots.help.teammate")}</Text>
      <Steps />
      <View style={styles.row}>
        <Button size="sm" onPress={onNewBot} testID={testID ? `${testID}-new` : undefined}>
          {t("bots.newBot")}
        </Button>
      </View>
    </View>
  );
}

function HowToAskLines({ serverId, bot }: { serverId: string; bot: Bot }) {
  const slack = useBotSlackStatus(serverId, bot.id);
  const keys = howToAskKeys(slack.data?.connected ?? false);
  return (
    <>
      {keys.map((key) => (
        <NamedHint key={key} i18nKey={key} name={bot.name} testID={`bot-how-to-ask-${key}`} />
      ))}
    </>
  );
}

/** Above the composer while the bot's chat is empty. */
export function HowToAsk({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  return (
    <View style={styles.howToAsk} testID="bot-how-to-ask">
      <Text style={styles.helpTitle}>{t("bots.help.howToAsk")}</Text>
      <HowToAskLines serverId={serverId} bot={bot} />
    </View>
  );
}

/** First line or empty state of a tab, naming the bot. */
export function TabHint({ i18nKey, bot, testID }: { i18nKey: string; bot: Bot; testID?: string }) {
  return <NamedHint i18nKey={i18nKey} name={bot.name} testID={testID} />;
}

function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.helpSection}>
      <Text style={styles.helpTitle}>{title}</Text>
      {children}
    </View>
  );
}

function HowBotsWorkSheet({
  serverId,
  bot,
  onClose,
}: {
  serverId: string;
  bot: Bot;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("bots.help.open") }), [t]);
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      testID="bot-help-sheet"
    >
      <ScrollView contentContainerStyle={styles.body}>
        <Steps />
        <SheetSection title={t("bots.chat")}>
          <HowToAskLines serverId={serverId} bot={bot} />
        </SheetSection>
        <SheetSection title={t("bots.items")}>
          <NamedHint i18nKey="bots.help.items" name={bot.name} />
        </SheetSection>
        <SheetSection title={t("bots.soulMemory")}>
          <NamedHint i18nKey="bots.help.soulMemory" name={bot.name} />
        </SheetSection>
        <SheetSection title={t("bots.schedules")}>
          <Hint>{t("bots.help.schedules")}</Hint>
        </SheetSection>
        <SheetSection title={t("bots.settings")}>
          <Hint>{t("bots.help.lookAround")}</Hint>
          <Hint>{t("bots.help.unattended")}</Hint>
        </SheetSection>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

/** The bot header's `?`: opens "How bots work". */
export function HowBotsWorkButton({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={helpIcon}
        onPress={show}
        accessibilityLabel={t("bots.help.open")}
        testID="bot-help"
      />
      {open ? <HowBotsWorkSheet serverId={serverId} bot={bot} onClose={hide} /> : null}
    </>
  );
}
