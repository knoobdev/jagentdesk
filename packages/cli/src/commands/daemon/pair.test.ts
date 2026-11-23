import { describe, expect, test, vi } from "vitest";

import { runPairCommand, type PairCommandOutput, type PairingOffer } from "./pair.js";

const disabledOffer: PairingOffer = {
  tailnetEnabled: false,
  relayEnabled: false,
  url: null,
  qr: null,
};
const enabledOffer: PairingOffer = {
  tailnetEnabled: true,
  relayEnabled: false,
  url: "jagentdesk://app/#offer=test",
  qr: null,
};

interface RecordedPairCommandOutput extends PairCommandOutput {
  stdout: string[];
  stderr: string[];
  successes: string[];
  exitCode: number | undefined;
}

function createRecordedOutput(): RecordedPairCommandOutput {
  return {
    columns: 80,
    stdout: [],
    stderr: [],
    successes: [],
    exitCode: undefined,
    writeStdout(message) {
      this.stdout.push(message);
    },
    writeStderr(message) {
      this.stderr.push(message);
    },
    setExitCode(code) {
      this.exitCode = code;
    },
    success(message) {
      this.successes.push(message);
    },
  };
}

describe("daemon pair workflow", () => {
  test("disabled offer in human mode exits 1 with guidance and no stdout", async () => {
    const resolveOffer = vi.fn(async () => disabledOffer);
    const output = createRecordedOutput();

    await runPairCommand({}, { resolveOffer, isInteractive: () => true, output });

    expect(resolveOffer).toHaveBeenCalledWith({ jagentdeskHome: expect.any(String) });
    expect(output.exitCode).toBe(1);
    expect(output.stderr.join("")).toContain("No pairing transport is configured for this daemon");
    expect(output.stdout.join("")).toBe("");
  });

  test("disabled offer in JSON mode exits 1 with a structured error and no prompts", async () => {
    const resolveOffer = vi.fn(async () => disabledOffer);
    const output = createRecordedOutput();

    await runPairCommand({ json: true }, { resolveOffer, isInteractive: () => true, output });

    expect(resolveOffer).toHaveBeenCalledWith({ jagentdeskHome: expect.any(String) });
    expect(output.stderr.join("")).toContain('"code":"NO_PAIRING_TRANSPORT"');
    expect(output.exitCode).toBe(1);
  });

  test("enabled offer prints the pairing instructions", async () => {
    const resolveOffer = vi.fn(async () => enabledOffer);
    const output = createRecordedOutput();

    await runPairCommand({}, { resolveOffer, isInteractive: () => true, output });

    expect(output.stdout.join("")).toContain(enabledOffer.url ?? "");
    expect(output.exitCode).toBeUndefined();
  });

  test("enabled offer in JSON mode outputs the structured pairing", async () => {
    const resolveOffer = vi.fn(async () => enabledOffer);
    const output = createRecordedOutput();

    await runPairCommand({ json: true }, { resolveOffer, isInteractive: () => true, output });

    expect(output.stdout.join("")).toContain('"tailnetEnabled": true');
    expect(output.stdout.join("")).toContain(enabledOffer.url ?? "");
    expect(output.exitCode).toBeUndefined();
  });
  test("prints a relay-only pairing offer when Tailscale is down", async () => {
    const offer = { ...enabledOffer, tailnetEnabled: false, relayEnabled: true };
    const output = createRecordedOutput();
    await runPairCommand(
      { json: true },
      { resolveOffer: async () => offer, isInteractive: () => false, output },
    );
    expect(output.exitCode).toBeUndefined();
    expect(JSON.parse(output.stdout.join(""))).toEqual(offer);
  });
});
