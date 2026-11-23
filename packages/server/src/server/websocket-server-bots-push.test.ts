import { expect, it, vi } from "vitest";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
it("includes the host id in a Needs-you push so the app can open the correct item", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  await VoiceAssistantWebSocketServer.prototype.sendBotPush.call(
    { serverId: "host", pushNotificationSender: { send } },
    {
      title: "Bot needs you",
      body: "Which scope?",
      data: { type: "bot_needs_you", botId: "bot", itemId: "item" },
    },
  );
  expect(send).toHaveBeenCalledWith({
    title: "Bot needs you",
    body: "Which scope?",
    data: { type: "bot_needs_you", botId: "bot", itemId: "item", serverId: "host" },
  });
});
