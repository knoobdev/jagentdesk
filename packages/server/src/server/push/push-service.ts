import { createHash } from "node:crypto";
import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
  priority?: "default" | "normal" | "high";
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoRequestError {
  code: string | null;
  message: string | null;
  isTransient: boolean | null;
  details: unknown;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_BATCH_SIZE = 100;
// Expo rejects a whole request (HTTP 400) when its tokens belong to more than one Expo
// project, and lists the request's tokens per project in `details`.
const TOO_MANY_EXPERIENCE_IDS = "PUSH_TOO_MANY_EXPERIENCE_IDS";
// Same acceptance rule as expo-server-sdk-node's Expo.isExpoPushToken.
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[.+\]$/;
const UUID_PUSH_TOKEN_PATTERN = /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i;
const EXPO_PUSH_TOKEN_IN_TEXT = /Expo(?:nent)?PushToken\[[^\]]*\]/g;

export function isExpoPushToken(token: string): boolean {
  return EXPO_PUSH_TOKEN_PATTERN.test(token) || UUID_PUSH_TOKEN_PATTERN.test(token);
}

/** Stable short id so log lines about one device can be correlated without the token. */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function redactTokens(text: string, tokens: readonly string[]): string {
  let redacted = text.replace(EXPO_PUSH_TOKEN_IN_TEXT, "<push-token>");
  for (const token of tokens) {
    if (token) redacted = redacted.split(token).join("<push-token>");
  }
  return redacted;
}

function parseRequestErrors(body: unknown): ExpoRequestError[] {
  if (!body || typeof body !== "object") return [];
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors.map((value: unknown) => {
    const entry = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      code: typeof entry.code === "string" ? entry.code : null,
      message: typeof entry.message === "string" ? entry.message : null,
      isTransient: typeof entry.isTransient === "boolean" ? entry.isTransient : null,
      details: entry.details,
    };
  });
}

/** Splits a batch by the per-project token lists Expo returns with PUSH_TOO_MANY_EXPERIENCE_IDS. */
function splitByExperience(messages: ExpoPushMessage[], details: unknown): ExpoPushMessage[][] {
  if (!details || typeof details !== "object") return [];
  const groups: ExpoPushMessage[][] = [];
  const assigned = new Set<string>();
  for (const tokens of Object.values(details as Record<string, unknown>)) {
    if (!Array.isArray(tokens)) continue;
    const members = new Set(tokens.filter((token): token is string => typeof token === "string"));
    const group = messages.filter(
      (message) => members.has(message.to) && !assigned.has(message.to),
    );
    if (group.length === 0) continue;
    for (const message of group) assigned.add(message.to);
    groups.push(group);
  }
  const unassigned = messages.filter((message) => !assigned.has(message.to));
  if (unassigned.length > 0) groups.push(unassigned);
  return groups;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Service for sending Expo push notifications.
 * Handles batching and invalid token removal.
 */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;
  private readonly sendRequest: typeof fetch;

  constructor(options: {
    logger: pino.Logger;
    revokeToken: (token: string) => void;
    sendRequest?: typeof fetch;
  }) {
    this.logger = options.logger.child({ component: "push-service" });
    this.revokeToken = options.revokeToken;
    this.sendRequest = options.sendRequest ?? fetch;
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    // A token Expo cannot parse makes it reject the whole request, so one bad
    // registration would block every other device. Expo can never deliver to it.
    const malformed = tokens.filter((token) => !isExpoPushToken(token));
    if (malformed.length > 0) {
      this.logger.warn(
        { count: malformed.length, tokens: malformed.map(tokenFingerprint) },
        "Dropping malformed Expo push tokens",
      );
      for (const token of malformed) this.revokeToken(token);
    }

    // Expo defaults to "normal" priority on Android, which FCM holds back while
    // the device dozes, so notifications arrive minutes late. iOS already
    // defaults to "high".
    const messages: ExpoPushMessage[] = tokens.filter(isExpoPushToken).map((token) => ({
      to: token,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      sound: "default",
      priority: "high",
    }));

    // Batch tokens (max 100 per request per Expo limits)
    const batches: ExpoPushMessage[][] = [];
    for (let i = 0; i < messages.length; i += MAX_BATCH_SIZE) {
      batches.push(messages.slice(i, i + MAX_BATCH_SIZE));
    }

    await Promise.all(batches.map((batch) => this.sendBatch(batch, { splitByExperience: true })));
  }

  private async sendBatch(
    messages: ExpoPushMessage[],
    options: { splitByExperience: boolean },
  ): Promise<void> {
    try {
      const response = await this.sendRequest(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(messages),
      });

      if (!response.ok) {
        const errors = parseRequestErrors(await readJsonBody(response));
        const tokens = messages.map((message) => message.to);
        this.logger.error(
          {
            status: response.status,
            statusText: response.statusText,
            messageCount: messages.length,
            errorCodes: errors.map((error) => error.code),
            errors: errors.map((error) => ({
              code: error.code,
              message: error.message === null ? null : redactTokens(error.message, tokens),
              isTransient: error.isTransient,
            })),
          },
          "Expo push API error",
        );
        const mixedProjects = errors.find((error) => error.code === TOO_MANY_EXPERIENCE_IDS);
        if (options.splitByExperience && mixedProjects) {
          const groups = splitByExperience(messages, mixedProjects.details);
          if (groups.length > 1) {
            this.logger.warn(
              { groupSizes: groups.map((group) => group.length) },
              "Push tokens belong to several Expo projects; sending one request per project",
            );
            await Promise.all(
              groups.map((group) => this.sendBatch(group, { splitByExperience: false })),
            );
          }
        }
        return;
      }

      const result = (await response.json()) as { data?: ExpoPushTicket[] };
      this.handleTickets(messages, Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
    }
  }

  private handleTickets(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): void {
    for (let i = 0; i < tickets.length && i < messages.length; i++) {
      const ticket = tickets[i];
      const message = messages[i];

      if (ticket.status === "error") {
        const errorCode = ticket.details?.error ?? null;
        this.logger.error(
          {
            token: tokenFingerprint(message.to),
            errorCode,
            message: ticket.message ? redactTokens(ticket.message, [message.to]) : null,
          },
          "Push failed for token",
        );

        // Remove invalid tokens
        if (errorCode === "DeviceNotRegistered" || errorCode === "InvalidCredentials") {
          this.revokeToken(message.to);
        }
      }
    }
  }
}
