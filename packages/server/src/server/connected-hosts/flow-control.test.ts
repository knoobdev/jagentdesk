import { expect, test } from "vitest";
import { HostChannelFlowControl, HostChannelOutputLimitError } from "./flow-control.js";
import { HostTransportBudget } from "@jagentdesk/client/node";
test("4 MiB overflow releases only its channel and leaves a sibling working", async () => {
  const shared = new HostTransportBudget(32 * 1024 * 1024);
  const overloaded = new HostChannelFlowControl((bytes) => shared.reserve(bytes));
  const sibling = new HostChannelFlowControl((bytes) => shared.reserve(bytes));
  const held = overloaded.send(4 * 1024 * 1024, async () => {});
  const rejected = expect(held).rejects.toThrow("Host channel closed");
  await expect(overloaded.send(1, async () => {})).rejects.toBeInstanceOf(
    HostChannelOutputLimitError,
  );
  overloaded.close();
  await rejected;
  const healthy = sibling.send(10, async () => {});
  sibling.acknowledge(1);
  await healthy;
  expect(shared.bufferedBytes).toBe(0);
});
