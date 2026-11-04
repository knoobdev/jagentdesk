import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { toSideloadError } from "../../sideload/errors.js";
import type { SideloadService } from "../../sideload/sideload-service.js";

/**
 * The sideload.* / android.* RPC surface (spec 26.11). Each handler emits exactly one
 * response — an `error` (and `code` where the schema has one) on failure, never a throw into
 * the socket loop. Requests are never logged: accounts.add carries a password or a `.p8`,
 * auth.respond a 2FA code.
 */

type Req<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;
type Out = SessionOutboundMessage;

export interface SideloadSessionOptions {
  emit: (message: Out) => void;
  service: SideloadService;
  logger: pino.Logger;
}

export class SideloadSession {
  constructor(private readonly options: SideloadSessionOptions) {}

  handles(type: string): boolean {
    return type.startsWith("sideload.") || type.startsWith("android.");
  }

  async handle(msg: SessionInboundMessage): Promise<void> {
    const { emit } = this.options;
    try {
      emit(await this.dispatch(msg));
    } catch (error) {
      const failure = toSideloadError(error);
      this.options.logger.warn({ type: msg.type, code: failure.code }, "sideload rpc failed");
      const response = this.failure(msg, failure.message, failure.code);
      if (response) emit(response);
    }
  }

  // oxlint-disable-next-line complexity
  private async dispatch(msg: SessionInboundMessage): Promise<Out> {
    const s = this.options.service;
    switch (msg.type) {
      case "sideload.accounts.list.request":
        return {
          type: "sideload.accounts.list.response",
          payload: { requestId: msg.requestId, accounts: await s.listAccounts(), error: null },
        };
      case "sideload.accounts.add.request":
        return {
          type: "sideload.accounts.add.response",
          payload: {
            requestId: msg.requestId,
            account: await s.addAccount(addInput(msg)),
            code: null,
            error: null,
          },
        };
      case "sideload.accounts.remove.request":
        await s.accounts.remove(msg.accountId);
        return {
          type: "sideload.accounts.remove.response",
          payload: { requestId: msg.requestId, error: null },
        };
      case "sideload.accounts.set_anisette.request": {
        const account = await s.accounts.setAnisette(msg.accountId, msg.source, msg.url ?? null);
        return {
          type: "sideload.accounts.set_anisette.response",
          payload: { requestId: msg.requestId, account: await s.summary(account.id), error: null },
        };
      }
      case "sideload.accounts.set_keep_signed_in.request": {
        const account = await s.accounts.setKeepSignedIn(
          msg.accountId,
          msg.keepSignedIn,
          msg.password ?? null,
        );
        return {
          type: "sideload.accounts.set_keep_signed_in.response",
          payload: { requestId: msg.requestId, account: await s.summary(account.id), error: null },
        };
      }
      case "sideload.auth.respond.request":
        s.respondToPrompt(msg.promptId, authAnswer(msg));
        return {
          type: "sideload.auth.respond.response",
          payload: { requestId: msg.requestId, error: null },
        };
      case "sideload.devices.list.request":
        return {
          type: "sideload.devices.list.response",
          payload: { requestId: msg.requestId, ...(await s.listDevices()), error: null },
        };
      case "sideload.ipa.upload.request":
        return {
          type: "sideload.ipa.upload.response",
          payload: { requestId: msg.requestId, ipa: await s.uploadIpa(msg.path), error: null },
        };
      case "sideload.ipa.inspect.request":
        return {
          type: "sideload.ipa.inspect.response",
          payload: { requestId: msg.requestId, ipa: await s.inspect(msg.path), error: null },
        };
      case "sideload.host.browse.request":
        return {
          type: "sideload.host.browse.response",
          payload: {
            requestId: msg.requestId,
            ...(await s.browseHost({
              kind: msg.kind,
              ...(msg.path === undefined ? {} : { path: msg.path }),
            })),
            error: null,
          },
        };
      case "sideload.install.start.request":
        return {
          type: "sideload.install.start.response",
          payload: {
            requestId: msg.requestId,
            jobId: await s.startInstall({
              path: msg.path,
              deviceUdid: msg.deviceUdid,
              accountId: msg.accountId ?? null,
              mode: msg.mode,
              options: msg.options ?? {},
              autoRefresh: msg.autoRefresh ?? null,
            }),
            error: null,
          },
        };
      case "sideload.install.cancel.request":
        s.cancelJob(msg.jobId);
        return {
          type: "sideload.install.cancel.response",
          payload: { requestId: msg.requestId, error: null },
        };
      case "sideload.apps.list.request":
        return {
          type: "sideload.apps.list.response",
          payload: { requestId: msg.requestId, apps: s.listApps(), error: null },
        };
      case "sideload.apps.refresh.request":
        return {
          type: "sideload.apps.refresh.response",
          payload: { requestId: msg.requestId, jobId: s.refreshApp(msg.appId), error: null },
        };
      case "sideload.apps.refresh_all.request":
        return {
          type: "sideload.apps.refresh_all.response",
          payload: { requestId: msg.requestId, jobIds: s.refreshAll(msg.deviceUdid), error: null },
        };
      case "sideload.apps.uninstall.request":
        await s.uninstallApp(msg.appId);
        return {
          type: "sideload.apps.uninstall.response",
          payload: { requestId: msg.requestId, error: null },
        };
      case "sideload.apps.forget.request":
        s.forgetApp(msg.appId);
        return {
          type: "sideload.apps.forget.response",
          payload: { requestId: msg.requestId, error: null },
        };
      case "sideload.export.start.request":
        return {
          type: "sideload.export.start.response",
          payload: {
            requestId: msg.requestId,
            jobId: await s.startExport({
              path: msg.path,
              accountId: msg.accountId,
              options: msg.options ?? {},
            }),
            error: null,
          },
        };
      case "sideload.certs.list.request":
        return {
          type: "sideload.certs.list.response",
          payload: {
            requestId: msg.requestId,
            certs: await s.listCerts(msg.accountId),
            error: null,
          },
        };
      case "sideload.certs.revoke.request":
        await s.revokeCert(msg.accountId, msg.certId);
        return {
          type: "sideload.certs.revoke.response",
          payload: { requestId: msg.requestId, error: null },
        };
      case "sideload.app_ids.list.request":
        return {
          type: "sideload.app_ids.list.response",
          payload: {
            requestId: msg.requestId,
            appIds: await s.listAppIds(msg.accountId),
            error: null,
          },
        };
      case "android.install.start.request":
        return {
          type: "android.install.start.response",
          payload: {
            requestId: msg.requestId,
            output: await s.androidInstall(msg.serial, msg.paths),
            error: null,
          },
        };
      default:
        throw new Error(`Unhandled sideload message ${msg.type}`);
    }
  }

  // oxlint-disable-next-line complexity
  private failure(msg: SessionInboundMessage, error: string, code: string): Out | null {
    const requestId = "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : "";
    const base = { requestId, error };
    switch (msg.type) {
      case "sideload.accounts.list.request":
        return { type: "sideload.accounts.list.response", payload: { ...base, accounts: [] } };
      case "sideload.accounts.add.request":
        return {
          type: "sideload.accounts.add.response",
          payload: { ...base, account: null, code },
        };
      case "sideload.accounts.remove.request":
        return { type: "sideload.accounts.remove.response", payload: base };
      case "sideload.accounts.set_anisette.request":
        return {
          type: "sideload.accounts.set_anisette.response",
          payload: { ...base, account: null },
        };
      case "sideload.accounts.set_keep_signed_in.request":
        return {
          type: "sideload.accounts.set_keep_signed_in.response",
          payload: { ...base, account: null },
        };
      case "sideload.auth.respond.request":
        return { type: "sideload.auth.respond.response", payload: base };
      case "sideload.devices.list.request":
        return {
          type: "sideload.devices.list.response",
          payload: {
            ...base,
            devices: [],
            iosUnavailableReason: error,
            androidUnavailableReason: error,
          },
        };
      case "sideload.ipa.upload.request":
        return { type: "sideload.ipa.upload.response", payload: { ...base, ipa: null } };
      case "sideload.ipa.inspect.request":
        return { type: "sideload.ipa.inspect.response", payload: { ...base, ipa: null } };
      case "sideload.host.browse.request":
        return {
          type: "sideload.host.browse.response",
          payload: { ...base, path: msg.path ?? "", parent: null, entries: [] },
        };
      case "sideload.install.start.request":
        return { type: "sideload.install.start.response", payload: { ...base, jobId: null } };
      case "sideload.install.cancel.request":
        return { type: "sideload.install.cancel.response", payload: base };
      case "sideload.apps.list.request":
        return { type: "sideload.apps.list.response", payload: { ...base, apps: [] } };
      case "sideload.apps.refresh.request":
        return { type: "sideload.apps.refresh.response", payload: { ...base, jobId: null } };
      case "sideload.apps.refresh_all.request":
        return { type: "sideload.apps.refresh_all.response", payload: { ...base, jobIds: [] } };
      case "sideload.apps.uninstall.request":
        return { type: "sideload.apps.uninstall.response", payload: base };
      case "sideload.apps.forget.request":
        return { type: "sideload.apps.forget.response", payload: base };
      case "sideload.export.start.request":
        return { type: "sideload.export.start.response", payload: { ...base, jobId: null } };
      case "sideload.certs.list.request":
        return { type: "sideload.certs.list.response", payload: { ...base, certs: [] } };
      case "sideload.certs.revoke.request":
        return { type: "sideload.certs.revoke.response", payload: base };
      case "sideload.app_ids.list.request":
        return { type: "sideload.app_ids.list.response", payload: { ...base, appIds: [] } };
      case "android.install.start.request":
        return { type: "android.install.start.response", payload: { ...base, output: "" } };
      default:
        return null;
    }
  }
}

function addInput(msg: Req<"sideload.accounts.add.request">) {
  if (msg.auth === "asc_api_key") {
    return {
      auth: "asc_api_key" as const,
      issuerId: msg.issuerId ?? "",
      keyId: msg.keyId ?? "",
      privateKeyP8: msg.privateKeyP8 ?? "",
    };
  }
  return {
    auth: "apple_id" as const,
    appleId: msg.appleId ?? "",
    password: msg.password ?? "",
    keepSignedIn: msg.keepSignedIn ?? false,
    anisetteSource: msg.anisetteSource ?? null,
    anisetteUrl: msg.anisetteUrl ?? null,
    acceptedTerms: msg.acceptedTerms ?? false,
  };
}

function authAnswer(msg: Req<"sideload.auth.respond.request">) {
  if (msg.action === "code") return { action: "code" as const, code: (msg.code ?? "").trim() };
  if (msg.action === "send_sms") return { action: "send_sms" as const, phoneId: msg.phoneId ?? 1 };
  return { action: "cancel" as const };
}
