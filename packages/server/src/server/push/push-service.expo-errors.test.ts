import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import { PushService } from "./push-service.js";

interface ExpoMessage {
  to: string;
  priority?: string;
}

interface FakeExpoReply {
  status: number;
  body: string;
}

interface FakeExpo {
  url: string;
  requests: ExpoMessage[][];
  close(): Promise<void>;
}

const IOS_TOKEN = "ExponentPushToken[current-project-ios]";
const ANDROID_TOKEN = "ExponentPushToken[current-project-android]";
const OLD_BUILD_TOKEN = "ExponentPushToken[previous-project-phone]";

// Local stand-in for https://exp.host/--/api/v2/push/send. Never talks to Expo.
async function startFakeExpo(reply: (messages: ExpoMessage[]) => FakeExpoReply): Promise<FakeExpo> {
  const requests: ExpoMessage[][] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const messages = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ExpoMessage[];
      requests.push(messages);
      const { status, body } = reply(messages);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/--/api/v2/push/send`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function okTickets(messages: ExpoMessage[]): FakeExpoReply {
  return {
    status: 200,
    body: JSON.stringify({ data: messages.map(() => ({ status: "ok", id: "ticket" })) }),
  };
}

function createRecordingLogger(): { logger: pino.Logger; output: () => string } {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });
  return { logger, output: () => lines.join("") };
}

function errorLines(output: string): Record<string, unknown>[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === "Expo push API error");
}

function recipientsOf(fake: FakeExpo): string[][] {
  return fake.requests.map((batch) => batch.map((message) => message.to));
}

function androidUnregisteredTicket(message: ExpoMessage): Record<string, unknown> {
  if (message.to !== ANDROID_TOKEN) return { status: "ok", id: "ticket" };
  return {
    status: "error",
    message: `"${message.to}" is not a registered push notification recipient`,
    details: { error: "DeviceNotRegistered", expoPushToken: message.to },
  };
}

describe("PushService against Expo request errors", () => {
  const servers: FakeExpo[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  function serviceFor(fake: FakeExpo, logger: pino.Logger, revoked: string[] = []): PushService {
    const sendRequest: typeof fetch = (_url, init) => fetch(fake.url, init);
    return new PushService({ logger, revokeToken: (token) => revoked.push(token), sendRequest });
  }

  test("tokens from two Expo projects are delivered with one request per project", async () => {
    const projectOf = (token: string) =>
      token === OLD_BUILD_TOKEN ? "@previous-owner/app" : "@current-owner/app";
    const fake = await startFakeExpo((messages) => {
      const projects = new Map<string, string[]>();
      for (const message of messages) {
        const project = projectOf(message.to);
        projects.set(project, [...(projects.get(project) ?? []), message.to]);
      }
      if (projects.size > 1) {
        return {
          status: 400,
          body: JSON.stringify({
            errors: [
              {
                code: "PUSH_TOO_MANY_EXPERIENCE_IDS",
                message:
                  "All push notification messages in the same request must be for the same project; check the details field to investigate conflicting tokens.",
                details: Object.fromEntries(projects),
                isTransient: false,
              },
            ],
          }),
        };
      }
      return okTickets(messages);
    });
    servers.push(fake);
    const { logger, output } = createRecordingLogger();

    await serviceFor(fake, logger).sendPush([IOS_TOKEN, OLD_BUILD_TOKEN, ANDROID_TOKEN], {
      title: "Agent finished",
      body: "Finished working.",
    });

    expect(recipientsOf(fake)).toEqual([
      [IOS_TOKEN, OLD_BUILD_TOKEN, ANDROID_TOKEN],
      [IOS_TOKEN, ANDROID_TOKEN],
      [OLD_BUILD_TOKEN],
    ]);
    expect(errorLines(output())).toEqual([
      expect.objectContaining({
        status: 400,
        errorCodes: ["PUSH_TOO_MANY_EXPERIENCE_IDS"],
      }),
    ]);
    expect(output()).not.toContain("current-project");
    expect(output()).not.toContain("previous-project");
  });

  test("a validation error is logged with its code and without the tokens", async () => {
    const fake = await startFakeExpo((messages) => ({
      status: 400,
      body: JSON.stringify({
        errors: [
          {
            code: "VALIDATION_ERROR",
            message: `"[0].priority" must be one of [default, normal, high] for ${messages[0].to}`,
            isTransient: false,
          },
        ],
      }),
    }));
    servers.push(fake);
    const { logger, output } = createRecordingLogger();

    await serviceFor(fake, logger).sendPush([IOS_TOKEN], { title: "Agent finished", body: "Done" });

    expect(fake.requests).toHaveLength(1);
    expect(errorLines(output())).toEqual([
      expect.objectContaining({
        status: 400,
        errorCodes: ["VALIDATION_ERROR"],
        errors: [
          {
            code: "VALIDATION_ERROR",
            message: '"[0].priority" must be one of [default, normal, high] for <push-token>',
            isTransient: false,
          },
        ],
      }),
    ]);
    expect(output()).not.toContain("current-project-ios");
  });

  test("a non-JSON error body still logs the HTTP status", async () => {
    const fake = await startFakeExpo(() => ({ status: 502, body: "<html>Bad gateway</html>" }));
    servers.push(fake);
    const { logger, output } = createRecordingLogger();

    await serviceFor(fake, logger).sendPush([IOS_TOKEN], { title: "Agent finished", body: "Done" });

    expect(errorLines(output())).toEqual([
      expect.objectContaining({ status: 502, errorCodes: [], errors: [] }),
    ]);
  });

  test("a malformed token is dropped before it can fail the other devices' request", async () => {
    const fake = await startFakeExpo(okTickets);
    servers.push(fake);
    const { logger, output } = createRecordingLogger();
    const revoked: string[] = [];

    await serviceFor(fake, logger, revoked).sendPush(["raw-apns-device-token", IOS_TOKEN], {
      title: "Agent finished",
      body: "Done",
    });

    expect(recipientsOf(fake)).toEqual([[IOS_TOKEN]]);
    expect(revoked).toEqual(["raw-apns-device-token"]);
    expect(output()).not.toContain("raw-apns-device-token");
  });

  test("an unregistered device is revoked and its token stays out of the log", async () => {
    const fake = await startFakeExpo((messages) => ({
      status: 200,
      body: JSON.stringify({
        data: messages.map(androidUnregisteredTicket),
      }),
    }));
    servers.push(fake);
    const { logger, output } = createRecordingLogger();
    const revoked: string[] = [];

    await serviceFor(fake, logger, revoked).sendPush([IOS_TOKEN, ANDROID_TOKEN], {
      title: "Agent finished",
      body: "Done",
    });

    expect(revoked).toEqual([ANDROID_TOKEN]);
    expect(output()).toContain('"errorCode":"DeviceNotRegistered"');
    expect(output()).not.toContain("current-project-android");
  });
});
