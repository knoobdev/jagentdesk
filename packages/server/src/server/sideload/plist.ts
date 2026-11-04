/**
 * Property lists for sideload: XML (Apple GrandSlam, Developer Services, provisioning
 * profiles, Info.plist written back) and binary `bplist00` (Info.plist inside most built
 * IPAs). Written from Apple's documented formats; integers decode to `number`.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Buffer
  | PlistValue[]
  | { [key: string]: PlistValue };

export interface PlistDict {
  [key: string]: PlistValue;
}

export class PlistParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlistParseError";
  }
}

const XML_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isDict(value: PlistValue): value is PlistDict {
  return (
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value)
  );
}

function encodeValue(value: PlistValue, indent: string, out: string[]): void {
  if (typeof value === "string") {
    out.push(`${indent}<string>${escapeXml(value)}</string>`);
  } else if (typeof value === "number") {
    const tag = Number.isInteger(value) ? "integer" : "real";
    out.push(`${indent}<${tag}>${value}</${tag}>`);
  } else if (typeof value === "boolean") {
    out.push(`${indent}<${value ? "true" : "false"}/>`);
  } else if (value instanceof Date) {
    out.push(`${indent}<date>${value.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`);
  } else if (Buffer.isBuffer(value)) {
    out.push(`${indent}<data>${value.toString("base64")}</data>`);
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${indent}<array/>`);
      return;
    }
    out.push(`${indent}<array>`);
    for (const item of value) encodeValue(item, `${indent}\t`, out);
    out.push(`${indent}</array>`);
  } else {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.push(`${indent}<dict/>`);
      return;
    }
    out.push(`${indent}<dict>`);
    for (const key of keys) {
      out.push(`${indent}\t<key>${escapeXml(key)}</key>`);
      encodeValue(value[key]!, `${indent}\t`, out);
    }
    out.push(`${indent}</dict>`);
  }
}

export function buildXmlPlist(value: PlistValue): string {
  const out: string[] = [];
  encodeValue(value, "", out);
  return `${XML_HEADER}${out.join("\n")}\n</plist>\n`;
}

// ── XML parsing ─────────────────────────────────────────────────────────────

interface XmlToken {
  kind: "open" | "close" | "empty" | "text";
  name: string;
  text: string;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_match, entity: string) => {
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "amp") return "&";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function tokenize(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    if (lt === -1) {
      tokens.push({ kind: "text", name: "", text: xml.slice(index) });
      break;
    }
    if (lt > index) tokens.push({ kind: "text", name: "", text: xml.slice(index, lt) });
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      if (end === -1) throw new PlistParseError("Unterminated comment");
      index = end + 3;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt === -1) throw new PlistParseError("Unterminated tag");
    const raw = xml.slice(lt + 1, gt);
    index = gt + 1;
    if (raw.startsWith("?") || raw.startsWith("!")) continue;
    if (raw.startsWith("/")) {
      tokens.push({ kind: "close", name: raw.slice(1).trim(), text: "" });
    } else if (raw.endsWith("/")) {
      tokens.push({ kind: "empty", name: raw.slice(0, -1).trim().split(/\s/)[0]!, text: "" });
    } else {
      tokens.push({ kind: "open", name: raw.trim().split(/\s/)[0]!, text: "" });
    }
  }
  return tokens.filter((token) => token.kind !== "text" || token.text.trim() !== "");
}

class XmlReader {
  private position = 0;
  constructor(private readonly tokens: XmlToken[]) {}

  private next(): XmlToken {
    const token = this.tokens[this.position];
    if (!token) throw new PlistParseError("Unexpected end of plist");
    this.position += 1;
    return token;
  }

  private peek(): XmlToken | undefined {
    return this.tokens[this.position];
  }

  private readText(name: string): string {
    const token = this.next();
    if (token.kind === "close" && token.name === name) return "";
    if (token.kind !== "text") throw new PlistParseError(`Expected text in <${name}>`);
    const close = this.next();
    if (close.kind !== "close" || close.name !== name) {
      throw new PlistParseError(`Expected </${name}>`);
    }
    return decodeEntities(token.text);
  }

  readDocument(): PlistValue {
    const first = this.peek();
    if (first?.kind === "open" && first.name === "plist") {
      this.next();
      const value = this.readValue();
      return value;
    }
    return this.readValue();
  }

  readValue(): PlistValue {
    const token = this.next();
    if (token.kind === "empty") return emptyValue(token.name);
    if (token.kind !== "open") throw new PlistParseError(`Unexpected ${token.kind} token`);
    switch (token.name) {
      case "dict":
        return this.readDict();
      case "array":
        return this.readArray();
      case "string":
        return this.readText("string");
      case "integer":
        return Number.parseInt(this.readText("integer").trim(), 10);
      case "real":
        return Number.parseFloat(this.readText("real").trim());
      case "date":
        return new Date(this.readText("date").trim());
      case "data":
        return Buffer.from(this.readText("data").replace(/\s+/g, ""), "base64");
      default:
        throw new PlistParseError(`Unknown plist element <${token.name}>`);
    }
  }

  private readDict(): PlistDict {
    const dict: PlistDict = {};
    for (;;) {
      const token = this.next();
      if (token.kind === "close" && token.name === "dict") return dict;
      if (token.kind === "empty" && token.name === "key") {
        dict[""] = this.readValue();
        continue;
      }
      if (token.kind !== "open" || token.name !== "key") {
        throw new PlistParseError("Expected <key> in <dict>");
      }
      const key = this.readText("key");
      dict[key] = this.readValue();
    }
  }

  private readArray(): PlistValue[] {
    const items: PlistValue[] = [];
    for (;;) {
      const token = this.peek();
      if (token?.kind === "close" && token.name === "array") {
        this.next();
        return items;
      }
      items.push(this.readValue());
    }
  }
}

function emptyValue(name: string): PlistValue {
  switch (name) {
    case "true":
      return true;
    case "false":
      return false;
    case "dict":
      return {};
    case "array":
      return [];
    case "string":
      return "";
    case "data":
      return Buffer.alloc(0);
    default:
      throw new PlistParseError(`Unknown empty element <${name}/>`);
  }
}

export function parseXmlPlist(xml: string): PlistValue {
  return new XmlReader(tokenize(xml)).readDocument();
}

// ── binary plist (bplist00) ─────────────────────────────────────────────────

const MAC_EPOCH_MS = Date.UTC(2001, 0, 1);

function readUInt(buffer: Buffer, offset: number, size: number): number {
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + buffer[offset + index]!;
  }
  return value;
}

export function parseBinaryPlist(buffer: Buffer): PlistValue {
  if (buffer.length < 40 || buffer.toString("latin1", 0, 6) !== "bplist") {
    throw new PlistParseError("Not a binary plist");
  }
  const trailer = buffer.length - 32;
  const offsetSize = buffer[trailer + 6]!;
  const refSize = buffer[trailer + 7]!;
  const objectCount = readUInt(buffer, trailer + 8, 8);
  const topObject = readUInt(buffer, trailer + 16, 8);
  const tableOffset = readUInt(buffer, trailer + 24, 8);
  if (offsetSize === 0 || refSize === 0 || tableOffset + objectCount * offsetSize > trailer) {
    throw new PlistParseError("Corrupt binary plist trailer");
  }
  const offsets: number[] = [];
  for (let index = 0; index < objectCount; index += 1) {
    offsets.push(readUInt(buffer, tableOffset + index * offsetSize, offsetSize));
  }
  const depthGuard = new Set<number>();

  function lengthAt(offset: number, info: number): { length: number; start: number } {
    if (info !== 0x0f) return { length: info, start: offset + 1 };
    const marker = buffer[offset + 1]!;
    if (marker >> 4 !== 0x1) throw new PlistParseError("Bad length marker");
    const size = 1 << (marker & 0x0f);
    return { length: readUInt(buffer, offset + 2, size), start: offset + 2 + size };
  }

  function readObject(ref: number): PlistValue {
    const offset = offsets[ref];
    if (offset === undefined) throw new PlistParseError(`Bad object reference ${ref}`);
    if (depthGuard.has(ref)) throw new PlistParseError("Cyclic binary plist");
    depthGuard.add(ref);
    try {
      return readAt(offset);
    } finally {
      depthGuard.delete(ref);
    }
  }

  function readAt(offset: number): PlistValue {
    const marker = buffer[offset]!;
    const type = marker >> 4;
    const info = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (info === 0x08) return false;
        if (info === 0x09) return true;
        throw new PlistParseError(`Unsupported simple marker 0x${marker.toString(16)}`);
      case 0x1: {
        const size = 1 << info;
        if (size === 8) return Number(buffer.readBigInt64BE(offset + 1));
        if (size === 16) return Number(buffer.readBigInt64BE(offset + 9));
        return readUInt(buffer, offset + 1, size);
      }
      case 0x2:
        return info === 2 ? buffer.readFloatBE(offset + 1) : buffer.readDoubleBE(offset + 1);
      case 0x3:
        return new Date(MAC_EPOCH_MS + buffer.readDoubleBE(offset + 1) * 1000);
      case 0x4: {
        const { length, start } = lengthAt(offset, info);
        return Buffer.from(buffer.subarray(start, start + length));
      }
      case 0x5: {
        const { length, start } = lengthAt(offset, info);
        return buffer.toString("latin1", start, start + length);
      }
      case 0x6: {
        const { length, start } = lengthAt(offset, info);
        const bytes = Buffer.from(buffer.subarray(start, start + length * 2));
        bytes.swap16();
        return bytes.toString("utf16le");
      }
      case 0x8:
        return readUInt(buffer, offset + 1, info + 1);
      case 0xa: {
        const { length, start } = lengthAt(offset, info);
        const items: PlistValue[] = [];
        for (let index = 0; index < length; index += 1) {
          items.push(readObject(readUInt(buffer, start + index * refSize, refSize)));
        }
        return items;
      }
      case 0xd: {
        const { length, start } = lengthAt(offset, info);
        const dict: PlistDict = {};
        for (let index = 0; index < length; index += 1) {
          const key = readObject(readUInt(buffer, start + index * refSize, refSize));
          const value = readObject(readUInt(buffer, start + (length + index) * refSize, refSize));
          if (typeof key !== "string") throw new PlistParseError("Non-string dict key");
          dict[key] = value;
        }
        return dict;
      }
      default:
        throw new PlistParseError(`Unsupported binary plist marker 0x${marker.toString(16)}`);
    }
  }

  return readObject(topObject);
}

/** XML or binary, whichever the bytes are. */
export function parsePlist(data: Buffer): PlistValue {
  if (data.toString("latin1", 0, 6) === "bplist") return parseBinaryPlist(data);
  return parseXmlPlist(data.toString("utf8"));
}

export function parsePlistDict(data: Buffer | string): PlistDict {
  const value = typeof data === "string" ? parseXmlPlist(data) : parsePlist(data);
  if (!isDict(value)) throw new PlistParseError("Plist root is not a dictionary");
  return value;
}

export function asDict(value: PlistValue | undefined): PlistDict | null {
  return value !== undefined && isDict(value) ? value : null;
}

export function asString(value: PlistValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: PlistValue | undefined): number | null {
  return typeof value === "number" ? value : null;
}

export function asBuffer(value: PlistValue | undefined): Buffer | null {
  return value !== undefined && Buffer.isBuffer(value) ? value : null;
}

export function asArray(value: PlistValue | undefined): PlistValue[] | null {
  return Array.isArray(value) ? value : null;
}
