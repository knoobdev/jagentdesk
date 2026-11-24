import type { Page } from "@playwright/test";
import type { UsageReportEntry, UsageReport, ProviderUsage } from "@jagentdesk/protocol/messages";
import { daemonWsRoutePattern } from "./daemon-port";

interface ProviderUsageFixturePayload {
  fetchedAt: string;
  providers: ProviderUsage[];
}

export interface ProviderUsageFixture {
  requestCount(): number;
  waitForRequestCount(count: number): Promise<void>;
}

type WebSocketMessage = string | Buffer;

function parseJson(message: WebSocketMessage): unknown {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

function withProviderUsageFeature(message: WebSocketMessage): string | null {
  const envelope = parseJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as {
    type?: unknown;
    message?: {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
  };
  const payload = maybeEnvelope.message?.payload;
  if (
    maybeEnvelope.type !== "session" ||
    maybeEnvelope.message?.type !== "status" ||
    payload?.status !== "server_info"
  ) {
    return null;
  }
  return JSON.stringify({
    ...maybeEnvelope,
    message: {
      ...maybeEnvelope.message,
      payload: {
        ...payload,
        features: {
          ...(typeof payload.features === "object" && payload.features !== null
            ? payload.features
            : {}),
          providerUsageList: true,
          usageSources: true,
        },
      },
    },
  });
}

export async function installProviderUsageFixture(
  page: Page,
  payloads: ProviderUsageFixturePayload[],
): Promise<ProviderUsageFixture> {
  await page.addInitScript(() => {
    localStorage.setItem("@jagentdesk:app-settings", JSON.stringify({ usageInSidebar: false }));
  });
  let requests = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  function notifyWaiters() {
    for (const waiter of waiters.splice(0)) {
      if (requests >= waiter.count) {
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  }

  function payloadForRequest(): ProviderUsageFixturePayload {
    const index = Math.min(requests - 1, payloads.length - 1);
    const payload = payloads[index];
    if (!payload) {
      throw new Error("Provider usage fixture requires at least one payload.");
    }
    return payload;
  }

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (sessionMessage?.type === "usage.list_reports.request") {
        requests += 1;
        const requestId = sessionMessage.requestId;
        if (typeof requestId !== "string") {
          throw new Error("usage.list_reports.request missing requestId");
        }
        const payload = payloadForRequest();
        notifyWaiters();
        ws.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "usage.list_reports.response",
              payload: {
                requestId,
                reports: payload.providers.map((provider) =>
                  usageEntry(provider, payload.fetchedAt),
                ),
                error: null,
              },
            },
          }),
        );
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const serverInfo = typeof message === "string" ? withProviderUsageFeature(message) : null;
      ws.send(serverInfo ?? message);
    });
  });

  return {
    requestCount() {
      return requests;
    },
    waitForRequestCount(count: number) {
      if (requests >= count) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  };
}

function usageEntry(provider: ProviderUsage, fetchedAt: string): UsageReportEntry {
  let report: UsageReport;
  if (provider.status === "available") {
    report = {
      status: "available",
      windows: provider.windows,
      planLabel: provider.planLabel ?? undefined,
      balances: provider.balances,
      details: provider.details,
    };
  } else if (provider.status === "error") {
    report = { status: "error", error: provider.error ?? "Usage fetch failed" };
  } else {
    report = {
      status: "unavailable",
      problem: { kind: "no_quota", detail: provider.error ?? "No quota" },
    };
  }
  return {
    id: provider.providerId,
    sourceId: provider.providerId,
    sourceLabel: provider.displayName,
    account: {},
    fetchedAt,
    report,
  };
}
