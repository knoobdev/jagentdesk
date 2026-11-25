import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { importPublicKey } from "@jagentdesk/relay";
import type { ConnectionOffer } from "@jagentdesk/protocol/connection-offer";
import {
  connectionsFromOffer,
  type HostConnection,
  type HostProfile,
} from "@/types/host-connection";

/**
 * The question shown before a pairing link adds a host that is not saved, or
 * changes the key, relay, or TLS setting of a saved one.
 */
export interface HostConfirmationRequest {
  /** Identifies this question, so an answer shown for it never answers a newer one. */
  id: number;
  serverId: string;
  /** Grouped daemon public key the user can compare with the one their daemon shows. */
  keyFingerprint: string;
  routes: string;
  previousRoutes: string | null;
  previousKeyFingerprint: string | null;
  keyChanged: boolean;
  kind: "newHost" | "changedConnection";
}

interface PendingConfirmation {
  request: HostConfirmationRequest;
  resolve: (approved: boolean) => void;
}

/**
 * Owns the one host confirmation the app is waiting on. The host runtime asks
 * through `confirmLink`; the view reads `getPending` and replies with `answer`.
 * A question waits until it is answered, whether or not a view is showing it.
 */
export class HostConfirmations {
  private pending: PendingConfirmation | null = null;
  private nextRequestId = 1;
  private listeners = new Set<() => void>();

  getPending(): HostConfirmationRequest | null {
    return this.pending?.request ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Answers the request with `requestId`; an answer for any other request is ignored. */
  answer(requestId: number, approved: boolean): void {
    const current = this.pending;
    if (!current || current.request.id !== requestId) return;
    this.pending = null;
    this.emit();
    current.resolve(approved);
  }

  /** Resolves true without asking when every offered route matches a saved host. */
  async confirmLink(
    offer: ConnectionOffer,
    savedHosts: HostProfile[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    if (this.pending) this.answer(this.pending.request.id, false);
    const id = this.nextRequestId++;
    const connections = connectionsFromOffer(offer);
    const savedHost = savedHosts.find((host) => host.serverId === offer.serverId);
    if (
      savedHost &&
      connections.every((connection) =>
        savedHost.connections.some((saved) => sameLinkedConnection(saved, connection)),
      )
    )
      return true;
    const savedConnections =
      savedHost?.connections.filter(
        (connection) => connection.type === "tailnet" || connection.type === "relay",
      ) ?? [];
    const previousKey = savedConnections[0]?.daemonPublicKeyB64;
    const [keyFingerprint, previousKeyFingerprint] = await Promise.all([
      formatDaemonKeyFingerprint(offer.daemonPublicKeyB64),
      previousKey ? formatDaemonKeyFingerprint(previousKey) : Promise.resolve(null),
    ]);
    // A newer link supersedes this one even while its fingerprint is being computed.
    if (signal?.aborted || id !== this.nextRequestId - 1) return false;
    const answer = this.ask({
      id,
      serverId: offer.serverId,
      keyFingerprint,
      routes: connections.map(describeRoute).join("\n"),
      previousRoutes: savedHost ? savedConnections.map(describeRoute).join("\n") : null,
      previousKeyFingerprint,
      keyChanged: savedConnections.some(
        (connection) => connection.daemonPublicKeyB64 !== offer.daemonPublicKeyB64,
      ),
      kind: savedHost ? "changedConnection" : "newHost",
    });
    const cancel = () => this.answer(id, false);
    signal?.addEventListener("abort", cancel, { once: true });
    return answer.finally(() => signal?.removeEventListener("abort", cancel));
  }

  private ask(request: HostConfirmationRequest): Promise<boolean> {
    // One question at a time: a newer one cancels the unanswered one.
    this.pending?.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pending = { request, resolve };
      this.emit();
    });
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function sameLinkedConnection(left: HostConnection, right: HostConnection): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "tailnet" && right.type === "tailnet") {
    return (
      left.tailnetAddress === right.tailnetAddress &&
      Boolean(left.useTls) === Boolean(right.useTls) &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64
    );
  }
  if (left.type === "relay" && right.type === "relay") {
    return (
      left.endpoint === right.endpoint &&
      (left.useTls ?? true) === (right.useTls ?? true) &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64
    );
  }
  return false;
}

function describeRoute(connection: HostConnection): string {
  if (connection.type === "tailnet")
    return `Tailscale: ${connection.useTls ? "wss" : "ws"}://${connection.tailnetAddress}`;
  if (connection.type === "relay")
    return `Relay: ${(connection.useTls ?? true) ? "wss" : "ws"}://${connection.endpoint}`;
  return connection.id;
}

export async function formatDaemonKeyFingerprint(key: string): Promise<string> {
  const hash = new Uint8Array(
    await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(importPublicKey(key))),
  );
  return Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .match(/.{4}/g)!
    .join(" ");
}
