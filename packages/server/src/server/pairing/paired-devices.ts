import { DeviceKindSchema } from "@jagentdesk/protocol/host-pairing";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import { samePublicKeyB64 } from "./device-signature-crypto.js";

export interface PairedDevice {
  deviceId: string;
  devicePublicKeyB64: string;
  deviceName?: string;
  pairedAtMs: number;
  tailnetNodeId?: string;
  kind?: "desktop" | "mobile" | "daemon";
  /** Last time a socket of this device opened or closed (spec 15.11.1 "Last active"). */
  lastSeenMs?: number;
}

/** A connection churning every few seconds must not rewrite the devices file every time. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

const PairedDeviceSchema = z.object({
  deviceId: z.string().min(1),
  devicePublicKeyB64: z.string().min(1),
  deviceName: z.string().optional(),
  pairedAtMs: z.number(),
  tailnetNodeId: z.string().optional(),
  kind: DeviceKindSchema.optional(),
  lastSeenMs: z.number().optional(),
});

const PairedDevicesFileSchema = z.object({
  v: z.literal(1),
  devices: z.array(PairedDeviceSchema),
});

const DEVICES_FILENAME = "paired-devices.json";

export interface PairedDeviceStore {
  list(): PairedDevice[];
  getByPublicKey(publicKeyB64: string): PairedDevice | null;
  getById(deviceId: string): PairedDevice | null;
  isPaired(publicKeyB64: string): boolean;
  register(input: {
    devicePublicKeyB64: string;
    deviceName?: string;
    tailnetNodeId?: string;
    kind?: "desktop" | "mobile" | "daemon";
  }): PairedDevice;
  revokeById(deviceId: string): boolean;
  revokeByPublicKey(publicKeyB64: string): boolean;
  markSeen(deviceId: string, atMs: number): void;
}

export function createPairedDeviceStore(args: {
  jagentdeskHome: string;
  logger?: pino.Logger;
  generateId?: () => string;
}): PairedDeviceStore {
  const log = args.logger?.child({ module: "paired-devices" });
  const filePath = path.join(args.jagentdeskHome, DEVICES_FILENAME);
  const generateId = args.generateId ?? randomUUID;
  const devices: PairedDevice[] = loadDevices(filePath, log);

  function persist(): void {
    const payload = { v: 1 as const, devices };
    writePrivateFileAtomicSync(filePath, JSON.stringify(payload, null, 2) + "\n");
  }

  function findIndexByPublicKey(publicKeyB64: string): number {
    return devices.findIndex((device) => samePublicKeyB64(device.devicePublicKeyB64, publicKeyB64));
  }

  return {
    list(): PairedDevice[] {
      return [...devices];
    },

    getByPublicKey(publicKeyB64: string): PairedDevice | null {
      const index = findIndexByPublicKey(publicKeyB64);
      return index === -1 ? null : devices[index];
    },

    getById(deviceId: string): PairedDevice | null {
      return devices.find((device) => device.deviceId === deviceId) ?? null;
    },

    isPaired(publicKeyB64: string): boolean {
      return findIndexByPublicKey(publicKeyB64) !== -1;
    },

    register(input: {
      devicePublicKeyB64: string;
      deviceName?: string;
      tailnetNodeId?: string;
      kind?: "desktop" | "mobile" | "daemon";
    }): PairedDevice {
      if (findIndexByPublicKey(input.devicePublicKeyB64) !== -1) {
        throw new Error("Device already paired");
      }
      const device: PairedDevice = {
        deviceId: generateId(),
        devicePublicKeyB64: input.devicePublicKeyB64,
        pairedAtMs: Date.now(),
        ...(input.tailnetNodeId ? { tailnetNodeId: input.tailnetNodeId } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      };
      if (input.deviceName !== undefined && input.deviceName !== "") {
        device.deviceName = input.deviceName;
      }
      devices.push(device);
      persist();
      return device;
    },

    revokeById(deviceId: string): boolean {
      const index = devices.findIndex((device) => device.deviceId === deviceId);
      if (index === -1) {
        return false;
      }
      devices.splice(index, 1);
      persist();
      return true;
    },

    markSeen(deviceId: string, atMs: number): void {
      const device = devices.find((candidate) => candidate.deviceId === deviceId);
      if (!device) return;
      if (device.lastSeenMs !== undefined && atMs - device.lastSeenMs < LAST_SEEN_WRITE_INTERVAL_MS)
        return;
      device.lastSeenMs = atMs;
      try {
        persist();
      } catch (error) {
        log?.warn({ err: error, deviceId }, "Failed to record paired device activity");
      }
    },

    revokeByPublicKey(publicKeyB64: string): boolean {
      const index = findIndexByPublicKey(publicKeyB64);
      if (index === -1) {
        return false;
      }
      devices.splice(index, 1);
      persist();
      return true;
    },
  };
}

function loadDevices(filePath: string, log?: pino.Logger): PairedDevice[] {
  if (!existsSync(filePath)) {
    return [];
  }
  try {
    ensurePrivateFile(filePath);
    const raw = readFileSync(filePath, "utf8");
    const parsed = PairedDevicesFileSchema.parse(JSON.parse(raw));
    return parsed.devices;
  } catch (error) {
    log?.warn({ err: error, filePath }, "Failed to load paired devices, starting empty");
    return [];
  }
}
