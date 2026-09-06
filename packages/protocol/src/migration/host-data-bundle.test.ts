import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import {
  HOST_DATA_BUNDLE_VERSION,
  HostDataBundleSchema,
  type HostDataBundle,
} from "./host-data-bundle.js";

function makeBundle(): HostDataBundle {
  return {
    version: HOST_DATA_BUNDLE_VERSION,
    sourceServerId: "srv_source",
    sourceHostLabel: "node-1",
    sourceHome: "/home/user",
    exportedAt_ms: 1_700_000_000_000,
    projects: [{ projectId: "proj_1" }],
    workspaces: [{ workspaceId: "ws_1" }],
    agents: [
      {
        oldAgentId: "agent_old",
        provider: "claude",
        record: { id: "agent_old" },
        usageTotals: null,
        historyPortable: false,
        historyBlobRef: null,
      },
    ],
    historyBlobs: {},
  };
}

describe("HostDataBundle schema", () => {
  it("round-trips a bundle", () => {
    const parsed = HostDataBundleSchema.parse(makeBundle());
    expect(parsed.sourceServerId).toBe("srv_source");
    expect(parsed.agents[0].historyPortable).toBe(false);
  });

  it("accepts the export/import request messages on the inbound union", () => {
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "export_host_data_request",
        requestId: "r1",
      }),
    ).not.toThrow();
    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "import_host_data_request",
        requestId: "r2",
        bundle: makeBundle(),
      }),
    ).not.toThrow();
  });

  it("accepts the export/import response messages on the outbound union", () => {
    expect(() =>
      SessionOutboundMessageSchema.parse({
        type: "export_host_data_response",
        payload: { requestId: "r1", bundle: makeBundle(), error: null },
      }),
    ).not.toThrow();
    expect(() =>
      SessionOutboundMessageSchema.parse({
        type: "import_host_data_response",
        payload: {
          requestId: "r2",
          result: {
            sourceServerId: "srv_source",
            targetServerId: "srv_target",
            sourceHostLabel: "node-1",
            idMap: { agent_old: "agent_new" },
            workspaceIdMap: { ws_1: "ws_1" },
            agents: [
              { oldAgentId: "agent_old", newAgentId: "agent_new", historyMaterialized: false },
            ],
            importedAgentCount: 1,
            importedProjectCount: 1,
            importedWorkspaceCount: 1,
            historyMaterializedCount: 0,
            historyUnavailableCount: 0,
          },
          error: null,
        },
      }),
    ).not.toThrow();
  });
});
