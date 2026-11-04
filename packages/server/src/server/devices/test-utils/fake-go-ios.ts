import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Test-only stand-in for the go-ios binary (JAGENTDESK_GO_IOS_BIN): one cabled iPhone that
// answers the commands the hub sends, writes a real PNG for `ios screenshot` once the Developer
// Disk Image is "mounted", and logs every call to calls.log. No device, no network.

export const FAKE_IOS_UDID = "00008110-001A2B3C4D5E6F70";

export interface FakeGoIos {
  binary: string;
  callsLog: string;
}

const SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const dir = __DIR__;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\n");
const has = (word) => args.includes(word);
const flag = (name) => {
  const hit = args.find((arg) => arg.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : null;
};
const UDID = __UDID__;
function png(width, height) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = (x * 255) / width;
      row[2 + x * 3] = (y * 255) / height;
      row[3 + x * 3] = 128;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const mounted = path.join(dir, "ddi-mounted");
if (args[0] === "version") {
  console.log(JSON.stringify({ version: "1.3.2" }));
} else if (args[0] === "list") {
  console.log(JSON.stringify({ deviceList: [{ Udid: UDID, ProductName: "iPhone OS", ProductType: "iPhone14,2", ProductVersion: "16.7.2", ConnectionType: "USB" }] }));
} else if (args[0] === "info") {
  console.log(JSON.stringify({ DeviceName: "<device name>", ProductVersion: "16.7.2" }));
} else if (args[0] === "lockdown") {
  console.log("true");
} else if (args[0] === "apps") {
  console.log("");
} else if (args[0] === "image" && has("auto")) {
  fs.writeFileSync(mounted, "1");
  console.error(JSON.stringify({ level: "INFO", msg: "success mounting image", udid: UDID }));
} else if (args[0] === "screenshot") {
  if (!fs.existsSync(mounted)) {
    console.error(JSON.stringify({ level: "ERROR", msg: "Starting screenshot service failed", err: "could not start service InvalidService" }));
    process.exit(1);
  }
  fs.writeFileSync(flag("output"), png(390, 844));
  console.error(JSON.stringify({ level: "INFO", msg: "File saved successfully" }));
} else if (args[0] === "runwda") {
  console.error("Test runner exited before it was ready");
  process.exit(1);
} else {
  console.error("unsupported in the test go-ios: " + args.join(" "));
  process.exit(1);
}
`;

// Synchronous so an e2e spec can set JAGENTDESK_GO_IOS_BIN before its worker daemon starts.
export function writeFakeGoIos(dir: string): FakeGoIos {
  mkdirSync(dir, { recursive: true });
  const binary = path.join(dir, "ios");
  const source = SCRIPT.replace("__DIR__", JSON.stringify(dir)).replace(
    "__UDID__",
    JSON.stringify(FAKE_IOS_UDID),
  );
  writeFileSync(binary, `#!${process.execPath}\n${source}`);
  chmodSync(binary, 0o755);
  return { binary, callsLog: path.join(dir, "calls.log") };
}
