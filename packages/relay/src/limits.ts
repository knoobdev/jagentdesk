/**
 * Relay enforcement limits and close codes (spec 35.2).
 *
 * Kept out of cloudflare-adapter.ts: the Worker entry module may only export
 * functions/handlers/Durable Object classes, so value exports live here.
 * Daemons and tooling import these to assert against deployed behavior.
 */

/** Maximum size of one WebSocket frame; violations close with 4009. */
export const MAX_RELAY_WEBSOCKET_MESSAGE_BYTES = 32 * 1024 * 1024;

/** Concurrent client sockets per serverId; the 17th is closed with 4429. */
export const MAX_RELAY_CLIENTS_PER_SERVER = 16;

/** WebSocket connect attempts per IP per minute; excess gets HTTP 429. */
export const MAX_RELAY_CONNECTS_PER_IP_PER_MINUTE = 60;

/** Buffered client frames awaiting a daemon data socket, per connectionId. */
export const MAX_RELAY_BUFFERED_FRAMES_PER_CONNECTION = 256;

/** Byte budget for the same buffer; overflow closes clients with 4413. */
export const MAX_RELAY_BUFFERED_BYTES_PER_CONNECTION = 32 * 1024 * 1024;

/** A server socket that has not answered the ownership challenge is closed with 4401. */
export const RELAY_OWNERSHIP_CHALLENGE_TIMEOUT_MS = 10_000;

/** A socket with no frames for this long is closed. The daemon control socket pings every 30 s. */
export const RELAY_IDLE_SOCKET_TIMEOUT_MS = 10 * 60_000;

export const RELAY_CLOSE_FRAME_TOO_LARGE = 4009;
export const RELAY_CLOSE_CHALLENGE_TIMEOUT = 4401;
export const RELAY_CLOSE_OWNERSHIP_MISMATCH = 4403;
export const RELAY_CLOSE_TOO_MANY_CLIENTS = 4429;
export const RELAY_CLOSE_BUFFER_OVERFLOW = 4413;
