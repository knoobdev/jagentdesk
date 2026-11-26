/**
 * The provider no longer has the permission request the user answered: it was answered
 * elsewhere, cancelled with its turn, or lost when the provider's server restarted. The
 * request can never be answered, so its card must be dropped instead of retried.
 */
export class PermissionNotPendingError extends Error {
  readonly name = "PermissionNotPendingError";

  constructor(
    readonly requestId: string,
    options?: { cause?: unknown },
  ) {
    super("This request is no longer pending", options);
  }
}
