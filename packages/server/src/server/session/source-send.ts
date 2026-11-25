import type { Logger } from "pino";

export function observeSourceSend(
  send: () => void | Promise<void>,
  logger: Pick<Logger, "warn">,
): Promise<void> {
  let pending: Promise<void>;
  try {
    pending = Promise.resolve(send());
  } catch (error) {
    pending = Promise.reject(error);
  }
  // Legacy producers fire and forget; owned streams await the same failure.
  void pending.catch((error) => logger.warn({ err: error }, "Failed to emit source frame"));
  return pending;
}
