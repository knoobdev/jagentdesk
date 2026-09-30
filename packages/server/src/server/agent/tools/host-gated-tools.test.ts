import { afterEach, expect, test, vi } from "vitest";
import { createJAgentDeskToolCatalog } from "./jagentdesk-tools.js";
import type { JAgentDeskToolHostDependencies } from "./jagentdesk-tools.js";

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => setPlatform(realPlatform));

function catalog() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "debug",
  } as unknown as JAgentDeskToolHostDependencies["logger"];
  return createJAgentDeskToolCatalog({
    agentManager: vi.fn() as unknown as JAgentDeskToolHostDependencies["agentManager"],
    agentStorage: vi.fn() as unknown as JAgentDeskToolHostDependencies["agentStorage"],
    providerSnapshotManager:
      vi.fn() as unknown as JAgentDeskToolHostDependencies["providerSnapshotManager"],
    logger,
  });
}

test("a Windows host gets no iOS simulator, system-proxy or Frida tools (spec 24.5)", () => {
  setPlatform("win32");
  const tools = catalog();
  expect(tools.getTool("sim_list")).toBeUndefined();
  expect(tools.getTool("proxy_frida_unpin")).toBeUndefined();
  expect(tools.getTool("proxy_ca_install_sim")).toBeUndefined();
  expect(tools.getTool("sim_install_batch")).toBeUndefined();
  // Manual capture works on every host.
  expect(tools.getTool("proxy_capture_start")).toBeDefined();
  expect(tools.getTool("docker_ps")).toBeDefined();
});

test("a macOS host keeps simulator and Frida tools", () => {
  setPlatform("darwin");
  const tools = catalog();
  expect(tools.getTool("sim_list")).toBeDefined();
  expect(tools.getTool("proxy_frida_unpin")).toBeDefined();
});
