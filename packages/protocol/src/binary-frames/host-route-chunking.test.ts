import { expect, test } from "vitest";
import { ChunkedTransport } from "../chunked-transport.js";
import {
  MAX_HOST_CHANNEL_FRAME_BYTES,
  encodeHostRouteFrame,
  decodeHostRouteFrame,
} from "./host-route.js";

test("ordinary escaped route text stays inside the 4 MiB channel admission budget", async () => {
  const text = "\0".repeat(MAX_HOST_CHANNEL_FRAME_BYTES);
  const transport = new ChunkedTransport({
    frameBytes: MAX_HOST_CHANNEL_FRAME_BYTES,
    send(frame) {
      const outer = JSON.stringify({
        type: "session",
        message: {
          type: "hosts.route.frame.request",
          routeId: "route",
          data: frame,
          binary: false,
        },
      });
      expect(new TextEncoder().encode(outer).byteLength).toBeLessThan(4 * 1024 * 1024);
    },
    deliver() {},
  });
  transport.enabled = true;
  await transport.send(text);
});

test("a logical binary message larger than the channel queue crosses bounded raw route frames", async () => {
  const payload = Uint8Array.from({ length: 5 * 1024 * 1024 }, (_, index) => index % 251);
  const delivered: (string | Uint8Array)[] = [];
  const receiver = new ChunkedTransport({
    frameBytes: MAX_HOST_CHANNEL_FRAME_BYTES,
    send() {},
    deliver(frame) {
      delivered.push(frame);
    },
  });
  receiver.enabled = true;
  let frames = 0;
  const sender = new ChunkedTransport({
    frameBytes: MAX_HOST_CHANNEL_FRAME_BYTES,
    send(frame) {
      expect(frame).toBeInstanceOf(Uint8Array);
      const wire = encodeHostRouteFrame("route", frame as Uint8Array);
      expect(wire.byteLength).toBeLessThan(4 * 1024 * 1024);
      const routed = decodeHostRouteFrame(wire)!;
      receiver.receive(routed.payload);
      frames++;
    },
    deliver() {},
  });
  sender.enabled = true;
  await sender.send(payload);
  expect(frames).toBeGreaterThan(1);
  expect(delivered).toHaveLength(1);
  expect(Buffer.from(delivered[0] as Uint8Array).equals(Buffer.from(payload))).toBe(true);
});
