import { expect, it } from "vitest";
import { z } from "zod";
import {
  BUILTIN_PLUGIN_MANIFESTS,
  STATIC_BUILTIN_PLUGIN_IDS,
  builtinPluginWireState,
  mergeBuiltinPluginWireState,
} from "./builtin-plugins.js";
it("lets the original client parse its feature list while new clients see the same unified built-in inventory", () => {
  const entries = BUILTIN_PLUGIN_MANIFESTS.map((manifest) => ({
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    defaultEnabled: manifest.defaultEnabled,
    requires: [...manifest.requires],
    enabled: manifest.defaultEnabled,
    available: true,
  }));
  const wire = builtinPluginWireState(entries);
  const oldList = z.object({
    plugins: z.array(z.object({ id: z.enum(STATIC_BUILTIN_PLUGIN_IDS) })),
  });
  expect(oldList.parse(wire).plugins.map((entry) => entry.id)).toEqual(STATIC_BUILTIN_PLUGIN_IDS);
  expect(mergeBuiltinPluginWireState(wire).map((entry) => entry.id)).toEqual([
    ...STATIC_BUILTIN_PLUGIN_IDS,
    ...entries
      .filter((entry) => !(STATIC_BUILTIN_PLUGIN_IDS as readonly string[]).includes(entry.id))
      .map((entry) => entry.id),
  ]);
});
