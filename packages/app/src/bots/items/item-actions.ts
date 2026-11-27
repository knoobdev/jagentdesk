// The owner's item writes, one place for every surface (row, selection pill, item header, Stale
// Cancel all). Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/items/use-bot-items.ts
// (setBotItemsStatus, snoozeBotItems) and BotItemsList.tsx:150-185 (`move`), on the bt1 RPCs:
// bots.items.done / set_status / cancel_many / snooze / comment.
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Bot, BotItem, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { botErrorCode, botErrorMessage, useBotsMutation } from "@/bots/queries";
import { botItemUid } from "./item-rules";

export interface BotItemActions {
  /** Done; a review still to pass refuses it (`review_pending`) unless `force` ("Mark done anyway"). */
  done: (items: readonly BotItem[], force?: boolean) => Promise<boolean>;
  /** Any status but Canceled, which asks a reason first (`cancel`). */
  move: (items: readonly BotItem[], status: BotItemStatus) => Promise<boolean>;
  cancel: (items: readonly BotItem[], reason: string) => Promise<boolean>;
  snooze: (items: readonly BotItem[], until_ms: number | null) => Promise<boolean>;
  comment: (item: BotItem, text: string) => Promise<boolean>;
  pending: boolean;
}

export function useBotItemActions(serverId: string, bot: Pick<Bot, "id">): BotItemActions {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const doneMutation = useBotsMutation(serverId, "bots.items.done.request");
  const statusMutation = useBotsMutation(serverId, "bots.items.set_status.request");
  const cancelMutation = useBotsMutation(serverId, "bots.items.cancel_many.request");
  const snoozeMutation = useBotsMutation(serverId, "bots.items.snooze.request");
  const commentMutation = useBotsMutation(serverId, "bots.items.comment.request");
  const botId = bot.id;

  const run = useCallback(
    async (work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work();
        return true;
      } catch (error) {
        toast?.error(
          botErrorCode(error) === "review_pending"
            ? t("bots.jad.items.waitingForReview")
            : botErrorMessage(error),
        );
        return false;
      }
    },
    [t, toast],
  );

  const done = useCallback(
    (items: readonly BotItem[], force?: boolean) =>
      run(() =>
        Promise.all(
          items.map((item) =>
            doneMutation.mutateAsync(
              force ? { botId, itemId: item.id, force } : { botId, itemId: item.id },
            ),
          ),
        ),
      ),
    [run, doneMutation, botId],
  );
  const cancel = useCallback(
    (items: readonly BotItem[], reason: string) =>
      run(() => cancelMutation.mutateAsync({ botId, itemUids: items.map(botItemUid), reason })),
    [run, cancelMutation, botId],
  );
  const move = useCallback(
    (items: readonly BotItem[], status: BotItemStatus) => {
      if (status === "done") return done(items);
      return run(() =>
        Promise.all(
          items
            .filter((item) => item.status !== status)
            .map((item) => statusMutation.mutateAsync({ botId, itemId: item.id, status })),
        ),
      );
    },
    [done, run, statusMutation, botId],
  );
  const snooze = useCallback(
    (items: readonly BotItem[], until_ms: number | null) =>
      run(() =>
        Promise.all(
          items.map((item) =>
            snoozeMutation.mutateAsync({ botId, itemUid: botItemUid(item), until_ms }),
          ),
        ),
      ),
    [run, snoozeMutation, botId],
  );
  const comment = useCallback(
    (item: BotItem, text: string) =>
      run(() => commentMutation.mutateAsync({ botId, itemId: item.id, text })),
    [run, commentMutation, botId],
  );
  const pending =
    doneMutation.isPending ||
    statusMutation.isPending ||
    cancelMutation.isPending ||
    snoozeMutation.isPending ||
    commentMutation.isPending;
  return useMemo(
    () => ({ done, move, cancel, snooze, comment, pending }),
    [done, move, cancel, snooze, comment, pending],
  );
}
