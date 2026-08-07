import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { createPairedDeviceStore, type PairedDeviceStore } from "./paired-devices.js";
import { exportDevicePublicKey, generateDeviceKeyPair } from "./device-signature-crypto.js";
import { PRIVATE_FILE_MODE } from "../private-files.js";

const MODE_MASK = 0o777;

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "jagentdesk-paired-devices-"));
}

function makePublicKeyB64(): string {
  return exportDevicePublicKey(generateDeviceKeyPair().publicKey);
}

function createStore(home: string, generateId?: () => string): PairedDeviceStore {
  return createPairedDeviceStore({ jagentdeskHome: home, generateId });
}

describe("paired devices store", () => {
  test("register, list, getById, getByPublicKey, isPaired", () => {
    const home = createTempHome();
    try {
      const store = createStore(home);
      const publicKeyB64 = makePublicKeyB64();
      const device = store.register({
        devicePublicKeyB64: publicKeyB64,
        deviceName: "iPhone",
      });

      expect(device.deviceId).toBeTruthy();
      expect(device.devicePublicKeyB64).toBe(publicKeyB64);
      expect(device.deviceName).toBe("iPhone");
      expect(device.pairedAtMs).toBeGreaterThan(0);

      expect(store.list()).toEqual([device]);
      expect(store.getById(device.deviceId)).toEqual(device);
      expect(store.getById("missing-id")).toBeNull();
      expect(store.getByPublicKey(publicKeyB64)).toEqual(device);
      expect(store.getByPublicKey(makePublicKeyB64())).toBeNull();
      expect(store.isPaired(publicKeyB64)).toBe(true);
      expect(store.isPaired(makePublicKeyB64())).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("register without deviceName omits the field", () => {
    const home = createTempHome();
    try {
      const store = createStore(home);
      const device = store.register({ devicePublicKeyB64: makePublicKeyB64() });
      expect(device.deviceName).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("duplicate public key register throws", () => {
    const home = createTempHome();
    try {
      const store = createStore(home);
      const publicKeyB64 = makePublicKeyB64();
      store.register({ devicePublicKeyB64: publicKeyB64 });
      expect(() => store.register({ devicePublicKeyB64: publicKeyB64 })).toThrow(
        "Device already paired",
      );
      expect(store.list()).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("revokeById and revokeByPublicKey remove and report removal", () => {
    const home = createTempHome();
    try {
      const store = createStore(home);
      const first = store.register({ devicePublicKeyB64: makePublicKeyB64() });
      const second = store.register({ devicePublicKeyB64: makePublicKeyB64() });

      expect(store.revokeByPublicKey(first.devicePublicKeyB64)).toBe(true);
      expect(store.revokeByPublicKey(first.devicePublicKeyB64)).toBe(false);
      expect(store.list().map((d) => d.deviceId)).toEqual([second.deviceId]);

      expect(store.revokeById(second.deviceId)).toBe(true);
      expect(store.revokeById(second.deviceId)).toBe(false);
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("devices persist across store recreation", () => {
    const home = createTempHome();
    try {
      const generateId = (() => {
        let next = 0;
        return () => `device-${next++}`;
      })();
      const store = createStore(home, generateId);
      const device = store.register({ devicePublicKeyB64: makePublicKeyB64(), deviceName: "iPad" });

      const reloaded = createStore(home, generateId);
      expect(reloaded.list()).toEqual([device]);
      expect(reloaded.getById("device-0")?.deviceName).toBe("iPad");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("corrupt file is tolerated and starts empty", () => {
    const home = createTempHome();
    try {
      writeFileSync(path.join(home, "paired-devices.json"), "{ not valid json !!!", "utf8");
      const store = createStore(home);
      expect(store.list()).toEqual([]);
      const device = store.register({ devicePublicKeyB64: makePublicKeyB64() });
      expect(store.list()).toEqual([device]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("schema-mismatched file is tolerated and starts empty", () => {
    const home = createTempHome();
    try {
      writeFileSync(
        path.join(home, "paired-devices.json"),
        JSON.stringify({ v: 1, devices: [{ deviceId: 42 }] }),
        "utf8",
      );
      const store = createStore(home);
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("paired-devices.json is written with private permissions", () => {
    const home = createTempHome();
    try {
      const store = createStore(home);
      store.register({ devicePublicKeyB64: makePublicKeyB64() });

      const mode = statSync(path.join(home, "paired-devices.json")).mode & MODE_MASK;
      expect(mode).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
