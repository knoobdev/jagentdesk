import { Boxes } from "lucide-react-native";
import { z } from "zod";
import { expect, test } from "vitest";
import { BuiltinClientRegistry } from "./host";
import type { BuiltinDestination } from "./host";

test("all contribution kinds hide and restore together for the selected host", () => {
  const registry = new BuiltinClientRegistry();
  const host = registry.forPlugin("docker");
  const Component = () => null;
  const destination: BuiltinDestination = {
    id: "docker",
    title: "Docker",
    icon: Boxes,
    group: "Tools",
    route: (id) => `/h/${id}/docker`,
    routeSegment: "docker",
  };
  host.sidebarDestination(destination);
  host.mobileDrawerEntry(destination);
  host.leftPanel("docker", Component);
  host.screen("docker", Component);
  host.settingsSection("docker", Component);
  host.composerItem("docker", Component);
  host.timelineRenderer("docker", Component);
  const source = {
    id: "container",
    title: "Container",
    icon: "box",
    pickerTitle: "Containers",
    searchPlaceholder: "Search",
    search: { name: "docker.search", input: z.unknown(), output: z.unknown() },
  };
  host.attachmentSource(source, async () => ({ items: [] }));
  const info = (docker: boolean) => ({
    serverId: "one",
    hostname: null,
    version: "0.9.59",
    features: { builtinPlugins: true, docker },
  });
  expect(registry.visible(info(false)).size).toBe(0);
  const entries = registry.visible(info(true)).get("docker")!;
  expect(entries.destinations).toEqual([destination]);
  expect(entries.mobileEntries).toEqual([destination]);
  expect(entries.panels.get("docker")).toBe(Component);
  expect(entries.screens.get("docker")).toBe(Component);
  expect(entries.settings.get("docker")).toBe(Component);
  expect(entries.composer.get("docker")).toBe(Component);
  expect(entries.timeline.get("docker")).toBe(Component);
  expect(entries.attachments[0]?.source).toBe(source);
  expect(registry.owner("docker")).toBe("docker");
  expect(registry.visible(info(false)).size).toBe(0);
  expect(registry.visible(info(true)).get("docker")).toBe(entries);
});
