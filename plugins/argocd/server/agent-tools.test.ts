import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { createArgoCdAgentTools } from "./agent-tools.js";
import { ArgoCdService } from "./service.js";

const home = await mkdtemp(path.join(os.tmpdir(), "argocd-tools-"));
afterAll(() => rm(home, { recursive: true, force: true }));

describe("createArgoCdAgentTools", () => {
  it("offers exactly the tools of spec 30.4 with its permission table, and no delete-app tool", () => {
    const service = new ArgoCdService({
      jagentdeskHome: home,
      logger: pino({ level: "silent" }),
      clusters: null,
    });
    const tools = createArgoCdAgentTools({
      service,
      callerAgentId: "agt_1",
      defaultInstanceId: null,
      requestPermission: async () => ({ behavior: "deny", message: "test" }),
    });

    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.permission]))).toEqual({
      argocd_list_instances: "auto",
      argocd_list_apps: "auto",
      argocd_get_app: "auto",
      argocd_resource_tree: "auto",
      argocd_diff: "auto",
      argocd_manifests: "auto",
      argocd_events: "auto",
      argocd_logs: "auto",
      argocd_history: "auto",
      argocd_list_resource_actions: "auto",
      argocd_can_i: "auto",
      argocd_list_projects: "auto",
      argocd_list_appsets: "auto",
      argocd_list_clusters: "auto",
      argocd_list_repos: "auto",
      argocd_refresh: "ask_when_hard",
      argocd_sync: "ask",
      argocd_rollback: "ask",
      argocd_terminate_operation: "ask",
      argocd_resource_action: "ask",
      argocd_delete_resource: "ask",
    });
  });

  it("asks for an instanceId when the chat is not bound to one", async () => {
    const service = new ArgoCdService({
      jagentdeskHome: home,
      logger: pino({ level: "silent" }),
      clusters: null,
    });
    const listApps = createArgoCdAgentTools({
      service,
      callerAgentId: "agt_1",
      defaultInstanceId: null,
      requestPermission: async () => ({ behavior: "allow" }),
    }).find((tool) => tool.name === "argocd_list_apps")!;

    const result = await listApps.handler({}, {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^invalid_input: instanceId is required/);
  });
});
