import { useCallback } from "react";
import type {
  FigmaError,
  FigmaRequestParams,
  FigmaRequestType,
  FigmaResponseData,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

// The app's door to the figma.* RPCs (spec 32). A Figma-side failure comes back as
// `payload.error`; this turns it into a thrown FigmaRpcError so React Query and mutations see it.

export class FigmaRpcError extends Error {
  readonly code: string;

  constructor(error: FigmaError) {
    super(error.message);
    this.name = "FigmaRpcError";
    this.code = error.code;
  }
}

export class FigmaHostOfflineError extends Error {
  constructor() {
    super("The host is offline.");
    this.name = "FigmaHostOfflineError";
  }
}

export type FigmaCall = <T extends FigmaRequestType>(
  type: T,
  params: FigmaRequestParams<T>,
) => Promise<FigmaResponseData<T>>;

export async function callFigma<T extends FigmaRequestType>(
  client: DaemonClient | null,
  type: T,
  params: FigmaRequestParams<T>,
): Promise<FigmaResponseData<T>> {
  if (!client) throw new FigmaHostOfflineError();
  const payload = await client.figmaRequest(type, params);
  const { requestId: _requestId, error, ...data } = payload;
  if (error) throw new FigmaRpcError(error);
  return data as FigmaResponseData<T>;
}

export function useFigmaCall(serverId: string): FigmaCall {
  const client = useHostRuntimeClient(serverId);
  return useCallback(
    <T extends FigmaRequestType>(type: T, params: FigmaRequestParams<T>) =>
      callFigma(client, type, params),
    [client],
  );
}

export const figmaKeys = {
  all: (serverId: string) => ["figma", serverId] as const,
  file: (serverId: string, fileKey: string, version: string | null) =>
    ["figma", serverId, "file", fileKey, version] as const,
  prototype: (serverId: string, fileKey: string, version: string | null) =>
    ["figma", serverId, "file", fileKey, version, "prototype"] as const,
  node: (serverId: string, fileKey: string, version: string | null, nodeId: string) =>
    ["figma", serverId, "file", fileKey, version, "node", nodeId] as const,
  comments: (serverId: string, fileKey: string, version: string | null) =>
    ["figma", serverId, "file", fileKey, version, "comments"] as const,
  versions: (serverId: string, fileKey: string) =>
    ["figma", serverId, "file", fileKey, "versions"] as const,
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
