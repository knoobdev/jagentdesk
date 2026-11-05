import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";
import { SETTINGS_FILE } from "./protocol.js";

const SettingsFileSchema = z.object({
  runScriptEnabled: z.boolean().default(false),
});

export type FigmaLinkSettings = z.infer<typeof SettingsFileSchema>;

/**
 * `run_script` has no plugin implementation yet (spec 32 — "no plugin
 * implementation until the follow-up"), so it is refused by default and can be
 * switched on per install for the experimental flag. The setting itself is not
 * a secret, so it persists next to the pairing records, not in the SecretStore.
 */
export class FigmaLinkSettingsStore {
  private settings: FigmaLinkSettings = { runScriptEnabled: false };
  private loaded = false;

  constructor(private readonly dataDir: string) {}

  async load(): Promise<this> {
    if (this.loaded) return this;
    this.loaded = true;
    const file = this.file();
    if (existsSync(file)) {
      try {
        const parsed = SettingsFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success) this.settings = parsed.data;
      } catch {
        // corrupted file — keep defaults, the next save rewrites it
      }
    }
    return this;
  }

  get runScriptEnabled(): boolean {
    return this.settings.runScriptEnabled;
  }

  async save(): Promise<void> {
    ensurePrivateDirectory(path.dirname(this.file()));
    writePrivateFileAtomicSync(this.file(), JSON.stringify(this.settings, null, 2));
  }

  async setRunScriptEnabled(enabled: boolean): Promise<void> {
    await this.load();
    this.settings = { ...this.settings, runScriptEnabled: enabled };
    await this.save();
  }

  private file(): string {
    return path.join(this.dataDir, SETTINGS_FILE);
  }
}
