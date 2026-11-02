import { z } from "zod";

// Wire schemas for SSH servers (spec 25, milestones S1 + S4). Mirrors docker/rpc-schemas.ts:
// every request carries a `type` literal + `requestId`; every response is
// `{ type, payload: { requestId, ...data, error } }`. New RPCs use dotted namespaces
// with direction suffixes (docs/rpc-namespacing.md).
//
// Secrets (passwords, private keys, passphrases, proxy passwords) never appear on any
// response or push. A secret travels once, client→daemon, on save/import/generate, then
// lives only in the daemon's FileSecretStore under `ssh.password.<id>`, `ssh.key.<id>`,
// `ssh.passphrase.<id>`, `ssh.proxy.<id>`. The wire exposes only booleans
// (`hasPassword`, `hasPassphrase`) and public material.

// ── DTO schemas ─────────────────────────────────────────────────────────

export const SshAuthMethodSchema = z.enum(["password", "key", "agent", "keyboard-interactive"]);
export type SshAuthMethod = z.infer<typeof SshAuthMethodSchema>;

// Live connect state for a saved server (aggregate over its open sessions).
export const SshServerStateSchema = z.enum([
  "disconnected",
  "connecting",
  "awaiting_hostkey",
  "awaiting_auth",
  "connected",
  "reconnecting",
  "error",
]);
export type SshServerState = z.infer<typeof SshServerStateSchema>;

export const SshProtocolSchema = z.enum(["ssh", "telnet"]);
export type SshProtocol = z.infer<typeof SshProtocolSchema>;

// Spec 25.3 step 2: TCP to the first hop goes through a SOCKS5 or HTTP CONNECT proxy.
// The proxy password is a secret (`ssh.proxy.<serverOrGroupId>`); only `hasPassword` is on the wire.
export const SshProxySchema = z.object({
  type: z.enum(["socks5", "http"]),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  hasPassword: z.boolean().optional(),
});
export type SshProxy = z.infer<typeof SshProxySchema>;

// Fields a group can carry and its servers inherit (spec 25.2: nearest ancestor per field).
const SshInheritableShape = {
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  identityId: z.string().optional(),
  authMethods: z.array(SshAuthMethodSchema).optional(),
  // Ordered server ids; each hop tunnels through the previous one (spec 25.3 step 2).
  jumpChain: z.array(z.string()).optional(),
  proxy: SshProxySchema.optional(),
  // Sent like OpenSSH SendEnv; the server only keeps names allowed by AcceptEnv.
  env: z.record(z.string(), z.string()).optional(),
  // Snippet id in snippets.json; its script runs once the shell opens.
  startupSnippetId: z.string().optional(),
  agentForwarding: z.boolean().optional(),
  keepaliveIntervalS: z.number().int().min(0).max(3600).optional(), // default 30, 0 = off
  autoReconnect: z.boolean().optional(), // default true
  theme: z.string().optional(),
  fontSize: z.number().int().min(6).max(48).optional(),
};

export const SshServerSchema = z.object({
  id: z.string(), // `srv_…`; empty on create — the daemon assigns the id
  label: z.string(),
  address: z.string(),
  groupId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  hasPassword: z.boolean().optional(), // true when ssh.password.<id> exists in the store
  forwardingRuleIds: z.array(z.string()).optional(),
  // Run the environment detection script after each connect (spec 25.10); default true. Off for
  // servers that allow one session only and for network gear.
  detectEnvironment: z.boolean().optional(),
  protocol: SshProtocolSchema.optional(), // default "ssh"
  createdAtMs: z.number().optional(),
  updatedAtMs: z.number().optional(),
  ...SshInheritableShape,
});
export type SshServer = z.infer<typeof SshServerSchema>;

// One open SSH terminal (spec 25.4). Lets clients restore tabs after the app reopens.
export const SshSessionInfoSchema = z.object({
  terminalId: z.string(),
  serverId: z.string(),
  state: SshServerStateSchema,
  createdAtMs: z.number(),
});
export type SshSessionInfo = z.infer<typeof SshSessionInfoSchema>;

export const SshServerInfoSchema = SshServerSchema.extend({
  state: SshServerStateSchema,
  lastError: z.string().optional(),
});
export type SshServerInfo = z.infer<typeof SshServerInfoSchema>;

export const SshGroupSchema = z.object({
  id: z.string(), // `grp_…`
  label: z.string(),
  parentId: z.string().optional(),
  ...SshInheritableShape,
});
export type SshGroup = z.infer<typeof SshGroupSchema>;

export const SshIdentitySchema = z.object({
  id: z.string(), // `idn_…`
  label: z.string(),
  username: z.string().optional(),
  keyId: z.string().optional(),
  hasPassword: z.boolean().optional(), // true when ssh.password.<id> exists in the store
});
export type SshIdentity = z.infer<typeof SshIdentitySchema>;

export const SshKeyTypeSchema = z.enum([
  "ed25519",
  "ecdsa-256",
  "ecdsa-384",
  "ecdsa-521",
  "rsa-2048",
  "rsa-3072",
  "rsa-4096",
]);
export type SshKeyType = z.infer<typeof SshKeyTypeSchema>;

// Public material only — the private key lives in the secret store.
export const SshKeySchema = z.object({
  id: z.string(), // `key_…`
  label: z.string(),
  type: SshKeyTypeSchema,
  publicKey: z.string(), // OpenSSH authorized_keys line
  fingerprintSha256: z.string(), // `SHA256:…`
  hasPassphrase: z.boolean(),
  certificate: z.string().optional(), // public certificate line, when imported
});
export type SshKey = z.infer<typeof SshKeySchema>;

export const SshKnownHostSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  keyType: z.string(), // wire name, e.g. "ssh-ed25519"
  publicKey: z.string(), // base64 wire blob
  fingerprintSha256: z.string(),
  addedAtMs: z.number(),
  lastSeenAtMs: z.number().optional(),
});
export type SshKnownHost = z.infer<typeof SshKnownHostSchema>;

export const SshTerminalSizeSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type SshTerminalSize = z.infer<typeof SshTerminalSizeSchema>;

// Prompt kinds relayed to clients during connect (spec 25.3 steps 3–4). Answers
// are never stored and never re-sent to other clients beyond the daemon.
export const SshAuthPromptKindSchema = z.enum(["password", "keyboard_interactive", "passphrase"]);
export type SshAuthPromptKind = z.infer<typeof SshAuthPromptKindSchema>;

export const SshAuthPromptItemSchema = z.object({
  prompt: z.string(),
  echo: z.boolean(), // false for passwords → client renders a secure field
});
export type SshAuthPromptItem = z.infer<typeof SshAuthPromptItemSchema>;

export const SshConnectionErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  storedFingerprint: z.string().optional(),
  receivedFingerprint: z.string().optional(),
  // host_key_mismatch: the key the server presented (public material), so the user can
  // replace the stored key with it via ssh.knownhosts.replace after verifying it.
  host: z.string().optional(),
  port: z.number().int().optional(),
  receivedKeyType: z.string().optional(),
  receivedPublicKey: z.string().optional(),
});
export type SshConnectionError = z.infer<typeof SshConnectionErrorSchema>;

// ── servers ──
export const SshServersListRequestSchema = z.object({
  type: z.literal("ssh.servers.list.request"),
  requestId: z.string(),
});
export const SshServersListResponseSchema = z.object({
  type: z.literal("ssh.servers.list.response"),
  payload: z.object({
    requestId: z.string(),
    servers: z.array(SshServerInfoSchema),
    groups: z.array(SshGroupSchema),
    identities: z.array(SshIdentitySchema),
    sessions: z.array(SshSessionInfoSchema),
    error: z.string().nullable(),
  }),
});
export const SshServersGetRequestSchema = z.object({
  type: z.literal("ssh.servers.get.request"),
  requestId: z.string(),
  id: z.string(),
});
export const SshServersGetResponseSchema = z.object({
  type: z.literal("ssh.servers.get.response"),
  payload: z.object({
    requestId: z.string(),
    server: SshServerInfoSchema.nullable(),
    error: z.string().nullable(),
  }),
});
// `password` / `proxyPassword`: undefined keeps the stored secret, "" deletes it,
// non-empty replaces it.
export const SshServersSaveRequestSchema = z.object({
  type: z.literal("ssh.servers.save.request"),
  requestId: z.string(),
  server: SshServerSchema,
  password: z.string().optional(),
  proxyPassword: z.string().optional(),
});
export const SshServersSaveResponseSchema = z.object({
  type: z.literal("ssh.servers.save.response"),
  payload: z.object({
    requestId: z.string(),
    server: SshServerInfoSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export const SshServersDeleteRequestSchema = z.object({
  type: z.literal("ssh.servers.delete.request"),
  requestId: z.string(),
  id: z.string(),
});
export const SshServersDeleteResponseSchema = z.object({
  type: z.literal("ssh.servers.delete.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});

// ── groups ──
export const SshGroupsListRequestSchema = z.object({
  type: z.literal("ssh.groups.list.request"),
  requestId: z.string(),
});
export const SshGroupsListResponseSchema = z.object({
  type: z.literal("ssh.groups.list.response"),
  payload: z.object({
    requestId: z.string(),
    groups: z.array(SshGroupSchema),
    error: z.string().nullable(),
  }),
});
export const SshGroupsGetRequestSchema = z.object({
  type: z.literal("ssh.groups.get.request"),
  requestId: z.string(),
  id: z.string(),
});
export const SshGroupsGetResponseSchema = z.object({
  type: z.literal("ssh.groups.get.response"),
  payload: z.object({
    requestId: z.string(),
    group: SshGroupSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export const SshGroupsSaveRequestSchema = z.object({
  type: z.literal("ssh.groups.save.request"),
  requestId: z.string(),
  group: SshGroupSchema,
  proxyPassword: z.string().optional(),
});
export const SshGroupsSaveResponseSchema = z.object({
  type: z.literal("ssh.groups.save.response"),
  payload: z.object({
    requestId: z.string(),
    group: SshGroupSchema.nullable(),
    error: z.string().nullable(),
  }),
});
// Deleting a group moves its servers and child groups to the deleted group's parent.
export const SshGroupsDeleteRequestSchema = z.object({
  type: z.literal("ssh.groups.delete.request"),
  requestId: z.string(),
  id: z.string(),
});
export const SshGroupsDeleteResponseSchema = z.object({
  type: z.literal("ssh.groups.delete.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});

// ── identities ──
export const SshIdentitiesListRequestSchema = z.object({
  type: z.literal("ssh.identities.list.request"),
  requestId: z.string(),
});
export const SshIdentitiesListResponseSchema = z.object({
  type: z.literal("ssh.identities.list.response"),
  payload: z.object({
    requestId: z.string(),
    identities: z.array(SshIdentitySchema),
    error: z.string().nullable(),
  }),
});
export const SshIdentitiesGetRequestSchema = z.object({
  type: z.literal("ssh.identities.get.request"),
  requestId: z.string(),
  id: z.string(),
});
export const SshIdentitiesGetResponseSchema = z.object({
  type: z.literal("ssh.identities.get.response"),
  payload: z.object({
    requestId: z.string(),
    identity: SshIdentitySchema.nullable(),
    error: z.string().nullable(),
  }),
});
export const SshIdentitiesSaveRequestSchema = z.object({
  type: z.literal("ssh.identities.save.request"),
  requestId: z.string(),
  identity: SshIdentitySchema,
  password: z.string().optional(),
});
export const SshIdentitiesSaveResponseSchema = z.object({
  type: z.literal("ssh.identities.save.response"),
  payload: z.object({
    requestId: z.string(),
    identity: SshIdentitySchema.nullable(),
    error: z.string().nullable(),
  }),
});
export const SshIdentitiesDeleteRequestSchema = z.object({
  type: z.literal("ssh.identities.delete.request"),
  requestId: z.string(),
  id: z.string(),
});
export const SshIdentitiesDeleteResponseSchema = z.object({
  type: z.literal("ssh.identities.delete.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});

// ── keys ──
export const SshKeysListRequestSchema = z.object({
  type: z.literal("ssh.keys.list.request"),
  requestId: z.string(),
});
export const SshKeysListResponseSchema = z.object({
  type: z.literal("ssh.keys.list.response"),
  payload: z.object({
    requestId: z.string(),
    keys: z.array(SshKeySchema),
    error: z.string().nullable(),
  }),
});
// The daemon generates the pair with ssh2, stores the private key (and passphrase,
// when given) in the secret store, and returns public metadata only.
export const SshKeysGenerateRequestSchema = z.object({
  type: z.literal("ssh.keys.generate.request"),
  requestId: z.string(),
  label: z.string(),
  keyType: SshKeyTypeSchema,
  passphrase: z.string().optional(),
});
export const SshKeysGenerateResponseSchema = z.object({
  type: z.literal("ssh.keys.generate.response"),
  payload: z.object({
    requestId: z.string(),
    key: SshKeySchema.nullable(),
    error: z.string().nullable(),
  }),
});
// `privateKey`: OpenSSH or PEM text as pasted by the user.
export const SshKeysImportRequestSchema = z.object({
  type: z.literal("ssh.keys.import.request"),
  requestId: z.string(),
  label: z.string(),
  privateKey: z.string(),
  passphrase: z.string().optional(),
  certificate: z.string().optional(),
});
export const SshKeysImportResponseSchema = z.object({
  type: z.literal("ssh.keys.import.response"),
  payload: z.object({
    requestId: z.string(),
    key: SshKeySchema.nullable(),
    error: z.string().nullable(),
  }),
});
export const SshKeysDeleteRequestSchema = z.object({
  type: z.literal("ssh.keys.delete.request"),
  requestId: z.string(),
  id: z.string(),
});
export const SshKeysDeleteResponseSchema = z.object({
  type: z.literal("ssh.keys.delete.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
// Export the PUBLIC key only (spec 25.15 S1).
export const SshKeysExportPublicRequestSchema = z.object({
  type: z.literal("ssh.keys.export_public.request"),
  requestId: z.string(),
  id: z.string(),
  format: z.enum(["openssh", "pem"]).optional(), // default "openssh"
});
export const SshKeysExportPublicResponseSchema = z.object({
  type: z.literal("ssh.keys.export_public.response"),
  payload: z.object({
    requestId: z.string(),
    publicKey: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

// ── known hosts ──
export const SshKnownhostsListRequestSchema = z.object({
  type: z.literal("ssh.knownhosts.list.request"),
  requestId: z.string(),
});
export const SshKnownhostsListResponseSchema = z.object({
  type: z.literal("ssh.knownhosts.list.response"),
  payload: z.object({
    requestId: z.string(),
    knownHosts: z.array(SshKnownHostSchema),
    error: z.string().nullable(),
  }),
});
// Deletes every key stored for host:port, or just `keyType` when given.
export const SshKnownhostsDeleteRequestSchema = z.object({
  type: z.literal("ssh.knownhosts.delete.request"),
  requestId: z.string(),
  host: z.string(),
  port: z.number().int(),
  keyType: z.string().optional(),
});
export const SshKnownhostsDeleteResponseSchema = z.object({
  type: z.literal("ssh.knownhosts.delete.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
// The only way a stored host key changes after a `host_key_mismatch` block (spec 25.3).
// Replaces every key stored for host:port with the one given.
export const SshKnownhostsReplaceRequestSchema = z.object({
  type: z.literal("ssh.knownhosts.replace.request"),
  requestId: z.string(),
  host: z.string(),
  port: z.number().int(),
  keyType: z.string(),
  publicKey: z.string(),
});
export const SshKnownhostsReplaceResponseSchema = z.object({
  type: z.literal("ssh.knownhosts.replace.response"),
  payload: z.object({
    requestId: z.string(),
    knownHost: SshKnownHostSchema.nullable(),
    error: z.string().nullable(),
  }),
});

// ── connect prompts ──
export const SshHostkeyRespondRequestSchema = z.object({
  type: z.literal("ssh.hostkey.respond.request"),
  requestId: z.string(),
  promptId: z.string(),
  decision: z.enum(["accept", "reject"]),
});
export const SshHostkeyRespondResponseSchema = z.object({
  type: z.literal("ssh.hostkey.respond.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
export const SshAuthRespondRequestSchema = z.object({
  type: z.literal("ssh.auth.respond.request"),
  requestId: z.string(),
  promptId: z.string(),
  answers: z.array(z.string()).nullable(), // one answer per prompt, in order; null = cancel
});
export const SshAuthRespondResponseSchema = z.object({
  type: z.literal("ssh.auth.respond.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});

// ── session ──
// Creates an SSH terminal session with no workspaceId (spec 25.4); the returned
// terminalId works with the existing terminal RPCs (subscribe, input, resize,
// capture, kill, rename). Connect progress arrives via ssh.connection.state.
export const SshSessionCreateRequestSchema = z.object({
  type: z.literal("ssh.session.create.request"),
  requestId: z.string(),
  serverId: z.string(),
  size: SshTerminalSizeSchema,
});
export const SshSessionCreateResponseSchema = z.object({
  type: z.literal("ssh.session.create.response"),
  payload: z.object({
    requestId: z.string(),
    terminalId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
// Reconnect a session that ended in `error`/`disconnected`, in the same terminal
// (screen history kept). Spec 25.3 step 6 does this automatically; this is the manual retry.
export const SshSessionReconnectRequestSchema = z.object({
  type: z.literal("ssh.session.reconnect.request"),
  requestId: z.string(),
  terminalId: z.string(),
});
export const SshSessionReconnectResponseSchema = z.object({
  type: z.literal("ssh.session.reconnect.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
// Broadcast input (spec 25.4): with `enabled`, keystrokes sent to any of `terminalIds`
// are typed into all the others; without it, those terminals leave their group.
export const SshSessionBroadcastRequestSchema = z.object({
  type: z.literal("ssh.session.broadcast.request"),
  requestId: z.string(),
  terminalIds: z.array(z.string()),
  enabled: z.boolean(),
});
export const SshSessionBroadcastResponseSchema = z.object({
  type: z.literal("ssh.session.broadcast.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});
// Mobile "Password" key (spec 25.4): the daemon types the server's saved password into
// the session; the password never reaches the app.
export const SshSessionTypePasswordRequestSchema = z.object({
  type: z.literal("ssh.session.type_password.request"),
  requestId: z.string(),
  terminalId: z.string(),
});
export const SshSessionTypePasswordResponseSchema = z.object({
  type: z.literal("ssh.session.type_password.response"),
  payload: z.object({ requestId: z.string(), error: z.string().nullable() }),
});

// ── server→client pushes ──

// Output arrived on an SSH/Telnet tab (at most once per second per tab): drives the
// green "unseen output" tab dot (spec 25.4). Carries no output content.
export const SshSessionActivitySchema = z.object({
  type: z.literal("ssh.session.activity"),
  terminalId: z.string(),
  serverId: z.string(),
  lastOutputAtMs: z.number(),
});
export type SshSessionActivity = z.infer<typeof SshSessionActivitySchema>;

// First unknown host key (spec 25.3 step 3): sent to every connected client; the
// connect waits up to 120 s for ssh.hostkey.respond. `hopIndex`/`hopCount` identify
// the jump-chain hop being verified (each hop asks separately).
export const SshHostkeyPromptSchema = z.object({
  type: z.literal("ssh.hostkey.prompt"),
  promptId: z.string(),
  serverId: z.string(),
  terminalId: z.string().optional(),
  address: z.string(),
  port: z.number().int(),
  keyType: z.string(),
  fingerprintSha256: z.string(),
  hopIndex: z.number().int().optional(),
  hopCount: z.number().int().optional(),
  expiresAtMs: z.number(),
});
export type SshHostkeyPrompt = z.infer<typeof SshHostkeyPromptSchema>;

// Password / keyboard-interactive / passphrase prompt (spec 25.3 step 4).
// Answers are relayed to the daemon once; nothing here is persisted.
export const SshAuthPromptSchema = z.object({
  type: z.literal("ssh.auth.prompt"),
  promptId: z.string(),
  serverId: z.string(),
  terminalId: z.string().optional(),
  kind: SshAuthPromptKindSchema,
  instructions: z.string().optional(),
  prompts: z.array(SshAuthPromptItemSchema),
  expiresAtMs: z.number(),
});
export type SshAuthPrompt = z.infer<typeof SshAuthPromptSchema>;

// A prompt answered (by any client), expired, or abandoned: clients drop its bar.
export const SshPromptResolvedSchema = z.object({
  type: z.literal("ssh.prompt.resolved"),
  promptId: z.string(),
});
export type SshPromptResolved = z.infer<typeof SshPromptResolvedSchema>;

export const SshConnectionStateSchema = z.object({
  type: z.literal("ssh.connection.state"),
  serverId: z.string(),
  terminalId: z.string().optional(),
  state: SshServerStateSchema,
  // Structured failure info. `host_key_mismatch` carries both fingerprints (spec 25.3).
  error: SshConnectionErrorSchema.optional(),
  // Present while `reconnecting`: when the next attempt starts.
  nextAttemptAtMs: z.number().optional(),
});
export type SshConnectionStateEvent = z.infer<typeof SshConnectionStateSchema>;

export const SshRequestSchemas = [
  SshServersListRequestSchema,
  SshServersGetRequestSchema,
  SshServersSaveRequestSchema,
  SshServersDeleteRequestSchema,
  SshGroupsListRequestSchema,
  SshGroupsGetRequestSchema,
  SshGroupsSaveRequestSchema,
  SshGroupsDeleteRequestSchema,
  SshIdentitiesListRequestSchema,
  SshIdentitiesGetRequestSchema,
  SshIdentitiesSaveRequestSchema,
  SshIdentitiesDeleteRequestSchema,
  SshKeysListRequestSchema,
  SshKeysGenerateRequestSchema,
  SshKeysImportRequestSchema,
  SshKeysDeleteRequestSchema,
  SshKeysExportPublicRequestSchema,
  SshKnownhostsListRequestSchema,
  SshKnownhostsDeleteRequestSchema,
  SshKnownhostsReplaceRequestSchema,
  SshHostkeyRespondRequestSchema,
  SshAuthRespondRequestSchema,
  SshSessionCreateRequestSchema,
  SshSessionReconnectRequestSchema,
  SshSessionBroadcastRequestSchema,
  SshSessionTypePasswordRequestSchema,
] as const;

export const SshResponseSchemas = [
  SshServersListResponseSchema,
  SshServersGetResponseSchema,
  SshServersSaveResponseSchema,
  SshServersDeleteResponseSchema,
  SshGroupsListResponseSchema,
  SshGroupsGetResponseSchema,
  SshGroupsSaveResponseSchema,
  SshGroupsDeleteResponseSchema,
  SshIdentitiesListResponseSchema,
  SshIdentitiesGetResponseSchema,
  SshIdentitiesSaveResponseSchema,
  SshIdentitiesDeleteResponseSchema,
  SshKeysListResponseSchema,
  SshKeysGenerateResponseSchema,
  SshKeysImportResponseSchema,
  SshKeysDeleteResponseSchema,
  SshKeysExportPublicResponseSchema,
  SshKnownhostsListResponseSchema,
  SshKnownhostsDeleteResponseSchema,
  SshKnownhostsReplaceResponseSchema,
  SshHostkeyRespondResponseSchema,
  SshAuthRespondResponseSchema,
  SshSessionCreateResponseSchema,
  SshSessionReconnectResponseSchema,
  SshSessionBroadcastResponseSchema,
  SshSessionTypePasswordResponseSchema,
] as const;

export const SshPushSchemas = [
  SshHostkeyPromptSchema,
  SshAuthPromptSchema,
  SshPromptResolvedSchema,
  SshConnectionStateSchema,
  SshSessionActivitySchema,
] as const;
