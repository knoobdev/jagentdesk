/**
 * Relay connection types and interfaces.
 *
 * The relay bridges two WebSocket connections:
 * - Server (daemon): The JAgentDesk server connecting to the relay
 * - Client (app): The mobile/web app connecting to the relay
 *
 * Messages are forwarded bidirectionally without modification once the server
 * socket has passed the ownership challenge (see ownership.ts, spec 35.2).
 */

export type ConnectionRole = "server" | "client";

/**
 * Ownership-challenge state of a socket. Server sockets start "pending" and
 * may only exchange traffic after the relay sends `relay_auth_ok` ("ok").
 * Client sockets are "ok" immediately; they prove nothing to the relay
 * (daemon authenticity comes from the Noise handshake).
 */
export type RelayAuthState = "pending" | "ok";

export interface RelaySessionAttachment {
  serverId: string;
  role: ConnectionRole;
  /**
   * Relay protocol version carried by this socket. v1 is dropped (spec 35.2);
   * v2 = control + per-client data sockets.
   */
  version: "2";
  /**
   * Unique id for the connection. Allows the daemon to create an
   * independent socket + E2EE channel per connected connection.
   */
  connectionId?: string | null;
  createdAt: number;
  /** Unix ms of the last inbound frame; drives the 10-minute idle close. */
  lastActivityAt: number;
  authState: RelayAuthState;
  /** Challenge nonce (base64url). Present only while a server socket is pending. */
  authNonce?: string;
  /** Unix ms after which an unanswered challenge closes the socket with 4401. */
  authDeadlineAt?: number;
}
