// Session entry point for `providers.custom.*` (spec 34.7). One handler per request, every request
// answered (also on error): CustomProviderError maps to `"<code>: <message>"` (the ssh.* /
// remote_exec.* error-string convention), anything else to `"internal: <message>"`. Error responses
// still carry the other payload fields with neutral values so the response schemas parse.
// Follows remote-exec/rpc.ts; the allowlist is the `providers.custom.` prefix.
import type { z } from "zod";
import {
  CustomProvidersDeleteRequestSchema,
  CustomProvidersDeleteResponseSchema,
  CustomProvidersListRequestSchema,
  CustomProvidersListResponseSchema,
  CustomProvidersSaveRequestSchema,
  CustomProvidersSaveResponseSchema,
  CustomProvidersTestRequestSchema,
  CustomProvidersTestResponseSchema,
  type ApiProviderRecord,
} from "@jagentdesk/protocol/custom-providers/rpc-schemas";
import { CustomProviderError, type CustomProviderService } from "./types.js";

// The protocol exports response schemas, not response type aliases.
type CustomProvidersListResponse = z.infer<typeof CustomProvidersListResponseSchema>;
type CustomProvidersSaveResponse = z.infer<typeof CustomProvidersSaveResponseSchema>;
type CustomProvidersDeleteResponse = z.infer<typeof CustomProvidersDeleteResponseSchema>;
type CustomProvidersTestResponse = z.infer<typeof CustomProvidersTestResponseSchema>;

export type CustomProvidersOutboundMessage =
  | CustomProvidersListResponse
  | CustomProvidersSaveResponse
  | CustomProvidersDeleteResponse
  | CustomProvidersTestResponse;

interface InboundMessage {
  type: string;
}

type Emit = (message: CustomProvidersOutboundMessage) => void;

const UNAVAILABLE = "internal: custom providers are unavailable";

export function formatCustomProviderError(error: unknown): string {
  if (error instanceof CustomProviderError) {
    return `${error.code}: ${error.message}`;
  }
  const text = error instanceof Error ? error.message : String(error);
  return `internal: ${text}`;
}

/**
 * Answers one request: the service's payload on success, otherwise the neutral payload plus the
 * mapped error string. `service` is null while the custom-provider engine is unavailable; requests
 * then get the UNAVAILABLE error instead of timing out silently.
 */
async function answer(
  emit: Emit,
  type: CustomProvidersOutboundMessage["type"],
  requestId: string,
  service: CustomProviderService | null,
  neutralPayload: () => Record<string, unknown>,
  run: (service: CustomProviderService) => Promise<Record<string, unknown>>,
): Promise<void> {
  if (!service) {
    emit({
      type,
      payload: { requestId, error: UNAVAILABLE, ...neutralPayload() },
    } as CustomProvidersOutboundMessage);
    return;
  }
  try {
    const payload = await run(service);
    emit({
      type,
      payload: { requestId, error: null, ...payload },
    } as CustomProvidersOutboundMessage);
  } catch (error) {
    emit({
      type,
      payload: { requestId, error: formatCustomProviderError(error), ...neutralPayload() },
    } as CustomProvidersOutboundMessage);
  }
}

/**
 * Handles one inbound session message. Returns false when the message is not a
 * `providers.custom.*` request (the session then tries its other dispatchers). A
 * `providers.custom.*` type with no handler also claims nothing.
 */
export async function handleCustomProvidersMessage(
  service: CustomProviderService | null,
  message: InboundMessage,
  emit: Emit,
): Promise<boolean> {
  if (!message.type.startsWith("providers.custom.")) return false;
  switch (message.type) {
    case "providers.custom.list.request": {
      const request = CustomProvidersListRequestSchema.parse(message);
      await answer(
        emit,
        "providers.custom.list.response",
        request.requestId,
        service,
        () => ({ providers: [], envProviders: [] }),
        (providers) =>
          providers.list().then(({ providers: list, envProviders }) => ({
            providers: list,
            envProviders,
          })),
      );
      return true;
    }
    case "providers.custom.save.request": {
      const request = CustomProvidersSaveRequestSchema.parse(message);
      await answer(
        emit,
        "providers.custom.save.response",
        request.requestId,
        service,
        () => ({ provider: null }),
        (providers) =>
          providers
            .save({
              mode: request.mode,
              provider: request.provider,
              ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
            })
            .then((provider: ApiProviderRecord) => ({ provider })),
      );
      return true;
    }
    case "providers.custom.delete.request": {
      const request = CustomProvidersDeleteRequestSchema.parse(message);
      await answer(
        emit,
        "providers.custom.delete.response",
        request.requestId,
        service,
        () => ({}),
        (providers) => providers.delete(request.id).then(() => ({})),
      );
      return true;
    }
    case "providers.custom.test.request": {
      const request = CustomProvidersTestRequestSchema.parse(message);
      await answer(
        emit,
        "providers.custom.test.response",
        request.requestId,
        service,
        () => ({ result: null }),
        (providers) =>
          providers
            .test({
              protocol: request.protocol,
              baseUrl: request.baseUrl,
              ...(request.via !== undefined ? { via: request.via } : {}),
              ...(request.sshServerId !== undefined ? { sshServerId: request.sshServerId } : {}),
              ...(request.apiKey !== undefined ? { apiKey: request.apiKey } : {}),
              ...(request.id !== undefined ? { id: request.id } : {}),
            })
            .then((result) => ({ result })),
      );
      return true;
    }
    default:
      // A providers.custom.* type with no handler (none today): claim nothing so the session's
      // other dispatchers still run.
      return false;
  }
}
