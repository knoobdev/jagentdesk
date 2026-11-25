import { expect, test } from "vitest";
import pino from "pino";
import { observeSourceSend } from "./source-send.js";

test("a fire-and-forget source send observes a synchronous transport failure", async () => {
  const lines: string[] = [];
  const logger = pino({ level: "warn" }, { write: (line) => lines.push(line) });
  const failure = new Error("source closed during send");
  expect(() => {
    void observeSourceSend(() => {
      throw failure;
    }, logger);
  }).not.toThrow();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lines.map((line) => JSON.parse(line).msg)).toEqual(["Failed to emit source frame"]);
});

test("a fire-and-forget source send observes an asynchronous transport failure", async () => {
  const lines: string[] = [];
  const logger = pino({ level: "warn" }, { write: (line) => lines.push(line) });
  void observeSourceSend(async () => {
    throw new Error("source closed after send started");
  }, logger);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(lines.map((line) => JSON.parse(line).msg)).toEqual(["Failed to emit source frame"]);
});

test("an owned stream awaiting a source send receives the original rejection", async () => {
  const logger = pino({ level: "silent" });
  const failure = new Error("source closed during owned send");
  const pending = Promise.reject(failure);
  const observed = observeSourceSend(() => pending, logger);
  expect(observed).toBe(pending);
  await expect(observed).rejects.toBe(failure);
});

test("successful source sends resolve without a failure log", async () => {
  const lines: string[] = [];
  const logger = pino({ level: "warn" }, { write: (line) => lines.push(line) });
  await expect(observeSourceSend(() => {}, logger)).resolves.toBeUndefined();
  await expect(observeSourceSend(() => Promise.resolve(), logger)).resolves.toBeUndefined();
  expect(lines).toEqual([]);
});
