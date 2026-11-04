import { createHash, randomBytes, randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { AppleHttpError, type AppleHttp } from "./http.js";
import { asDict, asString, buildXmlPlist, parsePlistDict } from "../plist.js";

/**
 * Anisette (26.4): the one-time machine headers GrandSlam and Developer Services require.
 * `native` asks the OS (macOS: AOSKit through JavaScript for Automation, no helper
 * binary); `remote` asks an anisette server the user runs (v3 protocol, v1 fallback).
 * There is no default public server (ADR-0032 §2).
 *
 * The machine identity (local user id, device id, a v3 server's `adi_pb`) lets Apple
 * remember this machine and skip 2FA, so it is a secret equal to the password: it lives
 * in the sideload secret store and only travels to the remote server the user chose.
 */

export interface AnisetteIdentity {
  localUserId: string;
  deviceId: string;
  /** v3 remote servers only. */
  remoteIdentifier: string | null;
  remoteAdiPb: string | null;
}

export interface AnisetteData {
  "X-Apple-I-MD": string;
  "X-Apple-I-MD-M": string;
  "X-Apple-I-MD-RINFO": string;
  "X-Apple-I-MD-LU": string;
  "X-Mme-Device-Id": string;
  "X-Apple-I-SRL-NO": string;
  "X-Mme-Client-Info": string;
  "X-Apple-I-Client-Time": string;
  "X-Apple-Locale": string;
  "X-Apple-I-TimeZone": string;
}

export interface AnisetteResult {
  data: AnisetteData;
  userAgent: string;
  /** The identity, updated when a v3 server provisioned this machine. */
  identity: AnisetteIdentity;
}

export interface AnisetteSourceAdapter {
  fetch(identity: AnisetteIdentity): Promise<AnisetteResult>;
}

export type AnisetteErrorCode = "native_unavailable" | "remote_failed" | "remote_url_required";

export class AnisetteError extends Error {
  constructor(
    readonly code: AnisetteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnisetteError";
  }
}

export const XCODE_AUTHKIT = "<com.apple.AuthKit/1 (com.apple.dt.Xcode/3594.4.19)>";
const DEFAULT_RINFO = "17106176";

export function newAnisetteIdentity(): AnisetteIdentity {
  return {
    localUserId: randomUUID().toUpperCase(),
    deviceId: randomUUID().toUpperCase(),
    remoteIdentifier: null,
    remoteAdiPb: null,
  };
}

function localUserHeader(identity: AnisetteIdentity): string {
  return createHash("sha256").update(identity.localUserId).digest("hex").toUpperCase();
}

function clientTime(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// ── native macOS ────────────────────────────────────────────────────────────

export type RunCommand = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

// Loads the AOSKit private framework into osascript and asks it for this machine's OTP
// headers (dsid -2). Prints JSON on stdout; the daemon never logs it.
const AOSKIT_JXA = `
ObjC.import('Foundation');
$.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/AOSKit.framework').loadAndReturnError(null);
var cls = $.NSClassFromString('AOSUtilities');
if (!cls) { throw new Error('AOSUtilities is not available'); }
var headers = cls.retrieveOTPHeadersForDSID($('-2'));
var md = ObjC.unwrap(headers.objectForKey('X-Apple-MD'));
var mid = ObjC.unwrap(headers.objectForKey('X-Apple-MD-M'));
if (!md || !mid) { throw new Error('AOSKit returned no anisette headers'); }
JSON.stringify({ md: md, mid: mid });
`;

export interface MacMachineInfo {
  model: string;
  osVersion: string;
  osBuild: string;
}

export class NativeMacAnisette implements AnisetteSourceAdapter {
  constructor(
    private readonly run: RunCommand,
    private readonly machine: () => Promise<MacMachineInfo>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetch(identity: AnisetteIdentity): Promise<AnisetteResult> {
    const result = await this.run("osascript", ["-l", "JavaScript", "-e", AOSKIT_JXA]);
    if (result.code !== 0) {
      throw new AnisetteError(
        "native_unavailable",
        `macOS did not return anisette data (${result.stderr.trim() || `exit ${result.code}`}). Switch the account to a remote anisette server.`,
      );
    }
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { md?: unknown }).md !== "string" ||
      typeof (parsed as { mid?: unknown }).mid !== "string"
    ) {
      throw new AnisetteError("native_unavailable", "macOS returned malformed anisette data");
    }
    const { md, mid } = parsed as { md: string; mid: string };
    const machine = await this.machine();
    const clientInfo = `<${machine.model}> <Mac OS X;${machine.osVersion};${machine.osBuild}> ${XCODE_AUTHKIT}`;
    return {
      identity,
      userAgent: "akd/1.0 CFNetwork/978.0.7 Darwin/18.7.0",
      data: {
        "X-Apple-I-MD": md,
        "X-Apple-I-MD-M": mid,
        "X-Apple-I-MD-RINFO": DEFAULT_RINFO,
        "X-Apple-I-MD-LU": localUserHeader(identity),
        "X-Mme-Device-Id": identity.deviceId,
        "X-Apple-I-SRL-NO": "0",
        "X-Mme-Client-Info": clientInfo,
        "X-Apple-I-Client-Time": clientTime(this.now()),
        "X-Apple-Locale": "en_US",
        "X-Apple-I-TimeZone": timeZone(),
      },
    };
  }
}

/** Windows' native source needs iCloud for Windows' CoreADI; this build cannot load it. */
export class UnavailableNativeAnisette implements AnisetteSourceAdapter {
  constructor(private readonly reason: string) {}
  async fetch(): Promise<AnisetteResult> {
    throw new AnisetteError("native_unavailable", this.reason);
  }
}

// ── remote anisette server (v3, v1 fallback) ────────────────────────────────

interface V3ClientInfo {
  clientInfo: string;
  userAgent: string;
}

const GSA_LOOKUP_URL = "https://gsa.apple.com/grandslam/GsService2/lookup";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function jsonObject(body: Buffer, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new AnisetteError(
      "remote_failed",
      `${what}: not JSON (${body.toString("utf8").slice(0, 200)})`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AnisetteError("remote_failed", `${what}: unexpected response`);
  }
  return parsed as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (reason: string) => void): void;
}

export type OpenWebSocket = (
  url: string,
  headers: Record<string, string>,
) => Promise<WebSocketLike>;

export const openNodeWebSocket: OpenWebSocket = (url, headers) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    // The server speaks first (GiveIdentifier), possibly before the caller subscribes:
    // queue frames until a handler is attached.
    const queued: string[] = [];
    let onText: ((text: string) => void) | null = null;
    socket.on("message", (data) => {
      const text = data.toString();
      if (onText) onText(text);
      else queued.push(text);
    });
    socket.once("open", () => {
      resolve({
        send: (data) => socket.send(data),
        close: () => socket.close(),
        onMessage: (handler) => {
          onText = handler;
          for (const text of queued.splice(0)) handler(text);
        },
        onClose: (handler) => socket.on("close", (_code, reason) => handler(reason.toString())),
      });
    });
    socket.once("error", (error) =>
      reject(new AnisetteError("remote_failed", `Anisette provisioning socket: ${error.message}`)),
    );
  });

interface ProvisioningMessage {
  text: string;
  socket: WebSocketLike;
  next: AnisetteIdentity;
  info: V3ClientInfo;
  urls: { start: string; finish: string };
}

export class RemoteAnisette implements AnisetteSourceAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly http: AppleHttp,
    private readonly appleHttp: AppleHttp,
    private readonly openSocket: OpenWebSocket = openNodeWebSocket,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetch(identity: AnisetteIdentity): Promise<AnisetteResult> {
    const base = trimSlash(this.baseUrl);
    const info = await this.clientInfo(base);
    if (!info) return this.fetchV1(base, identity);
    let current = identity;
    if (!current.remoteIdentifier || !current.remoteAdiPb) {
      current = await this.provision(base, info, identity);
    }
    const response = await this.http({
      method: "POST",
      url: `${base}/v3/get_headers`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: current.remoteIdentifier, adi_pb: current.remoteAdiPb }),
    });
    const record = jsonObject(response.body, "Anisette server /v3/get_headers");
    if (response.status !== 200 || stringField(record, "result") !== "Headers") {
      throw new AnisetteError(
        "remote_failed",
        `Anisette server returned ${response.status}: ${stringField(record, "message") ?? response.body.toString("utf8").slice(0, 300)}`,
      );
    }
    const md = stringField(record, "X-Apple-I-MD");
    const mid = stringField(record, "X-Apple-I-MD-M");
    if (!md || !mid) throw new AnisetteError("remote_failed", "Anisette server sent no headers");
    return {
      identity: current,
      userAgent: info.userAgent,
      data: this.compose(current, info.clientInfo, {
        md,
        mid,
        rinfo: stringField(record, "X-Apple-I-MD-RINFO") ?? DEFAULT_RINFO,
      }),
    };
  }

  private compose(
    identity: AnisetteIdentity,
    clientInfo: string,
    values: { md: string; mid: string; rinfo: string },
  ): AnisetteData {
    return {
      "X-Apple-I-MD": values.md,
      "X-Apple-I-MD-M": values.mid,
      "X-Apple-I-MD-RINFO": values.rinfo,
      "X-Apple-I-MD-LU": localUserHeader(identity),
      "X-Mme-Device-Id": identity.deviceId,
      "X-Apple-I-SRL-NO": "0",
      "X-Mme-Client-Info": clientInfo,
      "X-Apple-I-Client-Time": clientTime(this.now()),
      "X-Apple-Locale": "en_US",
      "X-Apple-I-TimeZone": timeZone(),
    };
  }

  private async clientInfo(base: string): Promise<V3ClientInfo | null> {
    const response = await this.http({
      method: "GET",
      url: `${base}/v3/client_info`,
      headers: {},
    }).catch((error: unknown) => {
      if (!(error instanceof AppleHttpError)) throw error;
      throw new AnisetteError(
        "remote_failed",
        `Could not reach the anisette server at ${base} (${error.message}). Check that it is running.`,
      );
    });
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new AnisetteError(
        "remote_failed",
        `Anisette server returned ${response.status}: ${response.body.toString("utf8").slice(0, 300)}`,
      );
    }
    const record = jsonObject(response.body, "Anisette server /v3/client_info");
    const clientInfo = stringField(record, "client_info");
    const userAgent = stringField(record, "user_agent");
    if (!clientInfo || !userAgent) {
      throw new AnisetteError("remote_failed", "Anisette server /v3/client_info is incomplete");
    }
    return { clientInfo, userAgent };
  }

  /** v1 servers answer GET / with the headers of their own (shared) machine. */
  private async fetchV1(base: string, identity: AnisetteIdentity): Promise<AnisetteResult> {
    const response = await this.http({ method: "GET", url: `${base}/`, headers: {} });
    if (response.status !== 200) {
      throw new AnisetteError(
        "remote_failed",
        `Anisette server returned ${response.status}: ${response.body.toString("utf8").slice(0, 300)}`,
      );
    }
    const record = jsonObject(response.body, "Anisette server");
    const md = stringField(record, "X-Apple-I-MD");
    const mid = stringField(record, "X-Apple-I-MD-M");
    if (!md || !mid) throw new AnisetteError("remote_failed", "Anisette server sent no headers");
    const clientInfo =
      stringField(record, "X-MMe-Client-Info") ?? stringField(record, "X-Mme-Client-Info");
    const v1Identity: AnisetteIdentity = {
      ...identity,
      deviceId: stringField(record, "X-Mme-Device-Id") ?? identity.deviceId,
    };
    const data = this.compose(
      v1Identity,
      clientInfo ?? `<MacBookPro15,1> <Mac OS X;10.15.2;19C57> ${XCODE_AUTHKIT}`,
      {
        md,
        mid,
        rinfo: stringField(record, "X-Apple-I-MD-RINFO") ?? DEFAULT_RINFO,
      },
    );
    const lu = stringField(record, "X-Apple-I-MD-LU");
    if (lu) data["X-Apple-I-MD-LU"] = lu;
    return { identity, userAgent: "akd/1.0 CFNetwork/978.0.7 Darwin/18.7.0", data };
  }

  private appleHeaders(identity: AnisetteIdentity, info: V3ClientInfo): Record<string, string> {
    return {
      "User-Agent": info.userAgent,
      "X-Mme-Client-Info": info.clientInfo,
      "X-Apple-I-MD-LU": localUserHeader(identity),
      "X-Mme-Device-Id": identity.deviceId,
      "X-Apple-I-Client-Time": clientTime(this.now()),
      "X-Apple-I-TimeZone": timeZone(),
      "X-Apple-Locale": "en_US",
      "X-Apple-I-SRL-NO": "0",
      "Content-Type": "text/x-xml-plist",
      Accept: "*/*",
    };
  }

  private async provisioningUrls(
    identity: AnisetteIdentity,
    info: V3ClientInfo,
  ): Promise<{ start: string; finish: string }> {
    const response = await this.appleHttp({
      method: "GET",
      url: GSA_LOOKUP_URL,
      headers: this.appleHeaders(identity, info),
    });
    const urls = asDict(parsePlistDict(response.body).urls);
    const start = asString(urls?.midStartProvisioning);
    const finish = asString(urls?.midFinishProvisioning);
    if (!start || !finish) {
      throw new AnisetteError("remote_failed", "Apple lookup returned no provisioning URLs");
    }
    return { start, finish };
  }

  private async postProvisioning(
    url: string,
    identity: AnisetteIdentity,
    info: V3ClientInfo,
    request: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await this.appleHttp({
      method: "POST",
      url,
      headers: this.appleHeaders(identity, info),
      body: buildXmlPlist({ Header: {}, Request: request }),
    });
    const dict = asDict(parsePlistDict(response.body).Response);
    if (!dict)
      throw new AnisetteError("remote_failed", `Apple provisioning returned ${response.status}`);
    return dict as Record<string, unknown>;
  }

  /** v3 provisioning session: the server holds the ADI, Apple sees one new machine. */
  private async provision(
    base: string,
    info: V3ClientInfo,
    identity: AnisetteIdentity,
  ): Promise<AnisetteIdentity> {
    const identifier = randomBytes(16).toString("base64");
    const next: AnisetteIdentity = { ...identity, remoteIdentifier: identifier, remoteAdiPb: null };
    const urls = await this.provisioningUrls(next, info);
    const wsUrl = `${base.replace(/^http/, "ws")}/v3/provisioning_session`;
    const socket = await this.openSocket(wsUrl, {});
    return new Promise<AnisetteIdentity>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new AnisetteError("remote_failed", message));
      };
      socket.onClose((reason) => fail(`Anisette provisioning closed early ${reason}`.trim()));
      socket.onMessage((text) => {
        void this.handleProvisioningMessage(
          { text, socket, next, info, urls },
          (adiPb) => {
            if (settled) return;
            settled = true;
            socket.close();
            resolve({ ...next, remoteAdiPb: adiPb });
          },
          fail,
        );
      });
    });
  }

  private async handleProvisioningMessage(
    input: ProvisioningMessage,
    done: (adiPb: string) => void,
    fail: (message: string) => void,
  ): Promise<void> {
    try {
      const adiPb = await this.onProvisioningMessage(input);
      if (adiPb !== null) done(adiPb);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async onProvisioningMessage(input: {
    text: string;
    socket: WebSocketLike;
    next: AnisetteIdentity;
    info: V3ClientInfo;
    urls: { start: string; finish: string };
  }): Promise<string | null> {
    const message = jsonObject(Buffer.from(input.text), "Anisette provisioning");
    const result = stringField(message, "result");
    switch (result) {
      case "GiveIdentifier":
        input.socket.send(JSON.stringify({ identifier: input.next.remoteIdentifier }));
        return null;
      case "GiveStartProvisioningData": {
        const response = await this.postProvisioning(input.urls.start, input.next, input.info, {});
        const spim = typeof response.spim === "string" ? response.spim : null;
        if (!spim) throw new Error("Apple start-provisioning returned no spim");
        input.socket.send(JSON.stringify({ spim }));
        return null;
      }
      case "GiveEndProvisioningData": {
        const cpim = stringField(message, "cpim");
        if (!cpim) throw new Error("Anisette server sent no cpim");
        const response = await this.postProvisioning(input.urls.finish, input.next, input.info, {
          cpim,
        });
        const ptm = typeof response.ptm === "string" ? response.ptm : null;
        const tk = typeof response.tk === "string" ? response.tk : null;
        if (!ptm || !tk) throw new Error("Apple finish-provisioning returned no ptm/tk");
        input.socket.send(JSON.stringify({ ptm, tk }));
        return null;
      }
      case "ProvisioningSuccess": {
        const adiPb = stringField(message, "adi_pb");
        if (!adiPb) throw new Error("Anisette server sent no adi_pb");
        return adiPb;
      }
      default:
        throw new Error(
          `Anisette provisioning failed: ${result ?? "unknown"}${stringField(message, "message") ? ` — ${stringField(message, "message")}` : ""}`,
        );
    }
  }
}
