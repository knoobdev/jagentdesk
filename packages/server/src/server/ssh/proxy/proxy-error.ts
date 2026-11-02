export type ProxyErrorCode = "proxy_unreachable" | "proxy_auth_failed" | "proxy_refused";

/**
 * Failure while tunnelling TCP through a proxy (spec 25.2 `SshServer.proxy`, 25.3 step 2).
 * `code` is the machine-readable fact for UI and RPC errors; `message` is a log/debug string.
 * Never include credentials in either.
 */
export class ProxyError extends Error {
  constructor(
    public readonly code: ProxyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}
