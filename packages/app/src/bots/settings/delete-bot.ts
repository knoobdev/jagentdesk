// "Delete bot…" from the settings view and the sidebar row's menu (spec 37.4.1, 37.4.8 item 9).
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/use-delete-bot.ts.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useBotsMutation } from "@/bots/queries";

/** Asks, then deletes; resolves true once the bot is gone. The folder stays on the host. */
export function useDeleteBot(serverId: string, bot: Pick<Bot, "id" | "name" | "home" | "folder">) {
  const { t } = useTranslation();
  const remove = useBotsMutation(serverId, "bots.delete.request");
  const { mutateAsync } = remove;
  const run = useCallback(
    async function deleteBot(): Promise<boolean> {
      const confirmed = await confirmDialog({
        title: t("bots.row.deleteTitle", { name: bot.name }),
        message: t("bots.row.deleteDescription", { path: bot.home ?? bot.folder ?? "" }),
        confirmLabel: t("bots.row.deleteConfirm"),
        destructive: true,
      });
      if (!confirmed) return false;
      await mutateAsync({ botId: bot.id });
      return true;
    },
    [bot.folder, bot.home, bot.id, bot.name, mutateAsync, t],
  );
  return { run, pending: remove.isPending, error: remove.error };
}
