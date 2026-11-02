import { z } from "zod";

// Wire schemas for SSH servers (spec 25, milestone S1). Mirrors docker/rpc-schemas.ts:
// every request carries a `type` literal + `requestId`; every response is
// `{ type, payload: { requestId, ...data, error } }`. New RPCs use dotted namespaces
// with direction suffixes (docs/rpc-namespacing.md).
//
// Secrets (passwords, private keys, passphrases) never appear on any response or
// push. A password/private key travels once, client→daemon, on save/import/generate,
// then lives only in the daemon's FileSecretStore under `ssh.password.<id>`,
// `ssh.key.<id>`, `ssh.passphrase.<id>`. The wire exposes only booleans
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
  "error",
]);
export type SshServerState = z.infer<typeof SshServerStateSchema>;

export const SshServerSchema = z.object({
  id: z.string(), // `srv_…`
  label: z.string(),
  address: z.string(),
  port: z.number().int().min(1).max(65535).optional(), // default 22
  username: z.string().optional(), // falls back to nearest parent group, then identity
  groupId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  identityId: z.string().optional(),
  authMethods: z.array(SshAuthMethodSchema).optional(),
  hasPassword: z.boolean().optional(), // true when ssh.password.<id> exists in the store
  createdAtMs: z.number().optional(),
  updatedAtMs: z.number().optional(),
});
export type SshServer = z.infer<typeof SshServerSchema>;

export const SshServerInfoSchema = SshServerSchema.extend({
  state: SshServerStateSchema,
  lastError: z.string().optional(),
});
export type SshServerInfo = z.infer<typeof SshServerInfoSchema>;

// A group carries the same inheritable config fields as a server; the effective
// value for each field is nearest ancestor (including the server itself) that sets it.
export const SshGroupSchema = z.object({
  id: z.string(), // `grp_…`
  label: z.string(),
  parentId: z.string().optional(),
  username: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  identityId: z.string().optional(),
  authMethods: z.array(SshAuthMethodSchema).optional(),
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
});
export type SshKey = z.infer<typeof SshKeySchema>;

export const SshKnownHostSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  keyType: z.string(), // wire name, e.g. "ssh-ed25519"
  publicKey: z.string(),
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

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── servers ──
export const SshServersListRequestSchema = req("ssh.servers.list.request", {});
export const SshServersListResponseSchema = resp("ssh.servers.list.response", {
  servers: z.array(SshServerInfoSchema),
  groups: z.array(SshGroupSchema),
  identities: z.array(SshIdentitySchema),
});
export const SshServersGetRequestSchema = req("ssh.servers.get.request", { id: z.string() });
export const SshServersGetResponseSchema = resp("ssh.servers.get.response", {
  server: SshServerInfoSchema.nullable(),
});
// `password`: undefined keeps the stored secret, "" deletes it, non-empty replaces it.
export const SshServersSaveRequestSchema = req("ssh.servers.save.request", {
  server: SshServerSchema,
  password: z.string().optional(),
});
export const SshServersSaveResponseSchema = resp("ssh.servers.save.response", {
  server: SshServerInfoSchema.nullable(),
});
export const SshServersDeleteRequestSchema = req("ssh.servers.delete.request", {
  id: z.string(),
});
export const SshServersDeleteResponseSchema = resp("ssh.servers.delete.response", {});

// ── groups ──
export const SshGroupsListRequestSchema = req("ssh.groups.list.request", {});
export const SshGroupsListResponseSchema = resp("ssh.groups.list.response", {
  groups: z.array(SshGroupSchema),
});
export const SshGroupsGetRequestSchema = req("ssh.groups.get.request", { id: z.string() });
export const SshGroupsGetResponseSchema = resp("ssh.groups.get.response", {
  group: SshGroupSchema.nullable(),
});
export const SshGroupsSaveRequestSchema = req("ssh.groups.save.request", {
  group: SshGroupSchema,
});
export const SshGroupsSaveResponseSchema = resp("ssh.groups.save.response", {
  group: SshGroupSchema.nullable(),
});
export const SshGroupsDeleteRequestSchema = req("ssh.groups.delete.request", { id: z.string() });
export const SshGroupsDeleteResponseSchema = resp("ssh.groups.delete.response", {});

// ── identities ──
export const SshIdentitiesListRequestSchema = req("ssh.identities.list.request", {});
export const SshIdentitiesListResponseSchema = resp("ssh.identities.list.response", {
  identities: z.array(SshIdentitySchema),
});
export const SshIdentitiesGetRequestSchema = req("ssh.identities.get.request", {
  id: z.string(),
});
export const SshIdentitiesGetResponseSchema = resp("ssh.identities.get.response", {
  identity: SshIdentitySchema.nullable(),
});
export const SshIdentitiesSaveRequestSchema = req("ssh.identities.save.request", {
  identity: SshIdentitySchema,
  password: z.string().optional(),
});
export const SshIdentitiesSaveResponseSchema = resp("ssh.identities.save.response", {
  identity: SshIdentitySchema.nullable(),
});
export const SshIdentitiesDeleteRequestSchema = req("ssh.identities.delete.request", {
  id: z.string(),
});
export const SshIdentitiesDeleteResponseSchema = resp("ssh.identities.delete.response", {});

// ── keys ──
export const SshKeysListRequestSchema = req("ssh.keys.list.request", {});
export const SshKeysListResponseSchema = resp("ssh.keys.list.response", {
  keys: z.array(SshKeySchema),
});
// The daemon generates the pair with ssh2, stores the private key (and passphrase,
// when given) in the secret store, and returns public metadata only.
export const SshKeysGenerateRequestSchema = req("ssh.keys.generate.request", {
  label: z.string(),
  type: SshKeyTypeSchema,
  passphrase: z.string().optional(),
});
export const SshKeysGenerateResponseSchema = resp("ssh.keys.generate.response", {
  key: SshKeySchema.nullable(),
});
// `privateKey`: PEM (OpenSSH or PEM) as pasted by the user.
export const SshKeysImportRequestSchema = req("ssh.keys.import.request", {
  label: z.string(),
  privateKey: z.string(),
  passphrase: z.string().optional(),
});
export const SshKeysImportResponseSchema = resp("ssh.keys.import.response", {
  key: SshKeySchema.nullable(),
});
export const SshKeysDeleteRequestSchema = req("ssh.keys.delete.request", { id: z.string() });
export const SshKeysDeleteResponseSchema = resp("ssh.keys.delete.response", {});
// Export the PUBLIC key only ("xuất khoá công khai", spec 25.15 S1).
export const SshKeysExportPublicRequestSchema = req("ssh.keys.export_public.request", {
  id: z.string(),
  format: z.enum(["openssh", "pem"]).optional(), // default "openssh"
});
export const SshKeysExportPublicResponseSchema = resp("ssh.keys.export_public.response", {
  publicKey: z.string().nullable(),
});

// ── known hosts ──
export const SshKnownhostsListRequestSchema = req("ssh.knownhosts.list.request", {});
export const SshKnownhostsListResponseSchema = resp("ssh.knownhosts.list.response", {
  knownHosts: z.array(SshKnownHostSchema),
});
// Deletes every key stored for host:port, or just `keyType` when given.
export const SshKnownhostsDeleteRequestSchema = req("ssh.knownhosts.delete.request", {
  host: z.string(),
  port: z.number().int(),
  keyType: z.string().optional(),
});
export const SshKnownhostsDeleteResponseSchema = resp("ssh.knownhosts.delete.response", {});
// The only way a stored host key changes after a `host_key_mismatch` block (spec 25.3).
export const SshKnownhostsReplaceRequestSchema = req("ssh.knownhosts.replace.request", {
  host: z.string(),
  port: z.number().int(),
  keyType: z.string(),
  publicKey: z.string(),
  fingerprintSha256: z.string(),
});
export const SshKnownhostsReplaceResponseSchema = resp("ssh.knownhosts.replace.response", {});

// ── connect prompts ──
export const SshHostkeyRespondRequestSchema = req("ssh.hostkey.respond.request", {
  promptId: z.string(),
  decision: z.enum(["accept", "reject"]),
});
export const SshHostkeyRespondResponseSchema = resp("ssh.hostkey.respond.response", {});
export const SshAuthRespondRequestSchema = req("ssh.auth.respond.request", {
  promptId: z.string(),
  answers: z.array(z.string()), // one answer per prompt, in order
});
export const SshAuthRespondResponseSchema = resp("ssh.auth.respond.response", {});

// ── session ──
// Creates an SSH terminal session with no workspaceId (spec 25.4); the returned
// terminalId works with the existing terminal RPCs (subscribe, input, resize,
// capture, kill, rename). Connect progress arrives via ssh.connection.state.
export const SshSessionCreateRequestSchema = req("ssh.session.create.request", {
  serverId: z.string(),
  size: SshTerminalSizeSchema,
});
export const SshSessionCreateResponseSchema = resp("ssh.session.create.response", {
  terminalId: z.string().nullable(),
});

// ── server→client pushes ──

// First unknown host key (spec 25.3 step 3): sent to every connected client; the
// connect waits up to 120 s for ssh.hostkey.respond.
export const SshHostkeyPromptSchema = z.object({
  type: z.literal("ssh.hostkey.prompt"),
  promptId: z.string(),
  serverId: z.string(),
  address: z.string(),
  port: z.number().int(),
  keyType: z.string(),
  fingerprintSha256: z.string(),
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
});
export type SshAuthPrompt = z.infer<typeof SshAuthPromptSchema>;

export const SshConnectionStateSchema = z.object({
  type: z.literal("ssh.connection.state"),
  serverId: z.string(),
  terminalId: z.string().optional(),
  state: SshServerStateSchema,
  // Structured failure info. `host_key_mismatch` carries both fingerprints (spec 25.3).
  error: z
    .object({
      code: z.string(),
      message: z.string().optional(),
      storedFingerprint: z.string().optional(),
      receivedFingerprint: z.string().optional(),
    })
    .optional(),
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
] as const;

export const SshPushSchemas = [
  SshHostkeyPromptSchema,
  SshAuthPromptSchema,
  SshConnectionStateSchema,
] as const;
