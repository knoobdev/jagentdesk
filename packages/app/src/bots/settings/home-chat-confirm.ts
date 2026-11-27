// "New Home Chat" asks first unless Settings › Plugins › Bots turned that off (spec 37.3.5). Ported
// from Orca dfdb4fda (MIT) src/renderer/src/components/bots/bot-home-chat-confirm.tsx:1-45.
import { i18n } from "@/i18n/i18next";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useBotsPreferences } from "./preferences-store";

export async function confirmNewHomeChat(bot: { name: string }): Promise<boolean> {
  if (!useBotsPreferences.getState().askNewHomeChat) return true;
  return confirmDialog({
    title: i18n.t("bots.newHomeChat.title"),
    message: i18n.t("bots.newHomeChat.description", { name: bot.name }),
    confirmLabel: i18n.t("bots.newHomeChat.action"),
  });
}
