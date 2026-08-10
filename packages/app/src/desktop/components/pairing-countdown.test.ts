import { describe, expect, it } from "vitest";
import { formatPairingCountdown } from "./pairing-countdown";

describe("formatPairingCountdown", () => {
  it("formats the remaining pairing lifetime from the supplied clock", () => {
    expect(formatPairingCountdown(301_000, 1_000)).toBe("5:00");
    expect(formatPairingCountdown(301_000, 61_001)).toBe("4:00");
    expect(formatPairingCountdown(301_000, 300_501)).toBe("0:01");
  });

  it("does not produce a negative countdown after expiry", () => {
    expect(formatPairingCountdown(301_000, 301_001)).toBe("0:00");
  });
});
