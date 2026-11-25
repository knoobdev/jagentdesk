import net from "node:net";
import type pino from "pino";

// A minimal usbmuxd client (the protocol iproxy/go-ios speak): list devices and open a raw TCP
// tunnel to a port on one of them. The daemon uses it to reach WebDriverAgent on the device and
// re-exposes it on 127.0.0.1 only (ADR-0033 decision 3) — go-ios' own forwarder binds 0.0.0.0.

const USBMUX_VERSION_PLIST = 1;
const USBMUX_MESSAGE_PLIST = 8;

export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistNode(value: PlistValue): string {
  if (typeof value === "string") return `<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return `<integer>${Math.trunc(value)}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistNode).join("")}</array>`;
  const entries = Object.entries(value)
    .map(([key, child]) => `<key>${escapeXml(key)}</key>${plistNode(child)}`)
    .join("");
  return `<dict>${entries}</dict>`;
}

export function buildPlist(value: PlistValue): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistNode(value)}</plist>\n`;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

type PlistToken = RegExpMatchArray;

function isClosing(token: PlistToken | undefined, tag: string): boolean {
  return Boolean(token && token[1] && token[2] === tag);
}

// Recursive-descent reader over the tag tokens; `cursor.index` walks the token list.
class PlistReader {
  index = 0;
  constructor(private readonly tokens: PlistToken[]) {}

  value(): PlistValue | null {
    const token = this.tokens[this.index];
    if (!token) return null;
    this.index += 1;
    const [, closing, tag, selfClosing, text] = token;
    if (closing) return null;
    if (tag === "true" || tag === "false") return tag === "true";
    if (tag === "array") return selfClosing ? [] : this.array();
    if (tag === "dict") return selfClosing ? {} : this.dict();
    if (selfClosing) return "";
    this.index += 1; // the closing tag
    if (tag === "integer" || tag === "real") return Number(text.trim());
    return unescapeXml(text);
  }

  private array(): PlistValue[] {
    const items: PlistValue[] = [];
    while (this.tokens[this.index] && !isClosing(this.tokens[this.index], "array")) {
      const item = this.value();
      if (item !== null) items.push(item);
    }
    this.index += 1;
    return items;
  }

  private dict(): { [key: string]: PlistValue } {
    const dict: { [key: string]: PlistValue } = {};
    while (this.tokens[this.index] && !isClosing(this.tokens[this.index], "dict")) {
      const keyToken = this.tokens[this.index];
      this.index += 1;
      if (keyToken[2] !== "key" || keyToken[1]) continue;
      this.index += 1; // </key>
      const value = this.value();
      if (value !== null) dict[unescapeXml(keyToken[4])] = value;
    }
    this.index += 1;
    return dict;
  }
}

// Parses the XML plists usbmuxd answers with (dict, array, string, integer, real, bool, data, date).
export function parsePlist(xml: string): PlistValue | null {
  if (xml.indexOf("<plist") < 0) return null;
  const tokens = Array.from(
    xml.matchAll(/<(\/?)(dict|array|key|string|integer|real|true|false|data|date)(\/?)>([^<]*)/g),
  );
  return new PlistReader(tokens).value();
}

export function encodeUsbmuxMessage(payload: PlistValue, tag: number): Buffer {
  const body = Buffer.from(buildPlist(payload), "utf8");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + body.length, 0);
  header.writeUInt32LE(USBMUX_VERSION_PLIST, 4);
  header.writeUInt32LE(USBMUX_MESSAGE_PLIST, 8);
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, body]);
}

function usbmuxAddress(): net.NetConnectOpts {
  if (process.platform === "win32") return { host: "127.0.0.1", port: 27015 };
  return { path: "/var/run/usbmuxd" };
}

// usbmuxd wants the device port in network byte order inside a little-endian integer.
export function usbmuxPort(port: number): number {
  return ((port & 0xff) << 8) | ((port >> 8) & 0xff);
}

function request(
  payload: PlistValue,
): Promise<{ socket: net.Socket; reply: { [key: string]: PlistValue } }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(usbmuxAddress());
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 16) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length) return;
      socket.removeListener("data", onData);
      socket.removeListener("error", reject);
      const reply = parsePlist(buffer.subarray(16, length).toString("utf8"));
      const rest = buffer.subarray(length);
      if (rest.length > 0) socket.unshift(rest);
      if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
        socket.destroy();
        reject(new Error("usbmuxd sent an unreadable reply"));
        return;
      }
      resolve({ socket, reply });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(encodeUsbmuxMessage(payload, 1)));
  });
}

const CLIENT_FIELDS = { ClientVersionString: "jagentdesk", ProgName: "jagentdesk" };

export async function usbmuxDeviceIds(): Promise<Map<string, number>> {
  const { socket, reply } = await request({ MessageType: "ListDevices", ...CLIENT_FIELDS });
  socket.destroy();
  const ids = new Map<string, number>();
  const list = reply.DeviceList;
  if (!Array.isArray(list)) return ids;
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const properties = entry.Properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) continue;
    const serial = properties.SerialNumber;
    const id = properties.DeviceID;
    if (typeof serial === "string" && typeof id === "number" && !ids.has(serial)) {
      ids.set(serial, id);
    }
  }
  return ids;
}

export async function usbmuxConnect(deviceId: number, port: number): Promise<net.Socket> {
  const { socket, reply } = await request({
    MessageType: "Connect",
    DeviceID: deviceId,
    PortNumber: usbmuxPort(port),
    ...CLIENT_FIELDS,
  });
  if (reply.Number !== 0) {
    socket.destroy();
    throw new Error(
      `usbmuxd refused the connection to device port ${port} (${String(reply.Number)})`,
    );
  }
  return socket;
}

export interface LoopbackForward {
  port: number;
  close(): void;
}

// 127.0.0.1:<ephemeral> → device:<devicePort>, one usbmux tunnel per accepted connection.
export function startLoopbackForward(options: {
  udid: string;
  devicePort: number;
  logger: pino.Logger;
}): Promise<LoopbackForward> {
  const { udid, devicePort, logger } = options;
  const server = net.createServer((client) => {
    client.pause();
    void usbmuxDeviceIds()
      .then((ids) => {
        const id = ids.get(udid);
        if (id === undefined) throw new Error(`device ${udid} is not attached`);
        return usbmuxConnect(id, devicePort);
      })
      .then((tunnel) => {
        client.pipe(tunnel).pipe(client);
        client.resume();
        tunnel.on("error", () => client.destroy());
        client.on("error", () => tunnel.destroy());
        return undefined;
      })
      .catch((error: unknown) => {
        logger.debug({ err: error, udid, devicePort }, "usbmux forward failed");
        client.destroy();
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("forward did not bind"));
        return;
      }
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}
