import { describe, expect, it } from "vitest";
import { FIGMA_REQUEST_TYPES } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  requiredPermissionForInbound,
  requiredPermissionForOutbound,
} from "./operation-permissions.js";

// The permission maps are default-deny: a figma RPC missing from them is refused for every
// principal, so registration in `FigmaRequestSchemas` and here must never drift apart.
// ADR-0037 pins `figma.file.playback.request|response` to `workspace.read`.

type InboundOperation = Parameters<typeof requiredPermissionForInbound>[0];
type OutboundOperation = Parameters<typeof requiredPermissionForOutbound>[0];

describe("figma operation permissions", () => {
  it("grants the playback RPC both directions as workspace.read", () => {
    expect(requiredPermissionForInbound("figma.file.playback.request" as InboundOperation)).toBe(
      "workspace.read",
    );
    expect(requiredPermissionForOutbound("figma.file.playback.response" as OutboundOperation)).toBe(
      "workspace.read",
    );
  });

  it("leaves the legacy prototype RPC at workspace.read", () => {
    expect(requiredPermissionForInbound("figma.file.prototype.request" as InboundOperation)).toBe(
      "workspace.read",
    );
    expect(
      requiredPermissionForOutbound("figma.file.prototype.response" as OutboundOperation),
    ).toBe("workspace.read");
  });

  it("maps every registered figma request type and its paired response to a permission", () => {
    const unpaired = FIGMA_REQUEST_TYPES.filter(
      (type) =>
        typeof requiredPermissionForInbound(type as InboundOperation) !== "string" ||
        typeof requiredPermissionForOutbound(
          type.replace(/\.request$/, ".response") as OutboundOperation,
        ) !== "string",
    );

    expect(unpaired).toEqual([]);
  });
});
