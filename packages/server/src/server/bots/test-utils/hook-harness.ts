import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { HookDelivery, HookKind } from "@jagentdesk/relay/hooks";
import { MemorySecretStore } from "../../database/secret-store.js";
import type { BotExternalMessage } from "../runtime.js";
import { FakeBotRuntime } from "./fake-runtime.js";
import { BotsService } from "../service.js";
import { BotStorage } from "../storage.js";
import { ForgeCliError, type ForgeCli } from "../hooks/cli.js";
import { BotConnectorEvents, type BotConnectorEvent } from "../hooks/events.js";
import { attachBotSchedules } from "./schedules.js";

/** A supervisor that records each turn and finishes it when the test says so (bt1's runtime otherwise). */
export class RecordingRuntime extends FakeBotRuntime {
  override sent: { id: string; text: string; source?: BotExternalMessage }[] = [];
  running = false;
  override busy(): boolean {
    return this.running;
  }
  override async send(
    id: string,
    text: string,
    _messageId?: string,
    _sourceId?: string,
    source?: BotExternalMessage,
  ): Promise<void> {
    source?.beforeDispatch();
    this.running = true;
    this.sent.push({ id, text, source });
  }
  override async cancel(): Promise<void> {
    this.running = false;
  }
  finish(bot: Bot, key: string, text: string): void {
    this.running = false;
    this.emit({ agentId: `supervisor:${bot.id}`, key, text, kind: "done" });
  }
}

export interface ForgeCall {
  args: string[];
  input?: string;
}
/** `gh`/`glab` stand-in: routes `api -X <METHOD> <path>` to a handler and records every call. */
export class FakeForgeCli {
  readonly calls: ForgeCall[] = [];
  signedIn = true;
  constructor(
    private readonly routes: (
      method: string,
      path: string,
      body: unknown,
    ) => unknown | { status: number },
  ) {}
  readonly run: ForgeCli = async (args, input) => {
    this.calls.push({ args, input });
    if (args[0] === "auth") {
      if (!this.signedIn) throw new ForgeCliError("not logged in", "not logged in", 1);
      return "";
    }
    const methodIndex = args.indexOf("-X");
    const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
    const path = args[methodIndex >= 0 ? methodIndex + 2 : args.indexOf("api") + 1];
    const result = this.routes(method, path, input ? JSON.parse(input) : undefined);
    if (result && typeof result === "object" && "status" in result) {
      const status = (result as { status: number }).status;
      throw new ForgeCliError(`HTTP ${status}`, `gh: Error (HTTP ${status})`, 1);
    }
    return result === undefined ? "" : JSON.stringify(result);
  };
  api(method: string, pathPrefix: string): ForgeCall[] {
    return this.calls.filter((call) => {
      const index = call.args.indexOf("-X");
      return (
        index >= 0 && call.args[index + 1] === method && call.args[index + 2].startsWith(pathPrefix)
      );
    });
  }
}

/** Loopback Telegram Bot API; never calls Telegram. */
export class LocalTelegramApi {
  readonly sent: {
    chat_id: string;
    text: string;
    reply_parameters?: { message_id: number };
    message_thread_id?: number;
    message_id: number;
  }[] = [];
  webhook: { url: string; secret_token?: string } = { url: "" };
  private nextId = 9000;
  private readonly server: Server;
  baseUrl = "";
  constructor(readonly token: string) {
    this.server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url ?? "");
        response.setHeader("Content-Type", "application/json");
        const reply = (value: unknown) => response.end(JSON.stringify(value));
        if (!match || match[1] !== this.token) {
          response.statusCode = 401;
          reply({ ok: false, error_code: 401, description: "Unauthorized" });
          return;
        }
        switch (match[2]) {
          case "getMe":
            return reply({
              ok: true,
              result: { id: 777, is_bot: true, username: "local_jad_bot" },
            });
          case "setWebhook":
            this.webhook = { url: body.url, secret_token: body.secret_token };
            return reply({ ok: true, result: true });
          case "deleteWebhook":
            this.webhook = { url: "" };
            return reply({ ok: true, result: true });
          case "getWebhookInfo":
            return reply({ ok: true, result: { url: this.webhook.url } });
          case "sendMessage": {
            const message_id = this.nextId++;
            this.sent.push({ ...body, message_id });
            return reply({ ok: true, result: { message_id } });
          }
          default:
            return reply({ ok: false, description: "Not Found" });
        }
      })().catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface HookHarness {
  bots: BotsService;
  runtime: RecordingRuntime;
  secrets: MemorySecretStore;
  events: BotConnectorEvent[];
  bus: BotConnectorEvents;
  bot: Bot;
  logs: string[];
  logger: pino.Logger;
  relay: () => { endpoint: string; serverId: string; enabled: boolean; useTls: boolean };
  frames: unknown[];
  cleanup: (() => Promise<void> | void)[];
}
export async function hookHarness(): Promise<HookHarness> {
  const home = mkdtempSync(join(tmpdir(), "bot-hooks-"));
  const runtime = new RecordingRuntime();
  const logs: string[] = [];
  const logger = pino(
    { level: "info" },
    {
      write(line: string) {
        logs.push(line);
      },
    },
  );
  const bots = new BotsService(new BotStorage(home), runtime, { logger });
  attachBotSchedules({ service: bots, home });
  const bus = new BotConnectorEvents();
  const events: BotConnectorEvent[] = [];
  bus.on((event) => events.push(event));
  const bot = await bots.create({
    slug: "scout",
    name: "Scout",
    identity: "Test",
    provider: "codex",
    model: "local",
    modeId: "default",
  });
  bots.start();
  // bt1 opens every new bot with its first-run kickoff turn; end it so each test starts idle.
  await bots.settled();
  if (runtime.sent.length) {
    runtime.finish(bot, "kickoff", "Ready.");
    await bots.settled();
    runtime.sent.length = 0;
  }
  return {
    bots,
    runtime,
    secrets: new MemorySecretStore(),
    events,
    bus,
    bot,
    logs,
    logger,
    relay: () => ({ endpoint: "127.0.0.1:8963", serverId: "local", enabled: true, useTls: false }),
    frames: [],
    cleanup: [
      async () => {
        await bots.dispose();
        rmSync(home, { recursive: true, force: true });
      },
    ],
  };
}

/** What the relay Worker would hand the daemon for this POST. */
export function delivery(
  kind: HookKind,
  hookId: string,
  body: string,
  headers: Record<string, string>,
  deliveryId = `d-${Math.random().toString(36).slice(2)}`,
): HookDelivery {
  return {
    type: "hook_delivery",
    v: 1,
    deliveryId,
    hookId,
    kind,
    headers: { "content-type": "application/json", ...headers },
    bodyB64: Buffer.from(body).toString("base64"),
    receivedAt_ms: Date.now(),
  };
}
