import { afterEach, describe, expect, test } from "vitest";
import type { NotificationFeedChangedPayload } from "@jagentdesk/protocol/notification-feed";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** The host's notification feed (ADR-0063) seen by two clients, then across a daemon restart. */
describe("notification feed", () => {
  const daemons: TestJAgentDeskDaemon[] = [];
  const clients: DaemonClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    for (const daemon of daemons.splice(0)) await daemon.close();
  }, 30_000);

  async function startDaemon(homeRoot: string, cleanup: boolean) {
    const daemon = await createTestJAgentDeskDaemon({ jagentdeskHomeRoot: homeRoot, cleanup });
    daemons.push(daemon);
    return daemon;
  }

  async function connect(daemon: TestJAgentDeskDaemon): Promise<DaemonClient> {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      messageQueueLimit: null,
    });
    await client.connect();
    clients.push(client);
    return client;
  }

  function appendedFor(agentId: string) {
    return (change: NotificationFeedChangedPayload) =>
      change.appended?.some((item) => item.target.agentId === agentId) === true;
  }

  function nextChange(
    client: DaemonClient,
    matches: (payload: NotificationFeedChangedPayload) => boolean,
  ): Promise<NotificationFeedChangedPayload> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error("Timed out waiting for notifications.feed.changed"));
      }, 20_000);
      const stop = client.on("notifications.feed.changed", (message) => {
        if (message.type !== "notifications.feed.changed" || !matches(message.payload)) return;
        clearTimeout(timer);
        stop();
        resolve(message.payload);
      });
    });
  }

  test("two clients share rows and read state, and the feed survives a restart", async () => {
    const homeRoot = await mkdtemp(path.join(tmpdir(), "notification-feed-home-"));
    const daemon = await startDaemon(homeRoot, false);
    const desktop = await connect(daemon);
    const phone = await connect(daemon);
    expect(phone.getLastServerInfoMessage()?.features?.notificationFeed).toBe(true);
    const feed = phone.observeEvents(["notifications.feed.changed"]);
    feed.subscribe({ snapshot: () => {}, update: () => {} });
    await feed.ready;

    const agentA = await desktop.createAgent({
      provider: "claude",
      model: "haiku",
      cwd: "/tmp",
      title: "A",
    });
    const agentB = await desktop.createAgent({
      provider: "claude",
      model: "haiku",
      cwd: "/tmp",
      title: "B",
    });

    const appendedA = nextChange(phone, appendedFor(agentA.id));
    await desktop.sendMessage(agentA.id, "Say 'hello' and nothing else");
    const changeA = await appendedA;
    expect(changeA.appended?.[0]).toMatchObject({
      kind: "agent_finished",
      title: "Agent finished",
      body: "Finished working.",
      target: { type: "agent", agentId: agentA.id, workspaceId: agentA.workspaceId },
      readAtMs: null,
    });

    const appendedB = nextChange(phone, appendedFor(agentB.id));
    await desktop.sendMessage(agentB.id, "Say 'hello' and nothing else");
    const changeB = await appendedB;
    expect(changeB.unreadCount).toBe(2);

    const listed = await desktop.listNotificationFeed();
    expect(listed.items.map((item) => item.target.agentId)).toEqual([agentB.id, agentA.id]);
    expect(listed.unreadCount).toBe(2);
    expect(listed.hasMore).toBe(false);

    // Desktop reads B's row; the phone hears about it.
    const rowB = listed.items[0]!;
    const readOnPhone = nextChange(phone, (change) => Boolean(change.readIds?.includes(rowB.id)));
    const marked = await desktop.markNotificationFeedRead({ ids: [rowB.id] });
    expect(marked).toMatchObject({ readIds: [rowB.id], unreadCount: 1 });
    expect((await readOnPhone).unreadCount).toBe(1);

    // Opening agent A on the desktop (not through the bell) reads A's row.
    const rowA = listed.items[1]!;
    const openedOnPhone = nextChange(phone, (change) => Boolean(change.readIds?.includes(rowA.id)));
    desktop.sendHeartbeat({
      deviceType: "web",
      focusedAgentId: agentA.id,
      lastActivityAt: new Date().toISOString(),
      appVisible: true,
    });
    expect((await openedOnPhone).unreadCount).toBe(0);

    await Promise.all(clients.splice(0).map((client) => client.close()));
    await daemons.splice(0)[0]!.close();

    const restarted = await startDaemon(homeRoot, true);
    const reconnected = await connect(restarted);
    const afterRestart = await reconnected.listNotificationFeed();
    expect(afterRestart.items.map((item) => [item.id, item.readAtMs !== null])).toEqual([
      [rowB.id, true],
      [rowA.id, true],
    ]);
    expect(afterRestart.unreadCount).toBe(0);
  }, 120_000);
});
