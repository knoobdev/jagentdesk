import { useCallback } from "react";
import type {
  FigmaError,
  FigmaRequestParams,
  FigmaRequestType,
  FigmaResponseData,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

// The app's door to the figma.* RPCs (spec 32.9), mirroring jira/api.ts: a Figma-side failure
// comes back as `payload.error`, and this turns it into a thrown FigmaRpcError so React Query,
// mutations and the canvas all see one error shape. Rate-limit extras ride along for the banner.

export class FigmaRpcError extends Error {
  readonly code: string;
  readonly retryAt_ms: number | undefined;
  readonly planTier: string | undefined;
  readonly rateLimitType: string | undefined;
  readonly upgradeUrl: string | undefined;

  constructor(error: FigmaError) {
    super(error.message);
    this.name = "FigmaRpcError";
    this.code = error.code;
    this.retryAt_ms = error.retryAt_ms;
    this.planTier = error.planTier;
    this.rateLimitType = error.rateLimitType;
    this.upgradeUrl = error.upgradeUrl;
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
