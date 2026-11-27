// Opening a bot page (spec 37.4.2): the route is `/h/<serverId>/bots?botId=<id>`; what the right
// panel shows is client state (`panel-store.ts`), set before the route changes so the page opens on it.
import { router, type Href } from "expo-router";
import { buildBotsRoute } from "./model";
import { useBotPanelStore, type BotPanelTab, type BotSettingsPage } from "./panel-store";

export interface OpenBotTarget {
  tab?: BotPanelTab;
  itemId?: string;
  settings?: BotSettingsPage;
}

export function applyBotPanelTarget(botId: string, target: OpenBotTarget | undefined): void {
  if (!target) return;
  const panel = useBotPanelStore.getState();
  if (target.itemId) panel.openItem(botId, target.itemId);
  else if (target.settings) panel.openSettings(botId, target.settings);
  else if (target.tab) {
    panel.setTab(botId, target.tab);
    panel.setInspectorOpen(true);
  }
}

export function openBot(serverId: string, botId: string, target?: OpenBotTarget): void {
  applyBotPanelTarget(botId, target);
  router.push(buildBotsRoute(serverId, { botId }) as Href);
}

export function openBotRoom(serverId: string, roomId: string): void {
  router.push(buildBotsRoute(serverId, { roomId }) as Href);
}

/** Round-1 `tab` values, and `itemId`, as the panel they now live in. */
export function legacyBotTarget(params: {
  tab?: string;
  itemId?: string;
}): OpenBotTarget | undefined {
  if (params.itemId) return { itemId: params.itemId };
  switch (params.tab) {
    case "items":
    case "schedules":
    case "chat":
      return { tab: "home" };
    case "soulMemory":
      return { settings: "soul" };
    case "settings":
      return { settings: "root" };
    default:
      return undefined;
  }
}
