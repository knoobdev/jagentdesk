import { createPrivateKey, randomBytes, randomUUID } from "node:crypto";
import type pino from "pino";
import type {
  SideloadAccountSummary,
  SideloadAnisetteSource,
  SideloadAuthPrompt,
} from "@jagentdesk/protocol/sideload/rpc-schemas";
import {
  RemoteAnisette,
  newAnisetteIdentity,
  type AnisetteResult,
  type AnisetteSourceAdapter,
} from "./apple/anisette.js";
import { AppStoreConnectClient } from "./apple/asc.js";
import { DeveloperServicesClient } from "./apple/developer-services.js";
import {
  GsaClient,
  type TwoFactorAnswer,
  type TwoFactorPrompt,
  type TwoFactorRequest,
  type XcodeAuth,
} from "./apple/gsa.js";
import type { AppleHttp } from "./apple/http.js";
import { TeamApiError, type AppleTeamApi, type TeamInfo } from "./apple/team-api.js";
import { SideloadError, toSideloadError } from "./errors.js";
import { FREE_APP_IDS_PER_WINDOW, APP_ID_WINDOW_MS, appIdsInWindow } from "./limits.js";
import type { AccountRecord, SideloadStorage } from "./storage.js";

/**
 * Apple accounts (26.3): Apple ID sign-in with 2FA relayed to every client, App Store
 * Connect API keys, per-account anisette (26.4), and the team API each install uses.
 * Passwords are kept only with keepSignedIn; tokens, anisette identity and keys only in the
 * sideload secret store.
 */

const PROMPT_TTL_MS = 10 * 60_000;
const TOKEN_MARGIN_MS = 5 * 60_000;

export interface AccountsDependencies {
  storage: SideloadStorage;
  logger: pino.Logger;
  appleHttp: AppleHttp;
  anisetteServerHttp: AppleHttp;
  nativeAnisette: () => AnisetteSourceAdapter;
  platform: NodeJS.Platform;
  now: () => number;
  /** Pushes a 2FA prompt / resolution to every connected client. */
  emitPrompt: (prompt: SideloadAuthPrompt) => void;
  emitPromptResolved: (promptId: string) => void;
}

export interface AddAppleIdInput {
  auth: "apple_id";
  appleId: string;
  password: string;
  keepSignedIn: boolean;
  anisetteSource: SideloadAnisetteSource | null;
  anisetteUrl: string | null;
  acceptedTerms: boolean;
}

export interface AddAscKeyInput {
  auth: "asc_api_key";
  issuerId: string;
  keyId: string;
  privateKeyP8: string;
}

export type AddAccountInput = AddAppleIdInput | AddAscKeyInput;

export interface TeamSession {
  account: AccountRecord;
  api: AppleTeamApi;
  teamId: string;
}

interface PendingPrompt {
  resolve: (answer: TwoFactorAnswer) => void;
  timer: ReturnType<typeof setTimeout>;
}

function newAccountId(): string {
  return `apl_${randomBytes(4).toString("hex")}`;
}

export function defaultAnisetteSource(platform: NodeJS.Platform): SideloadAnisetteSource {
  return platform === "linux" ? "remote" : "native";
}

function validRemoteUrl(url: string | null): string {
  const trimmed = url?.trim() ?? "";
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) {
    throw new SideloadError(
      "anisette_url_required",
      "Enter the URL of your anisette server (for example http://<host>:6969).",
    );
  }
  return trimmed;
}

function pickTeam(teams: readonly TeamInfo[]): TeamInfo {
  const team = teams.find((candidate) => candidate.kind === "paid") ?? teams[0];
  if (!team)
    throw new SideloadError("team_unavailable", "This Apple account has no developer team.");
  return team;
}

export class SideloadAccounts {
  private readonly prompts = new Map<string, PendingPrompt>();

  constructor(private readonly deps: AccountsDependencies) {}

  async summaries(): Promise<SideloadAccountSummary[]> {
    const now = this.deps.now();
    const usage = this.deps.storage.listAppIdUsage();
    return Promise.all(
      this.deps.storage.listAccounts().map(async (account) => {
        const window = appIdsInWindow(usage, account.id, now);
        const free = account.kind === "free";
        const full = free && window.length >= FREE_APP_IDS_PER_WINDOW;
        return {
          id: account.id,
          appleId: account.appleId,
          kind: account.kind,
          auth: account.auth,
          teamId: account.teamId,
          teamName: account.teamName,
          keepSignedIn: account.keepSignedIn,
          anisetteSource: account.anisetteSource,
          anisetteUrl: account.anisetteUrl,
          createdAt_ms: account.createdAt_ms,
          signedIn: await this.isSignedIn(account),
          appIdsUsed: window.length,
          appIdsLimit: free ? FREE_APP_IDS_PER_WINDOW : null,
          nextAppIdAt_ms: full && window[0] ? window[0].createdAt_ms + APP_ID_WINDOW_MS : null,
        };
      }),
    );
  }

  async isSignedIn(account: AccountRecord): Promise<boolean> {
    if (account.auth === "asc_api_key") return true;
    if (account.keepSignedIn && (await this.deps.storage.getPassword(account.id))) return true;
    const auth = await this.deps.storage.getXcodeAuth(account.id);
    return auth !== null && auth.expiresAt_ms - TOKEN_MARGIN_MS > this.deps.now();
  }

  async add(input: AddAccountInput): Promise<AccountRecord> {
    return input.auth === "apple_id" ? this.addAppleId(input) : this.addAscKey(input);
  }

  private async addAppleId(input: AddAppleIdInput): Promise<AccountRecord> {
    const appleId = input.appleId.trim();
    if (!appleId || !input.password) {
      throw new SideloadError("invalid_input", "Enter the Apple ID and its password.");
    }
    const accounts = this.deps.storage.listAccounts();
    const existing = accounts.find(
      (account) =>
        account.auth === "apple_id" && account.appleId.toLowerCase() === appleId.toLowerCase(),
    );
    const firstAppleId = !accounts.some((account) => account.auth === "apple_id");
    if (firstAppleId && !input.acceptedTerms) {
      throw new SideloadError(
        "terms_required",
        "Confirm Apple's terms before adding the first Apple ID.",
      );
    }
    const draft = this.draftAppleId(input, appleId, existing ?? null);
    try {
      const auth = await this.login(draft, input.password, true);
      await this.deps.storage.setXcodeAuth(draft.id, auth);
      const team = pickTeam(await this.developerServices(draft).listTeams());
      const account: AccountRecord = {
        ...draft,
        kind: team.kind,
        teamId: team.teamId,
        teamName: team.name,
      };
      await this.deps.storage.setPassword(account.id, input.keepSignedIn ? input.password : null);
      this.deps.storage.upsertAccount(account);
      this.deps.logger.info(
        { accountId: account.id, kind: account.kind },
        "sideload account signed in",
      );
      return account;
    } catch (error) {
      if (!existing) {
        await this.deps.storage.setXcodeAuth(draft.id, null);
        await this.deps.storage.setAnisetteIdentity(draft.id, null);
      }
      throw toSideloadError(error);
    }
  }

  private draftAppleId(
    input: AddAppleIdInput,
    appleId: string,
    existing: AccountRecord | null,
  ): AccountRecord {
    const source =
      input.anisetteSource ?? existing?.anisetteSource ?? defaultAnisetteSource(this.deps.platform);
    const url = input.anisetteUrl ?? existing?.anisetteUrl ?? null;
    return {
      id: existing?.id ?? newAccountId(),
      appleId,
      kind: existing?.kind ?? "free",
      auth: "apple_id",
      teamId: existing?.teamId ?? null,
      teamName: existing?.teamName ?? null,
      keepSignedIn: input.keepSignedIn,
      anisetteSource: source,
      anisetteUrl: source === "remote" ? validRemoteUrl(url) : null,
      createdAt_ms: existing?.createdAt_ms ?? this.deps.now(),
      ascIssuerId: null,
      ascKeyId: null,
    };
  }

  private async addAscKey(input: AddAscKeyInput): Promise<AccountRecord> {
    const issuerId = input.issuerId.trim();
    const keyId = input.keyId.trim();
    if (!issuerId || !keyId || !input.privateKeyP8.includes("PRIVATE KEY")) {
      throw new SideloadError("invalid_input", "Enter the Issuer ID, Key ID and the .p8 key file.");
    }
    try {
      createPrivateKey(input.privateKeyP8);
    } catch {
      throw new SideloadError("invalid_input", "The .p8 file is not a valid private key.");
    }
    const existing = this.deps.storage
      .listAccounts()
      .find((account) => account.auth === "asc_api_key" && account.ascKeyId === keyId);
    const client = new AppStoreConnectClient(
      { issuerId, keyId, privateKey: input.privateKeyP8 },
      this.deps.appleHttp,
      this.deps.now,
    );
    let teams: TeamInfo[];
    try {
      teams = await client.listTeams();
    } catch (error) {
      throw toSideloadError(error);
    }
    const account: AccountRecord = {
      id: existing?.id ?? newAccountId(),
      appleId: `ASC key ${keyId}`,
      kind: "paid",
      auth: "asc_api_key",
      teamId: teams[0]?.teamId ?? null,
      teamName: teams[0]?.name ?? "App Store Connect",
      keepSignedIn: true,
      anisetteSource: "none",
      anisetteUrl: null,
      createdAt_ms: existing?.createdAt_ms ?? this.deps.now(),
      ascIssuerId: issuerId,
      ascKeyId: keyId,
    };
    await this.deps.storage.setAscPrivateKey(account.id, input.privateKeyP8);
    this.deps.storage.upsertAccount(account);
    return account;
  }

  async remove(accountId: string): Promise<void> {
    this.require(accountId);
    await this.deps.storage.removeAccount(accountId);
  }

  async setAnisette(
    accountId: string,
    source: SideloadAnisetteSource,
    url: string | null,
  ): Promise<AccountRecord> {
    const account = this.require(accountId);
    if (account.auth !== "apple_id" || source === "none") {
      throw new SideloadError("invalid_input", "Only Apple ID accounts use anisette.");
    }
    const next: AccountRecord = {
      ...account,
      anisetteSource: source,
      anisetteUrl: source === "remote" ? validRemoteUrl(url) : null,
    };
    // A new source is a new machine for Apple: drop the old identity.
    await this.deps.storage.setAnisetteIdentity(accountId, null);
    this.deps.storage.upsertAccount(next);
    return next;
  }

  async setKeepSignedIn(
    accountId: string,
    keepSignedIn: boolean,
    password: string | null,
  ): Promise<AccountRecord> {
    const account = this.require(accountId);
    if (account.auth !== "apple_id") {
      throw new SideloadError("invalid_input", "API key accounts are always signed in.");
    }
    if (keepSignedIn && !password) {
      throw new SideloadError(
        "invalid_input",
        "Enter the password to keep this Apple ID signed in.",
      );
    }
    if (keepSignedIn && password) {
      // Check the password before keeping it.
      const auth = await this.login(account, password, true).catch((error: unknown) => {
        throw toSideloadError(error);
      });
      await this.deps.storage.setXcodeAuth(accountId, auth);
    }
    await this.deps.storage.setPassword(accountId, keepSignedIn ? password : null);
    const next = { ...account, keepSignedIn };
    this.deps.storage.upsertAccount(next);
    return next;
  }

  require(accountId: string): AccountRecord {
    const account = this.deps.storage.getAccount(accountId);
    if (!account) throw new SideloadError("not_found", "That Apple account no longer exists.");
    return account;
  }

  // ── 2FA relay ──

  respond(promptId: string, answer: TwoFactorAnswer): void {
    const pending = this.prompts.get(promptId);
    if (!pending) throw new SideloadError("not_found", "This verification request has expired.");
    clearTimeout(pending.timer);
    this.prompts.delete(promptId);
    this.deps.emitPromptResolved(promptId);
    pending.resolve(answer);
  }

  private relayPrompt(appleId: string): TwoFactorPrompt {
    return (request: TwoFactorRequest) =>
      new Promise<TwoFactorAnswer>((resolve) => {
        const promptId = `slp_${randomUUID()}`;
        const timer = setTimeout(() => {
          this.prompts.delete(promptId);
          this.deps.emitPromptResolved(promptId);
          resolve({ action: "cancel" });
        }, PROMPT_TTL_MS);
        this.prompts.set(promptId, { resolve, timer });
        this.deps.emitPrompt({
          type: "sideload.auth.prompt",
          promptId,
          appleId,
          method: request.method,
          phoneNumbers: request.phoneNumbers,
          message: request.message,
          expiresAt_ms: this.deps.now() + PROMPT_TTL_MS,
        });
      });
  }

  // ── sessions ──

  async anisette(account: AccountRecord): Promise<AnisetteResult> {
    const identity =
      (await this.deps.storage.getAnisetteIdentity(account.id)) ?? newAnisetteIdentity();
    const adapter =
      account.anisetteSource === "remote"
        ? new RemoteAnisette(
            validRemoteUrl(account.anisetteUrl),
            this.deps.anisetteServerHttp,
            this.deps.appleHttp,
          )
        : this.deps.nativeAnisette();
    const result = await adapter.fetch(identity);
    if (
      JSON.stringify(result.identity) !== JSON.stringify(identity) ||
      !(await this.deps.storage.getAnisetteIdentity(account.id))
    ) {
      await this.deps.storage.setAnisetteIdentity(account.id, result.identity);
    }
    return result;
  }

  private async login(
    account: AccountRecord,
    password: string,
    interactive: boolean,
  ): Promise<XcodeAuth> {
    const gsa = new GsaClient({
      http: this.deps.appleHttp,
      anisette: () => this.anisette(account),
    });
    const twoFactor: TwoFactorPrompt = interactive
      ? this.relayPrompt(account.appleId)
      : async () => {
          throw new SideloadError(
            "sign_in_required",
            `Apple asked ${account.appleId} for a verification code. Sign in again.`,
          );
        };
    return gsa.login({ appleId: account.appleId, password, twoFactor });
  }

  /** A valid Xcode token: stored, or a fresh sign-in with the kept password. */
  private async xcodeAuth(account: AccountRecord, interactive: boolean): Promise<XcodeAuth> {
    const stored = await this.deps.storage.getXcodeAuth(account.id);
    if (stored && stored.expiresAt_ms - TOKEN_MARGIN_MS > this.deps.now()) return stored;
    const password = account.keepSignedIn ? await this.deps.storage.getPassword(account.id) : null;
    if (!password) {
      throw new SideloadError("sign_in_required", `Sign in again to ${account.appleId}.`);
    }
    const auth = await this.login(account, password, interactive);
    await this.deps.storage.setXcodeAuth(account.id, auth);
    return auth;
  }

  private developerServices(account: AccountRecord, interactive = true): DeveloperServicesClient {
    return new DeveloperServicesClient({
      http: this.deps.appleHttp,
      auth: () => this.xcodeAuth(account, interactive),
      anisette: async () => (await this.anisette(account)).data,
    });
  }

  /**
   * The team API for an account. A Developer Services session Apple rejected is dropped
   * once and signed in again (with the kept password) before the error reaches the user.
   */
  async team(accountId: string, interactive: boolean): Promise<TeamSession> {
    const account = this.require(accountId);
    if (account.auth === "asc_api_key") {
      const privateKey = await this.deps.storage.getAscPrivateKey(account.id);
      if (!privateKey || !account.ascIssuerId || !account.ascKeyId) {
        throw new SideloadError("sign_in_required", "Add the App Store Connect key again.");
      }
      const api = new AppStoreConnectClient(
        { issuerId: account.ascIssuerId, keyId: account.ascKeyId, privateKey },
        this.deps.appleHttp,
        this.deps.now,
      );
      const teamId = account.teamId ?? (await api.listTeams())[0]?.teamId ?? "";
      return { account, api, teamId };
    }
    if (!account.teamId)
      throw new SideloadError("team_unavailable", "Sign in again to load the team.");
    const client = this.developerServices(account, interactive);
    const api = this.retryingOnExpiry(account, client);
    return { account, api, teamId: account.teamId };
  }

  private retryingOnExpiry(account: AccountRecord, client: AppleTeamApi): AppleTeamApi {
    const storage = this.deps.storage;
    const wrap =
      <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        try {
          return await call(...args);
        } catch (error) {
          if (!(error instanceof TeamApiError) || error.code !== "session_expired") throw error;
          await storage.setXcodeAuth(account.id, null);
          return call(...args);
        }
      };
    return {
      listTeams: wrap(() => client.listTeams()),
      listDevices: wrap((teamId: string) => client.listDevices(teamId)),
      addDevice: wrap((teamId: string, input: { udid: string; name: string }) =>
        client.addDevice(teamId, input),
      ),
      listCerts: wrap((teamId: string) => client.listCerts(teamId)),
      submitCsr: wrap(
        (teamId: string, input: { csrPem: string; machineName: string; machineId: string }) =>
          client.submitCsr(teamId, input),
      ),
      revokeCert: wrap((teamId: string, cert: Parameters<AppleTeamApi["revokeCert"]>[1]) =>
        client.revokeCert(teamId, cert),
      ),
      listAppIds: wrap((teamId: string) => client.listAppIds(teamId)),
      addAppId: wrap((teamId: string, input: { bundleId: string; name: string }) =>
        client.addAppId(teamId, input),
      ),
      profile: wrap((teamId: string, input: Parameters<AppleTeamApi["profile"]>[1]) =>
        client.profile(teamId, input),
      ),
    };
  }
}
