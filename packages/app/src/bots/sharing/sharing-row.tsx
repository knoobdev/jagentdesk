// Settings › Sharing of a bot (spec 37.4.8 item 7, 37.13.3 item 4): "Share" opens the Share dialog;
// a shared bot reads "{{name}} is shared" + "Updated {{date}}"; a copy reads "Shared by {{who}}" with
// "View original". Self-contained so the Settings layout can place it.
import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotShareReview } from "@jagentdesk/protocol/bots/share-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useBotsConnection } from "../queries";
import { styles } from "../styles";
import { BotShareDialog } from "./share-dialog";
import { BotShareReviewPanel } from "./receive-flow";
import { shareErrorCopy } from "./share-model";
import { useBotShareStatus, useBotSharingSupported } from "./share-queries";

function OriginalSheet({ review, onClose }: { review: BotShareReview; onClose: () => void }) {
  const { t } = useTranslation();
  const header = useMemo(() => ({ title: t("bots.share.copy.viewOriginal") }), [t]);
  return (
    <AdaptiveModalSheet visible onClose={onClose} onDismiss={onClose} header={header}>
      <ScrollView>
        <View style={styles.body}>
          <BotShareReviewPanel review={review} onNotNow={onClose} />
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

export function BotSharingRow({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const supported = useBotSharingSupported(serverId);
  const status = useBotShareStatus(serverId, bot.id);
  const { client } = useBotsConnection(serverId);
  const [dialog, setDialog] = useState(false);
  const [original, setOriginal] = useState<BotShareReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openDialog = useCallback(() => setDialog(true), []);
  const closeDialog = useCallback(() => setDialog(false), []);
  const closeOriginal = useCallback(() => setOriginal(null), []);
  const viewOriginal = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      const result = await client.botsRequest("bots.share.original.request", { botId: bot.id });
      if (result.review) setOriginal(result.review);
    } catch (err) {
      setError(shareErrorCopy(err, t));
    }
  }, [client, bot.id, t]);
  if (!supported) return null;
  const data = status.data;
  const from = data?.sharedFrom;
  return (
    <View style={styles.card} testID="bot-sharing">
      <View style={styles.between}>
        <View style={styles.column}>
          <Text style={styles.text}>
            {data?.link ? t("bots.share.isShared", { name: bot.name }) : t("bots.share.share")}
          </Text>
          {data?.link && data.updatedAt_ms ? (
            <Text style={styles.muted}>
              {t("bots.share.updatedAt", { date: new Date(data.updatedAt_ms).toLocaleString() })}
            </Text>
          ) : null}
        </View>
        <Button size="sm" variant="outline" onPress={openDialog} testID="bot-share-open">
          {t("bots.share.shareBot")}
        </Button>
      </View>
      {from ? (
        <View style={styles.between}>
          <Text style={styles.muted} testID="bot-shared-by">
            {t("bots.share.copy.sharedBy", {
              who: from.sharedBy ?? t("bots.share.review.someone"),
            })}
          </Text>
          {data?.originalGone ? (
            <Text style={styles.muted}>{t("bots.share.copy.originalGone")}</Text>
          ) : (
            <Button size="sm" variant="ghost" onPress={viewOriginal} testID="bot-view-original">
              {t("bots.share.copy.viewOriginal")}
            </Button>
          )}
        </View>
      ) : null}
      {status.isError ? <Alert title={t("bots.share.linkStatusUnavailable")} /> : null}
      {error ? <Alert variant="error" title={error} /> : null}
      {dialog ? <BotShareDialog serverId={serverId} bot={bot} onClose={closeDialog} /> : null}
      {original ? <OriginalSheet review={original} onClose={closeOriginal} /> : null}
    </View>
  );
}
