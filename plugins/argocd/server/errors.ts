import type { ArgoCdErrorCode } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { ArgoCdApiError, ArgoCdTlsError, ArgoCdUnreachableError } from "./http.js";

/** A failure the app shows as-is: `message` is user-facing, `code` is what the UI branches on. */
export class ArgoCdError extends Error {
  constructor(
    readonly code: ArgoCdErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArgoCdError";
  }
}

// grpc codes from the grpc-gateway error body (google.golang.org/grpc/codes).
const GRPC_NOT_FOUND = 5;
const GRPC_PERMISSION_DENIED = 7;
const GRPC_FAILED_PRECONDITION = 9;
const GRPC_UNAUTHENTICATED = 16;

export function toArgoCdError(error: unknown): ArgoCdError {
  if (error instanceof ArgoCdError) return error;
  if (error instanceof ArgoCdTlsError) return new ArgoCdError("tls_untrusted", error.message);
  if (error instanceof ArgoCdUnreachableError) return new ArgoCdError("unreachable", error.message);
  if (error instanceof ArgoCdApiError) {
    if (error.status === 401 || error.grpcCode === GRPC_UNAUTHENTICATED) {
      return new ArgoCdError("unauthenticated", error.message);
    }
    if (error.status === 403 || error.grpcCode === GRPC_PERMISSION_DENIED) {
      return new ArgoCdError("forbidden", error.message);
    }
    if (error.status === 404 || error.grpcCode === GRPC_NOT_FOUND) {
      return new ArgoCdError("not_found", error.message);
    }
    if (error.grpcCode === GRPC_FAILED_PRECONDITION) {
      return new ArgoCdError("conflict", error.message);
    }
    return new ArgoCdError("argocd_error", error.message);
  }
  return new ArgoCdError("argocd_error", error instanceof Error ? error.message : String(error));
}
