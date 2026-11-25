import type { LifetimeUsage } from "@jagentdesk/protocol/usage-history";
import type {
  BuiltinDaemonContext,
  BuiltinServerHost,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { buildLifetimeBaseline, UsageHistoryStorage } from "./usage-history-storage.js";

// Zeroed lifetime total, emitted when no usage-history store is wired (and as the
// post-reset shape). Kept module-scoped so the get + reset handlers share one.
const EMPTY_LIFETIME_USAGE: LifetimeUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalCostUsd: 0,
  turns: 0,
  byModel: {},
};

async function createUsageHistory(context: BuiltinDaemonContext) {
  const { logger, agentStorage } = context;
  const usageHistory = new UsageHistoryStorage(context.home, logger);
  await usageHistory.initialize();
  // Seed the lifetime usage baseline once from existing agents so headline Usage
  // & Cost figures include usage that predates the time-series and never drop
  // when an agent is deleted. No-op if a baseline was already persisted.
  try {
    const records = await agentStorage.list();
    usageHistory.seedBaselineIfEmpty(
      buildLifetimeBaseline(
        records.map((record) => ({
          usageTotals: record.usageTotals,
          model: record.config?.model ?? record.runtimeInfo?.model ?? record.provider,
        })),
      ),
    );
  } catch (error) {
    logger.warn({ err: error }, "Failed to seed usage baseline from existing agents");
  }
  const unsubscribe = usageHistory.onChange((days, lifetime) => {
    context.broadcast({ type: "status", payload: { status: "usage_changed", days, lifetime } });
  });
  return { usageHistory, unsubscribe };
}

function handleUsageHistory(
  usageHistory: UsageHistoryStorage | undefined,
  msg: SessionInboundMessage,
  emit: (message: SessionOutboundMessage) => void,
): void {
  if (msg.type === "usage.history.get.request") {
    emit({
      type: "usage.history.get.response",
      payload: {
        requestId: msg.requestId,
        days: usageHistory?.get() ?? [],
        lifetime: usageHistory?.lifetime() ?? EMPTY_LIFETIME_USAGE,
      },
    });
    return;
  }
  if (msg.type === "usage.history.reset.request") {
    // Destructive: zero the persisted time-series + lifetime baseline. clear()
    // also notifies listeners so the daemon broadcasts status:usage_changed and
    // every other viewer's dashboard drops to zero too.
    usageHistory?.clear();
    emit({
      type: "usage.history.reset.response",
      payload: {
        requestId: msg.requestId,
        days: usageHistory?.get() ?? [],
        lifetime: usageHistory?.lifetime() ?? EMPTY_LIFETIME_USAGE,
      },
    });
  }
}

export function register(host: BuiltinServerHost) {
  const history = host.daemonService(createUsageHistory, ({ unsubscribe }) => unsubscribe());
  host.provide("usageHistory", (daemon) => history.get(daemon)?.usageHistory);
  host.rpc(
    "usage.history.",
    ["usage.history.get.request", "usage.history.reset.request"],
    (services) => ({
      handle: (message) =>
        handleUsageHistory(history.get(services.daemon)?.usageHistory, message, services.push),
      stop() {},
    }),
  );
}
