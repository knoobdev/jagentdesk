import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

describe("daemon E2E — usage history RPC is wired", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("getUsageHistory round-trips over the socket and returns an array", async () => {
    const result = await ctx.client.getUsageHistory();
    expect(Array.isArray(result.days)).toBe(true);
  });
});
