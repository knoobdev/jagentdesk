import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_IDS } from "@jagentdesk/protocol/builtin-plugins";
import { PluginRuntime } from "./runtime.js";

const pluginsRoot = fileURLToPath(new URL("../../../../../plugins/", import.meta.url));
const usageSourcePlugins = BUNDLED_PLUGIN_IDS.filter((id) => id.endsWith("-usage-source"));

// Answers the plugin's session hello the way the daemon does, so the plugin finishes starting.
const runtime = new PluginRuntime(pino({ level: "silent" }), "0.12.2", {
  sessionHost: {
    async attachPluginSocket(_pluginId, socket) {
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.on("message", (data) => {
        if (typeof data !== "string" || JSON.parse(data).type !== "hello") return;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "usage-icons",
                hostname: "usage-icons",
                version: "0.12.2",
                features: {},
              },
            },
          }),
        );
      });
      return { closed };
    },
  },
});

afterAll(() => runtime.stopAll());

describe("bundled usage source icons", () => {
  it("covers every bundled usage source plugin", () => {
    expect(usageSourcePlugins.length).toBeGreaterThanOrEqual(10);
  });

  // The sidebar summary, Usage cards, and options draw this SVG; without it they fall back to a
  // generic gauge that reads as a cut-off icon.
  it.each(usageSourcePlugins)("%s registers its own icon file's SVG", async (id) => {
    const directory = path.join(pluginsRoot, id);
    await runtime.startBuiltinPlugin({ id, directory });
    const [source, ...rest] = runtime.getUsageSourceRegistrations(id);
    expect(rest).toEqual([]);
    expect(source?.icon).toBe(await readFile(path.join(directory, "icon.svg"), "utf8"));
  });
});
