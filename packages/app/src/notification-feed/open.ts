import { router, type Href } from "expo-router";
import type { NotificationFeedItem } from "@jagentdesk/protocol/notification-feed";
import type { PluginNotificationOpenTarget } from "@jagentdesk/protocol/messages";
import { buildBotsRoute } from "@/bots/model";
import { openPluginNotificationTarget } from "@/notification-open/react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { buildHostRootRoute } from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { feedOpenTarget, type FeedOpenTarget } from "./model";
import { markNotificationFeedRead } from "./store";

type FeedPluginOpen = Extract<FeedOpenTarget, { kind: "plugin" }>["open"];

/** The plugin's declared target in the shape the plugin open path takes, when it is one. */
function pluginOpenTarget(open: FeedPluginOpen): PluginNotificationOpenTarget | undefined {
  if (open?.type === "agent" && open.agentId) return { type: "agent", agentId: open.agentId };
  if (open?.type === "workspace" && open.workspaceId) {
    return { type: "workspace", workspaceId: open.workspaceId };
  }
  if (open?.type === "screen" && open.screenId) {
    return { type: "screen", screenId: open.screenId, params: open.params };
  }
  return undefined;
}

/** Tapping a row: open what it points at and mark it read for every device of the host. */
export function openNotificationFeedItem(serverId: string, item: NotificationFeedItem): void {
  const client = getHostRuntimeStore().getClient(serverId);
  if (client && item.readAtMs === null) {
    void markNotificationFeedRead(client, serverId, [item.id]).catch((error) =>
      console.warn("[NotificationFeed] Failed to mark a row read", error),
    );
  }
  const target = feedOpenTarget(item);
  if (target.kind === "agent") {
    navigateToAgent({
      serverId,
      agentId: target.agentId,
      workspaceId: target.workspaceId,
      pin: true,
    });
    return;
  }
  if (target.kind === "bot") {
    router.navigate(
      buildBotsRoute(serverId, {
        botId: target.botId,
        ...(target.itemId ? { itemId: target.itemId } : {}),
      }) as Href,
    );
    return;
  }
  if (target.kind === "plugin") {
    void openPluginNotificationTarget({
      kind: "plugin",
      serverId,
      pluginId: target.pluginId,
      notificationId: target.notificationId,
      open: pluginOpenTarget(target.open),
    }).catch((error) => console.warn("[NotificationFeed] Failed to open a plugin row", error));
    return;
  }
  router.navigate(buildHostRootRoute(serverId) as Href);
}
