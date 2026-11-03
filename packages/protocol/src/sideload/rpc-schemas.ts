import { z } from "zod";

// Wire schemas for Sideload (spec 26 / ADR-0032). Requests carry `type` + `requestId` at the
// top level; responses are `{ type, payload: { requestId, ...data, error } }`
// (docs/rpc-namespacing.md). Every timestamp is Unix UTC milliseconds with an `_ms` suffix.
//
// Secrets never leave the daemon: an Apple ID password and an App Store Connect `.p8` travel
// once, client→daemon, on `sideload.accounts.add`; a 2FA code travels once on
// `sideload.auth.respond`. No response or push carries a password, token, anisette data,
// certificate private key or 2FA code.

export const SideloadAccountKindSchema = z.enum(["free", "paid"]);
export type SideloadAccountKind = z.infer<typeof SideloadAccountKindSchema>;

export const SideloadAccountAuthSchema = z.enum(["apple_id", "asc_api_key"]);
export type SideloadAccountAuth = z.infer<typeof SideloadAccountAuthSchema>;

// `none`: App Store Connect API keys do not use anisette.
export const SideloadAnisetteSourceSchema = z.enum(["native", "remote", "none"]);
export type SideloadAnisetteSource = z.infer<typeof SideloadAnisetteSourceSchema>;

export const SideloadAccountSummarySchema = z.object({
  id: z.string(), // apl_…
  appleId: z.string(), // Apple ID email, or "ASC key <KEY ID>" for API keys
  kind: SideloadAccountKindSchema,
  auth: SideloadAccountAuthSchema,
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  keepSignedIn: z.boolean(),
  anisetteSource: SideloadAnisetteSourceSchema,
  anisetteUrl: z.string().nullable(),
  createdAt_ms: z.number(),
  // False when the session token expired and no password is kept: "Sign in again".
  signedIn: z.boolean(),
  // Free accounts: App IDs created in the last 7 days (26.5), limit 10; paid: limit null.
  appIdsUsed: z.number().int(),
  appIdsLimit: z.number().int().nullable(),
  nextAppIdAt_ms: z.number().nullable(),
});
export type SideloadAccountSummary = z.infer<typeof SideloadAccountSummarySchema>;

// Advanced options (26.5). Paths are daemon paths (uploaded with file.upload first).
export const SideloadOptionsSchema = z.object({
  appName: z.string().optional(),
  iconPath: z.string().optional(),
  bundleId: z.string().optional(),
  minimumOs: z.string().optional(),
  removeDeviceRestrictions: z.boolean().optional(),
  fileSharing: z.boolean().optional(),
  // "all" or the bundle ids of the extensions to drop.
  removeExtensions: z.union([z.literal("all"), z.array(z.string())]).optional(),
  inject: z.array(z.string()).optional(),
});
export type SideloadOptions = z.infer<typeof SideloadOptionsSchema>;

export const SideloadInstallModeSchema = z.enum(["sign_install", "install_as_is", "export"]);
export type SideloadInstallMode = z.infer<typeof SideloadInstallModeSchema>;

export const SideloadAppSchema = z.object({
  id: z.string(), // sla_…
  accountId: z.string(),
  deviceUdid: z.string(),
  bundleId: z.string(),
  originalBundleId: z.string(),
  name: z.string(),
  version: z.string(),
  ipaSha256: z.string(),
  options: SideloadOptionsSchema,
  installedAt_ms: z.number(),
  expiresAt_ms: z.number(),
  autoRefresh: z.boolean(),
  lastRefreshAt_ms: z.number().nullable(),
  lastError: z.string().nullable(),
});
export type SideloadApp = z.infer<typeof SideloadAppSchema>;

export const SideloadIpaExtensionSchema = z.object({
  bundleId: z.string(),
  name: z.string(),
  path: z.string(), // relative to the .app, e.g. PlugIns/Share.appex
});

export const SideloadIpaInfoSchema = z.object({
  path: z.string(), // sideload/ipa/<sha256>.ipa on the daemon
  sha256: z.string(),
  sizeBytes: z.number(),
  name: z.string(),
  bundleId: z.string(),
  version: z.string(),
  minimumOs: z.string().nullable(),
  // FairPlay-encrypted binaries do not run after re-signing (Sideloadly "No permission").
  encrypted: z.boolean(),
  architectures: z.array(z.string()),
  extensions: z.array(SideloadIpaExtensionSchema),
  hasWatchApp: z.boolean(),
  signed: z.boolean(),
});
export type SideloadIpaInfo = z.infer<typeof SideloadIpaInfoSchema>;

export const SideloadDevicePlatformSchema = z.enum(["ios", "android"]);
export const SideloadDeviceSchema = z.object({
  platform: SideloadDevicePlatformSchema,
  id: z.string(), // iOS UDID or Android serial (host:port for wireless)
  name: z.string(),
  model: z.string(),
  osVersion: z.string(),
  connection: z.enum(["usb", "wifi"]),
  // iOS: false until the device trusts this computer. Android: false while unauthorized.
  ready: z.boolean(),
  notReadyReason: z.string().nullable(),
});
export type SideloadDevice = z.infer<typeof SideloadDeviceSchema>;

export const SideloadCertSchema = z.object({
  id: z.string(),
  serialNumber: z.string(),
  name: z.string(),
  machineName: z.string().nullable(),
  expiresAt_ms: z.number().nullable(),
  // True for the certificate this daemon holds the private key of.
  ownedByDaemon: z.boolean(),
});
export type SideloadCert = z.infer<typeof SideloadCertSchema>;

export const SideloadAppIdSchema = z.object({
  id: z.string(),
  bundleId: z.string(),
  name: z.string(),
  expiresAt_ms: z.number().nullable(),
});
export type SideloadAppId = z.infer<typeof SideloadAppIdSchema>;

export const SideloadInstallStepSchema = z.enum([
  "inspect",
  "login",
  "register_device",
  "certificate",
  "app_id",
  "profile",
  "sign",
  "install",
  "export",
]);
export type SideloadInstallStep = z.infer<typeof SideloadInstallStepSchema>;

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── accounts ──
export const SideloadAccountsListRequestSchema = req("sideload.accounts.list.request", {});
export const SideloadAccountsListResponseSchema = resp("sideload.accounts.list.response", {
  accounts: z.array(SideloadAccountSummarySchema),
});

// Adding an Apple ID that already exists signs it in again ("Sign in again").
// May block while a 2FA prompt (sideload.auth.prompt) waits for an answer.
export const SideloadAccountsAddRequestSchema = req("sideload.accounts.add.request", {
  auth: SideloadAccountAuthSchema,
  appleId: z.string().optional(),
  password: z.string().optional(),
  keepSignedIn: z.boolean().optional(),
  anisetteSource: SideloadAnisetteSourceSchema.optional(),
  anisetteUrl: z.string().optional(),
  // 26.3.3: required when the first Apple ID account is added.
  acceptedTerms: z.boolean().optional(),
  issuerId: z.string().optional(),
  keyId: z.string().optional(),
  privateKeyP8: z.string().optional(),
});
export const SideloadAccountsAddResponseSchema = resp("sideload.accounts.add.response", {
  account: SideloadAccountSummarySchema.nullable(),
  // Machine-readable failure: terms_required, invalid_credentials, two_factor_cancelled,
  // anisette_failed, team_unavailable, …
  code: z.string().nullable(),
});

export const SideloadAccountsRemoveRequestSchema = req("sideload.accounts.remove.request", {
  accountId: z.string(),
});
export const SideloadAccountsRemoveResponseSchema = resp("sideload.accounts.remove.response", {});

export const SideloadAccountsSetAnisetteRequestSchema = req(
  "sideload.accounts.set_anisette.request",
  { accountId: z.string(), source: SideloadAnisetteSourceSchema, url: z.string().optional() },
);
export const SideloadAccountsSetAnisetteResponseSchema = resp(
  "sideload.accounts.set_anisette.response",
  { account: SideloadAccountSummarySchema.nullable() },
);

// Turning keepSignedIn on needs the password again (it was never stored).
export const SideloadAccountsSetKeepSignedInRequestSchema = req(
  "sideload.accounts.set_keep_signed_in.request",
  { accountId: z.string(), keepSignedIn: z.boolean(), password: z.string().optional() },
);
export const SideloadAccountsSetKeepSignedInResponseSchema = resp(
  "sideload.accounts.set_keep_signed_in.response",
  { account: SideloadAccountSummarySchema.nullable() },
);

// ── 2FA relay ──
export const SideloadAuthRespondRequestSchema = req("sideload.auth.respond.request", {
  promptId: z.string(),
  action: z.enum(["code", "send_sms", "cancel"]),
  code: z.string().optional(),
  phoneId: z.number().int().optional(),
});
export const SideloadAuthRespondResponseSchema = resp("sideload.auth.respond.response", {});

export const SideloadPhoneNumberSchema = z.object({
  id: z.number().int(),
  number: z.string(), // masked by Apple, e.g. "(•••) •••-••12"
});

export const SideloadAuthPromptSchema = z.object({
  type: z.literal("sideload.auth.prompt"),
  promptId: z.string(),
  appleId: z.string(),
  method: z.enum(["trusted_device", "sms"]),
  phoneNumbers: z.array(SideloadPhoneNumberSchema),
  // Last attempt failed (wrong code): shown above the code field.
  message: z.string().nullable(),
  expiresAt_ms: z.number(),
});
export type SideloadAuthPrompt = z.infer<typeof SideloadAuthPromptSchema>;

export const SideloadAuthResolvedSchema = z.object({
  type: z.literal("sideload.auth.resolved"),
  promptId: z.string(),
});

// Shown on every connected client (26.6): refresh failures, "Sign in again", expiry soon.
export const SideloadNoticeSchema = z.object({
  type: z.literal("sideload.notice"),
  kind: z.enum(["sign_in_again", "expiring", "refresh_failed", "refreshed"]),
  title: z.string(),
  body: z.string(),
  accountId: z.string().nullable(),
  appId: z.string().nullable(),
  at_ms: z.number(),
});
export type SideloadNotice = z.infer<typeof SideloadNoticeSchema>;

// ── devices (iOS via go-ios, Android via adb) ──
export const SideloadDevicesListRequestSchema = req("sideload.devices.list.request", {});
export const SideloadDevicesListResponseSchema = resp("sideload.devices.list.response", {
  devices: z.array(SideloadDeviceSchema),
  // Why a platform cannot list devices on this host ("" when it can).
  iosUnavailableReason: z.string(),
  androidUnavailableReason: z.string(),
});

// ── IPA ──
// `path` is a file.upload result path or any path on the daemon host.
export const SideloadIpaUploadRequestSchema = req("sideload.ipa.upload.request", {
  path: z.string(),
});
export const SideloadIpaUploadResponseSchema = resp("sideload.ipa.upload.response", {
  ipa: SideloadIpaInfoSchema.nullable(),
});
export const SideloadIpaInspectRequestSchema = req("sideload.ipa.inspect.request", {
  path: z.string(),
});
export const SideloadIpaInspectResponseSchema = resp("sideload.ipa.inspect.response", {
  ipa: SideloadIpaInfoSchema.nullable(),
});

// ── install ──
export const SideloadInstallStartRequestSchema = req("sideload.install.start.request", {
  path: z.string(),
  deviceUdid: z.string(),
  accountId: z.string().optional(), // required unless mode is install_as_is
  mode: SideloadInstallModeSchema,
  options: SideloadOptionsSchema.optional(),
  autoRefresh: z.boolean().optional(), // default: on for free accounts
});
export const SideloadInstallStartResponseSchema = resp("sideload.install.start.response", {
  jobId: z.string().nullable(),
});

export const SideloadInstallCancelRequestSchema = req("sideload.install.cancel.request", {
  jobId: z.string(),
});
export const SideloadInstallCancelResponseSchema = resp("sideload.install.cancel.response", {});

export const SideloadInstallProgressSchema = z.object({
  type: z.literal("sideload.install.progress"),
  jobId: z.string(),
  step: SideloadInstallStepSchema,
  state: z.enum(["running", "done", "failed", "cancelled"]),
  message: z.string(),
  percent: z.number().nullable(),
  // On the final event: the stored app (sign/install) or the signed IPA (export).
  app: SideloadAppSchema.nullable(),
  outputPath: z.string().nullable(),
  // Machine-readable failure (free_app_limit, app_id_limit, encrypted_ipa, …).
  code: z.string().nullable(),
});
export type SideloadInstallProgress = z.infer<typeof SideloadInstallProgressSchema>;

// ── installed apps ──
export const SideloadAppsListRequestSchema = req("sideload.apps.list.request", {});
export const SideloadAppsListResponseSchema = resp("sideload.apps.list.response", {
  apps: z.array(SideloadAppSchema),
});
export const SideloadAppsRefreshRequestSchema = req("sideload.apps.refresh.request", {
  appId: z.string(),
});
export const SideloadAppsRefreshResponseSchema = resp("sideload.apps.refresh.response", {
  jobId: z.string().nullable(),
});
export const SideloadAppsRefreshAllRequestSchema = req("sideload.apps.refresh_all.request", {
  deviceUdid: z.string(),
});
export const SideloadAppsRefreshAllResponseSchema = resp("sideload.apps.refresh_all.response", {
  jobIds: z.array(z.string()),
});
export const SideloadAppsUninstallRequestSchema = req("sideload.apps.uninstall.request", {
  appId: z.string(),
});
export const SideloadAppsUninstallResponseSchema = resp("sideload.apps.uninstall.response", {});
export const SideloadAppsForgetRequestSchema = req("sideload.apps.forget.request", {
  appId: z.string(),
});
export const SideloadAppsForgetResponseSchema = resp("sideload.apps.forget.response", {});

// ── export ──
export const SideloadExportStartRequestSchema = req("sideload.export.start.request", {
  path: z.string(),
  accountId: z.string(),
  options: SideloadOptionsSchema.optional(),
});
export const SideloadExportStartResponseSchema = resp("sideload.export.start.response", {
  jobId: z.string().nullable(),
});

// ── team certificates and App IDs (26.3.5) ──
export const SideloadCertsListRequestSchema = req("sideload.certs.list.request", {
  accountId: z.string(),
});
export const SideloadCertsListResponseSchema = resp("sideload.certs.list.response", {
  certs: z.array(SideloadCertSchema),
});
export const SideloadCertsRevokeRequestSchema = req("sideload.certs.revoke.request", {
  accountId: z.string(),
  certId: z.string(),
});
export const SideloadCertsRevokeResponseSchema = resp("sideload.certs.revoke.response", {});
export const SideloadAppIdsListRequestSchema = req("sideload.app_ids.list.request", {
  accountId: z.string(),
});
export const SideloadAppIdsListResponseSchema = resp("sideload.app_ids.list.response", {
  appIds: z.array(SideloadAppIdSchema),
});

// ── Android (26.8) ──
export const AndroidInstallStartRequestSchema = req("android.install.start.request", {
  serial: z.string(),
  // One .apk, one .apks/.xapk bundle, or several split .apk files of one app.
  paths: z.array(z.string()).min(1),
});
export const AndroidInstallStartResponseSchema = resp("android.install.start.response", {
  output: z.string(),
});
// Wireless debugging pairing (Android 11+): `adb pair host:port code`, then `adb connect`.
export const AndroidPairStartRequestSchema = req("android.pair.start.request", {
  pairAddress: z.string(), // host:port from "Pair device with pairing code"
  code: z.string(),
  connectAddress: z.string().optional(), // host:port shown under "Wireless debugging"
});
export const AndroidPairStartResponseSchema = resp("android.pair.start.response", {
  output: z.string(),
});

export const SideloadRequestSchemas = [
  SideloadAccountsListRequestSchema,
  SideloadAccountsAddRequestSchema,
  SideloadAccountsRemoveRequestSchema,
  SideloadAccountsSetAnisetteRequestSchema,
  SideloadAccountsSetKeepSignedInRequestSchema,
  SideloadAuthRespondRequestSchema,
  SideloadDevicesListRequestSchema,
  SideloadIpaUploadRequestSchema,
  SideloadIpaInspectRequestSchema,
  SideloadInstallStartRequestSchema,
  SideloadInstallCancelRequestSchema,
  SideloadAppsListRequestSchema,
  SideloadAppsRefreshRequestSchema,
  SideloadAppsRefreshAllRequestSchema,
  SideloadAppsUninstallRequestSchema,
  SideloadAppsForgetRequestSchema,
  SideloadExportStartRequestSchema,
  SideloadCertsListRequestSchema,
  SideloadCertsRevokeRequestSchema,
  SideloadAppIdsListRequestSchema,
  AndroidInstallStartRequestSchema,
  AndroidPairStartRequestSchema,
] as const;

export const SideloadResponseSchemas = [
  SideloadAccountsListResponseSchema,
  SideloadAccountsAddResponseSchema,
  SideloadAccountsRemoveResponseSchema,
  SideloadAccountsSetAnisetteResponseSchema,
  SideloadAccountsSetKeepSignedInResponseSchema,
  SideloadAuthRespondResponseSchema,
  SideloadDevicesListResponseSchema,
  SideloadIpaUploadResponseSchema,
  SideloadIpaInspectResponseSchema,
  SideloadInstallStartResponseSchema,
  SideloadInstallCancelResponseSchema,
  SideloadAppsListResponseSchema,
  SideloadAppsRefreshResponseSchema,
  SideloadAppsRefreshAllResponseSchema,
  SideloadAppsUninstallResponseSchema,
  SideloadAppsForgetResponseSchema,
  SideloadExportStartResponseSchema,
  SideloadCertsListResponseSchema,
  SideloadCertsRevokeResponseSchema,
  SideloadAppIdsListResponseSchema,
  AndroidInstallStartResponseSchema,
  AndroidPairStartResponseSchema,
] as const;

export const SideloadPushSchemas = [
  SideloadAuthPromptSchema,
  SideloadAuthResolvedSchema,
  SideloadInstallProgressSchema,
  SideloadNoticeSchema,
] as const;

export type SideloadRequest = z.infer<(typeof SideloadRequestSchemas)[number]>;
export type SideloadResponse = z.infer<(typeof SideloadResponseSchemas)[number]>;
export type SideloadPush = z.infer<(typeof SideloadPushSchemas)[number]>;
