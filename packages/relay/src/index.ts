export type { ConnectionRole, RelayAuthState, RelaySessionAttachment } from "./types.js";

export {
  relayChallengeMessage,
  encodeRelayChallenge,
  encodeRelayAuth,
  encodeRelayAuthOk,
  parseRelayChallenge,
  parseRelayAuth,
  bytesToBase64Url,
  base64UrlToBytes,
  RELAY_OWNERSHIP_SIGNATURE_CONTEXT,
  RELAY_CHALLENGE_NONCE_BYTES,
  RELAY_ED25519_PUBLIC_KEY_BYTES,
} from "./ownership.js";
export type { RelayChallengeFrame, RelayAuthFrame, RelayAuthOkFrame } from "./ownership.js";

export {
  MAX_RELAY_WEBSOCKET_MESSAGE_BYTES,
  MAX_RELAY_CLIENTS_PER_SERVER,
  MAX_RELAY_CONNECTS_PER_IP_PER_MINUTE,
  MAX_RELAY_BUFFERED_FRAMES_PER_CONNECTION,
  MAX_RELAY_BUFFERED_BYTES_PER_CONNECTION,
  RELAY_OWNERSHIP_CHALLENGE_TIMEOUT_MS,
  RELAY_IDLE_SOCKET_TIMEOUT_MS,
  RELAY_CLOSE_FRAME_TOO_LARGE,
  RELAY_CLOSE_CHALLENGE_TIMEOUT,
  RELAY_CLOSE_OWNERSHIP_MISMATCH,
  RELAY_CLOSE_TOO_MANY_CLIENTS,
  RELAY_CLOSE_BUFFER_OVERFLOW,
} from "./limits.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedKey,
  encrypt,
  decrypt,
} from "./crypto.js";

export {
  base64EncryptedWireByteLength,
  createClientChannel,
  createDaemonChannel,
  EncryptedChannel,
  maxBase64EncryptedPlaintextByteLength,
} from "./encrypted-channel.js";
export { maxSecuredPlaintextByteLength } from "./secure-channel.js";
export type { Transport, EncryptedChannelEvents } from "./encrypted-channel.js";
