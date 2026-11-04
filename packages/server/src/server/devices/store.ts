import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

// $JAGENTDESK_HOME/devices/physical.json (spec 27.3): per-device control switch and, for iPhones,
// the WebDriverAgent install that Prepare device left behind. Nothing secret lives here.

const WdaInstallSchema = z.object({
  bundleId: z.string(),
  accountId: z.string(),
  expiresAt_ms: z.number(),
  installedAt_ms: z.number(),
});
export type WdaInstall = z.infer<typeof WdaInstallSchema>;

const DeviceEntrySchema = z.object({
  controlEnabled: z.boolean(),
  updatedAt_ms: z.number(),
  wda: WdaInstallSchema.nullable(),
});
type DeviceEntry = z.infer<typeof DeviceEntrySchema>;

const StoreFileSchema = z.object({
  version: z.literal(1),
  devices: z.record(z.string(), DeviceEntrySchema),
});
type StoreFile = z.infer<typeof StoreFileSchema>;

export class PhysicalDeviceStore {
  private data: StoreFile = { version: 1, devices: {} };
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(jagentdeskHome: string) {
    this.file = path.join(jagentdeskHome, "devices", "physical.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.data = StoreFileSchema.parse(JSON.parse(raw));
  }

  isControlEnabled(udid: string): boolean {
    return this.data.devices[udid]?.controlEnabled ?? false;
  }

  wda(udid: string): WdaInstall | null {
    return this.data.devices[udid]?.wda ?? null;
  }

  setControlEnabled(udid: string, controlEnabled: boolean, now_ms: number): Promise<void> {
    const current = this.entry(udid);
    this.data.devices[udid] = { ...current, controlEnabled, updatedAt_ms: now_ms };
    return this.save();
  }

  setWda(udid: string, wda: WdaInstall, now_ms: number): Promise<void> {
    const current = this.entry(udid);
    this.data.devices[udid] = { ...current, wda, updatedAt_ms: now_ms };
    return this.save();
  }

  private entry(udid: string): DeviceEntry {
    return this.data.devices[udid] ?? { controlEnabled: false, updatedAt_ms: 0, wda: null };
  }

  private save(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.writing = this.writing.then(() => writeJsonFileAtomic(this.file, snapshot));
    return this.writing;
  }
}
