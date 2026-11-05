import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MemorySecretStore } from "../../database/secret-store.js";
import { FigmaLinkPairingManager, generatePairingCode, keysMatch } from "./pairing.js";
import { pairingKeySecretName } from "./protocol.js";
import { describe, expect, it } from "vitest";

function makeManager(options: { now?: () => number; random?: () => Buffer } = {}) {
  const secrets = new MemorySecretStore();
  const manager = new FigmaLinkPairingManager({
    secrets,
    dataDir: mkdtempSync(path.join(tmpdir(), "jad-figma-pairing-")),
    now: options.now,
    codeTtlMs: 120_000,
    randomBytesFn: options.random,
  });
  return { manager, secrets };
}

describe("FigmaLinkPairingManager", () => {
  it("issues a six-digit code and grants a key on redemption", async () => {
    const { manager, secrets } = makeManager();
    const issued = manager.issueCode({
      pairingId: "p-1",
      name: "Design file",
      fileKey: "fk-1",
      fileName: "Design file",
    });
    expect(issued.code).toMatch(/^\d{6}$/);

    const granted = await manager.pair(issued.code);
    expect(granted).not.toBeNull();
    expect(granted?.pairingId).toBe("p-1");
    expect(granted?.pairingKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await secrets.get(pairingKeySecretName("p-1"))).toBe(granted?.pairingKey);
  });

  it("accepts the presented key and rejects a wrong one", async () => {
    const { manager } = makeManager();
    const issued = manager.issueCode({ pairingId: "p-1", name: "n", fileKey: "fk", fileName: "f" });
    const granted = await manager.pair(issued.code);
    expect(await manager.validate("p-1", granted?.pairingKey)).toBe(true);
    expect(await manager.validate("p-1", "deadbeef")).toBe(false);
    expect(await manager.validate("p-2", granted?.pairingKey)).toBe(false);
    expect(await manager.validate("p-1", undefined)).toBe(false);
  });

  it("refuses an expired code and never redeems it twice", async () => {
    let now = 1_000;
    const { manager } = makeManager({ now: () => now });
    const issued = manager.issueCode({ pairingId: "p-1", name: "n", fileKey: "fk", fileName: "f" });
    expect(await manager.pair(issued.code)).not.toBeNull();
    expect(await manager.pair(issued.code)).toBeNull(); // single-use

    const second = manager.issueCode({ pairingId: "p-2", name: "n", fileKey: "fk", fileName: "f" });
    now += 120_001;
    expect(await manager.pair(second.code)).toBeNull();
  });

  it("replaces the pending code for the same pairing id", async () => {
    const { manager } = makeManager();
    const first = manager.issueCode({ pairingId: "p-1", name: "n", fileKey: "fk", fileName: "f" });
    const second = manager.issueCode({ pairingId: "p-1", name: "n", fileKey: "fk", fileName: "f" });
    expect(await manager.pair(first.code)).toBeNull();
    expect(await manager.pair(second.code)).not.toBeNull();
  });

  it("revokes a pairing, clearing the record and its secret", async () => {
    const { manager, secrets } = makeManager();
    const issued = manager.issueCode({ pairingId: "p-1", name: "n", fileKey: "fk", fileName: "f" });
    await manager.pair(issued.code);
    await manager.revoke("p-1");
    expect(await manager.list()).toEqual([]);
    expect(await secrets.get(pairingKeySecretName("p-1"))).toBeNull();
    expect(await manager.validate("p-1", issued.code)).toBe(false);
  });

  it("generates uniform codes from injected entropy", () => {
    const code = generatePairingCode(() => Buffer.alloc(8, 199));
    expect(code).toBe("999999");
  });

  it("keysMatch compares in constant shape and tolerates nulls", () => {
    expect(keysMatch("abc", "abc")).toBe(true);
    expect(keysMatch("abc", "abd")).toBe(false);
    expect(keysMatch("abc", "abcd")).toBe(false);
    expect(keysMatch(null, "abc")).toBe(false);
    expect(keysMatch("abc", undefined)).toBe(false);
    expect(keysMatch(undefined, undefined)).toBe(false);
  });
});
