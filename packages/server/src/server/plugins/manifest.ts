import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginIdSchema } from "@jagentdesk/protocol/messages";

const MANIFEST_FILENAME = "jagentdesk-plugin.json";
const PluginBuildCommandSchema = z
  .array(z.string().refine((argument) => argument.trim().length > 0))
  .min(1);
const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    build: z.array(PluginBuildCommandSchema).min(1).optional(),
    // A host-version gate the plugin declares (e.g. { jagentdesk: ">=0.9.0" }). Preserved
    // when a Paseo plugin is rebranded on install so the marketplace can report it.
    requirements: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Plugin manifest is missing: ${manifestPath}`);
  return PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}
