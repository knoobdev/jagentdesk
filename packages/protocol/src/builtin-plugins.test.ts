import { expect, it } from "vitest";
import { z } from "zod";
import {
  BUILTIN_PLUGIN_MANIFESTS,
  BuiltinPluginListResponseSchema,
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

it("parses an older daemon's list that still names the removed Figma and Activity graph built-ins", () => {
  const item = (id: string) => ({
    id,
    name: id,
    description: "",
    enabled: true,
    defaultEnabled: true,
    requires: [],
    available: true,
  });
  const response = BuiltinPluginListResponseSchema.parse({
    type: "plugins.builtin.list.response",
    payload: { requestId: "r1", plugins: [item("docker"), item("figma"), item("activity-graph")] },
  });
  expect(mergeBuiltinPluginWireState(response.payload).map((entry) => entry.id)).toEqual([
    "docker",
  ]);
});
