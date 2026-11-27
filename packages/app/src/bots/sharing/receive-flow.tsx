// From a link… (spec 37.13.3): paste a link, the daemon downloads, decrypts and verifies it, the review
// shows exactly what Create writes, then the New bot form, prefilled, makes the copy. A port of Orca
// dfdb4fda src/renderer/src/components/bots/sharing/BotShareReceiveFlow.tsx, BotShareReviewDialog.tsx,
// BotShareReviewPages.tsx and NewBotFromShareParts.tsx (MIT). The same sheet serves desktop and phone.
import { useCallback, useMemo, useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { Bot, BotInput } from "@jagentdesk/protocol/bots/types";
import type { BotShareExisting, BotShareReview } from "@jagentdesk/protocol/bots/share-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NewBotDialog } from "../dialogs/new-bot-dialog";
import { botsKey, useBotsConnection } from "../queries";
import { Input } from "../ui";
import { styles } from "../styles";
import { flagLabel, flagWhere, shareErrorCode, shareErrorCopy } from "./share-model";

type Step =
  | { kind: "paste" }
  | { kind: "existing"; existing: BotShareExisting }
  | { kind: "stopped" }
  | { kind: "review"; review: BotShareReview }
  | { kind: "create"; review: BotShareReview }
  | { kind: "updated"; review: BotShareReview };

function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}

const AVATAR = { width: 40, height: 40 } as const;
function ReviewAvatar({ uri }: { uri: string }) {
  const source = useMemo(() => ({ uri }), [uri]);
  return <Image source={source} style={AVATAR} />;
}

/** The review (BotShareReviewDialog): who and when, each part Create writes, accounts, left out, flags. */
export function BotShareReviewPanel({
  review,
  onNotNow,
  onCreate,
}: {
  review: BotShareReview;
  onNotNow: () => void;
  onCreate?: () => void;
}) {
  const { t } = useTranslation();
  const who = review.sharedBy ?? t("bots.share.review.someone");
  const soul = review.files.find((file) => file.path === "SOUL.md");
  const skills = review.bot.skills.map((skill) => skill.name);
  const memory = review.files.filter((file) => file.path.startsWith("memory/"));
  return (
    <View style={styles.column} testID="bot-share-review">
      <View style={styles.row}>
        {review.avatarDataUrl ? <ReviewAvatar uri={review.avatarDataUrl} /> : null}
        <View style={styles.column}>
          <Text style={styles.title}>{review.bot.name}</Text>
          <Text style={styles.muted} testID="bot-share-review-byline">
            {t("bots.share.review.byline", {
              who,
              date: new Date(review.sharedAt_ms).toLocaleDateString(),
            })}
          </Text>
        </View>
      </View>
      {review.bot.purpose ? <Text style={styles.text}>{review.bot.purpose}</Text> : null}
      <View style={styles.card}>
        <Text style={styles.text}>
          {`SOUL.md · ${t("bots.share.lines", { count: soul ? lineCount(soul.text ?? "") : 0 })}`}
        </Text>
        {skills.map((name) => (
          <Text key={name} style={styles.text} testID="bot-share-review-skill">
            {`${t("bots.share.skills")} · ${name}`}
          </Text>
        ))}
        {review.bot.schedules.map((schedule) => (
          <Text key={schedule.id} style={styles.text} testID="bot-share-review-automation">
            {`${t("bots.share.automations")} · ${schedule.name} · ${t("bots.share.review.off")}`}
          </Text>
        ))}
        {memory.length > 0 ? (
          <Text style={styles.text}>
            {`MEMORY.md · ${t("bots.share.review.memoryIndex")} · ${t("bots.share.review.files", { count: memory.length })}`}
          </Text>
        ) : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.title}>{t("bots.share.review.accounts")}</Text>
        <Text style={styles.muted}>
          {review.bot.connectors.length > 0
            ? review.bot.connectors.map((connector) => connector.kind).join(", ")
            : t("bots.share.review.none")}
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={styles.title}>{t("bots.share.review.leftOut")}</Text>
        <Text style={styles.muted}>
          {review.leftOut.length > 0 ? review.leftOut.join("\n") : t("bots.share.review.none")}
        </Text>
      </View>
      {review.flags.length > 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>{t("bots.share.safetyCheck")}</Text>
          {review.flags.map((flag) => (
            <Text
              key={`${flag.where}:${flag.line}:${flag.kind}`}
              style={flag.kind === "secret" ? styles.warning : styles.text}
            >
              {`${flagLabel(flag.kind, t)} · ${flagWhere(flag, t)}`}
            </Text>
          ))}
        </View>
      ) : null}
      {review.bot.setupNote ? (
        <View style={styles.card}>
          <Text style={styles.title}>{t("bots.share.setupNote")}</Text>
          <Text style={styles.text}>{review.bot.setupNote}</Text>
        </View>
      ) : null}
      <View style={styles.row}>
        <Button variant="outline" onPress={onNotNow} testID="bot-share-review-not-now">
          {t("bots.share.review.notNow")}
        </Button>
        {onCreate ? (
          <Button onPress={onCreate} testID="bot-share-review-create">
            {t("bots.share.review.createBot")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

export function BotShareReceiveSheet({
  serverId,
  onClose,
  onOpenBot,
}: {
  serverId: string;
  /** Also closes after New bot made the copy and opened it. */
  onClose: () => void;
  onOpenBot: (botId: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { client } = useBotsConnection(serverId);
  const [link, setLink] = useState("");
  const [step, setStep] = useState<Step>({ kind: "paste" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const header = useMemo(() => ({ title: t("bots.share.receive.fromLink") }), [t]);

  const open = useCallback(async () => {
    if (!client) return;
    setPending(true);
    setError(null);
    try {
      const result = await client.botsRequest("bots.share.open.request", { link: link.trim() });
      if (result.existing) setStep({ kind: "existing", existing: result.existing });
      else if (result.review) setStep({ kind: "review", review: result.review });
    } catch (err) {
      if (shareErrorCode(err) === "bot_share_stopped") setStep({ kind: "stopped" });
      else setError(new Error(shareErrorCopy(err, t)));
    } finally {
      setPending(false);
    }
  }, [client, link, t]);

  const create = useCallback(
    async (review: BotShareReview, bot: BotInput): Promise<Bot> => {
      if (!client) throw new Error(t("bots.jad.offline"));
      setError(null);
      try {
        const result = await client.botsRequest("bots.share.create.request", {
          reviewId: review.reviewId,
          bot,
        });
        await queryClient.invalidateQueries({ queryKey: [...botsKey(serverId), "list"] });
        return result.bot;
      } catch (err) {
        const code = shareErrorCode(err);
        if (code === "bot_share_updated") setStep({ kind: "updated", review });
        else if (code === "bot_share_stopped") setStep({ kind: "stopped" });
        throw new Error(shareErrorCopy(err, t), { cause: err });
      }
    },
    [client, queryClient, serverId, t],
  );

  const openExisting = useCallback(
    function openExisting() {
      if (step.kind === "existing") onOpenBot(step.existing.botId);
    },
    [step, onOpenBot],
  );
  const toCreate = useCallback(
    function toCreate() {
      if (step.kind === "review") setStep({ kind: "create", review: step.review });
    },
    [step],
  );
  const toReview = useCallback(
    function toReview() {
      if (step.kind === "create") setStep({ kind: "review", review: step.review });
    },
    [step],
  );
  const shareSource = useMemo(
    () =>
      step.kind === "create"
        ? {
            review: step.review,
            onBack: toReview,
            create: (bot: BotInput) => create(step.review, bot),
          }
        : null,
    [step, toReview, create],
  );
  // The regular New bot dialog, made from the review (Orca BotShareReceiveFlow.tsx NewBotFromShare).
  if (shareSource) {
    return <NewBotDialog serverId={serverId} fromShare={shareSource} onClose={onClose} />;
  }

  let body: React.ReactNode;
  switch (step.kind) {
    case "paste":
      body = (
        <>
          <Text style={styles.muted}>{t("bots.share.receive.pasteDescription")}</Text>
          <Input
            label={t("bots.share.receive.link")}
            value={link}
            onChange={setLink}
            placeholder={t("bots.share.receive.linkPlaceholder")}
            testID="bot-share-link-input"
          />
          <Button
            onPress={open}
            loading={pending}
            disabled={pending || !link.trim()}
            testID="bot-share-continue"
          >
            {t("bots.share.receive.continue")}
          </Button>
        </>
      );
      break;
    case "existing":
      body = (
        <>
          <Text style={styles.title}>{t("bots.share.receive.have")}</Text>
          <Text style={styles.muted}>
            {t("bots.share.receive.haveDetail", {
              name: step.existing.name,
              date: new Date(step.existing.createdAt_ms).toLocaleDateString(),
            })}
          </Text>
          <View style={styles.row}>
            <Button variant="outline" onPress={onClose}>
              {t("bots.share.receive.close")}
            </Button>
            <Button onPress={openExisting} testID="bot-share-open-existing">
              {t("bots.share.receive.open")}
            </Button>
          </View>
        </>
      );
      break;
    case "stopped":
      body = (
        <>
          <Text style={styles.title} testID="bot-share-stopped">
            {t("bots.share.receive.stopped")}
          </Text>
          <Text style={styles.muted}>{t("bots.share.receive.stoppedDetail")}</Text>
          <Button variant="outline" onPress={onClose}>
            {t("bots.share.receive.close")}
          </Button>
        </>
      );
      break;
    case "updated":
      body = (
        <>
          <Text style={styles.text} testID="bot-share-updated">
            {t("bots.share.review.updated", {
              who: step.review.sharedBy ?? t("bots.share.review.theSharer"),
            })}
          </Text>
          <Button onPress={open} loading={pending} testID="bot-share-review-again">
            {t("bots.share.review.reviewAgain")}
          </Button>
        </>
      );
      break;
    case "review":
      body = <BotShareReviewPanel review={step.review} onNotNow={onClose} onCreate={toCreate} />;
      break;
  }
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      testID="bot-share-receive-sheet"
    >
      <ScrollView>
        <View style={styles.body}>
          {error ? <Alert variant="error" title={error.message} testID="bot-share-error" /> : null}
          {body}
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}
