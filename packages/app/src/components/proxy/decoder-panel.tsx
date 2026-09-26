// Decoder — a self-contained clone of Burp Suite CE's Decoder tool. A top input holds the data the
// tester types or pastes; every transform (Decode as / Encode as / Hash / Smart decode) appends a
// new panel below with the result, matching Burp's cascade. Each panel toggles between a Text and a
// Hex view of the same bytes. URL, Base64 and ASCII-hex encode/decode plus SHA-256 are real; Gzip
// and MD5/SHA-1 are honest stubs that show a note instead of fabricating output.
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { decodeBase64, bytesToUtf8 } from "./base64";
import { WB_ORANGE } from "./workbench-constants";

// ---------------------------------------------------------------------------
// Byte helpers (no Node Buffer — the web renderer has none)
// ---------------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const EMPTY = new Uint8Array(0);

function utf8ToBytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

// A bytes → base64 encoder (base64.ts only exports a text → base64 one).
function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

function bytesToHex(bytes: Uint8Array, sep: string): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    parts.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  }
  return parts.join(sep);
}

function hexToBytes(str: string): Uint8Array {
  const clean = str.replace(/[^0-9a-fA-F]/g, "");
  const n = Math.floor(clean.length / 2);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function isUnreserved(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    (b >= 0x30 && b <= 0x39) ||
    b === 0x2d ||
    b === 0x2e ||
    b === 0x5f ||
    b === 0x7e
  );
}

function percentEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (isUnreserved(b)) out += String.fromCharCode(b);
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function percentDecode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i] ?? "";
    if (c === "%" && i + 2 < str.length) {
      const h = str.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(h)) {
        out.push(parseInt(h, 16));
        i += 2;
        continue;
      }
    }
    for (const byte of utf8ToBytes(c)) out.push(byte);
  }
  return Uint8Array.from(out);
}

const HTML_ENC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const HTML_ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g;

function htmlEncode(str: string): string {
  let out = "";
  for (const ch of str) out += HTML_ENC[ch] ?? ch;
  return out;
}

function decodeEntity(match: string, body: string): string {
  if (body[0] === "#") {
    const hex = body[1] === "x" || body[1] === "X";
    const num = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isNaN(num) ? match : String.fromCharCode(num);
  }
  return HTML_NAMED[body] ?? match;
}

function htmlDecode(str: string): string {
  return str.replace(HTML_ENTITY_RE, decodeEntity);
}

function octalToBytes(str: string): Uint8Array {
  const parts = str.split(/\s+/).filter((x) => x.length > 0);
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    const v = parseInt(parts[i] ?? "0", 8);
    out[i] = Number.isNaN(v) ? 0 : v & 0xff;
  }
  return out;
}

function bytesToOctal(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) parts.push((bytes[i] ?? 0).toString(8).padStart(3, "0"));
  return parts.join(" ");
}

function binaryToBytes(str: string): Uint8Array {
  const clean = str.replace(/[^01]/g, "");
  const n = Math.floor(clean.length / 8);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(clean.slice(i * 8, i * 8 + 8), 2);
  return out;
}

function bytesToBinary(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i++) parts.push((bytes[i] ?? 0).toString(2).padStart(8, "0"));
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// SHA-256 — small pure-JS implementation (no WebCrypto / Node crypto assumed)
// ---------------------------------------------------------------------------

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Pad(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const bitLenLo = (len * 8) >>> 0;
  const bitLenHi = Math.floor((len * 8) / 0x100000000) >>> 0;
  const totalBytes = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(totalBytes);
  buf.set(msg, 0);
  buf[len] = 0x80;
  buf[totalBytes - 8] = (bitLenHi >>> 24) & 0xff;
  buf[totalBytes - 7] = (bitLenHi >>> 16) & 0xff;
  buf[totalBytes - 6] = (bitLenHi >>> 8) & 0xff;
  buf[totalBytes - 5] = bitLenHi & 0xff;
  buf[totalBytes - 4] = (bitLenLo >>> 24) & 0xff;
  buf[totalBytes - 3] = (bitLenLo >>> 16) & 0xff;
  buf[totalBytes - 2] = (bitLenLo >>> 8) & 0xff;
  buf[totalBytes - 1] = bitLenLo & 0xff;
  return buf;
}

function sha256Block(H: Uint32Array, w: Uint32Array, buf: Uint8Array, off: number): void {
  for (let t = 0; t < 16; t++) {
    const p = off + t * 4;
    w[t] = ((buf[p]! << 24) | (buf[p + 1]! << 16) | (buf[p + 2]! << 8) | buf[p + 3]!) >>> 0;
  }
  for (let t = 16; t < 64; t++) {
    const w15 = w[t - 15]!;
    const w2 = w[t - 2]!;
    const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
    const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
    w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
  }
  let a = H[0]!;
  let b = H[1]!;
  let c = H[2]!;
  let d = H[3]!;
  let e = H[4]!;
  let f = H[5]!;
  let g = H[6]!;
  let h = H[7]!;
  for (let t = 0; t < 64; t++) {
    const bigS1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const temp1 = (h + bigS1 + ch + SHA256_K[t]! + w[t]!) >>> 0;
    const bigS0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const temp2 = (bigS0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  H[0] = (H[0]! + a) >>> 0;
  H[1] = (H[1]! + b) >>> 0;
  H[2] = (H[2]! + c) >>> 0;
  H[3] = (H[3]! + d) >>> 0;
  H[4] = (H[4]! + e) >>> 0;
  H[5] = (H[5]! + f) >>> 0;
  H[6] = (H[6]! + g) >>> 0;
  H[7] = (H[7]! + h) >>> 0;
}

function sha256Hex(msg: Uint8Array): string {
  const H = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const buf = sha256Pad(msg);
  const w = new Uint32Array(64);
  for (let off = 0; off < buf.length; off += 64) sha256Block(H, w, buf, off);
  let hex = "";
  for (let i = 0; i < 8; i++) hex += H[i]!.toString(16).padStart(8, "0");
  return hex;
}

// ---------------------------------------------------------------------------
// Operation registry
// ---------------------------------------------------------------------------

interface OpResult {
  bytes: Uint8Array;
  note?: string;
}
type ByteFn = (bytes: Uint8Array) => OpResult;

const asText = (s: string): OpResult => ({ bytes: utf8ToBytes(s) });

const DECODERS: Record<string, ByteFn> = {
  url: (bytes) => ({ bytes: percentDecode(bytesToUtf8(bytes)) }),
  html: (bytes) => asText(htmlDecode(bytesToUtf8(bytes))),
  base64: (bytes) => ({ bytes: decodeBase64(bytesToUtf8(bytes)) }),
  asciihex: (bytes) => ({ bytes: hexToBytes(bytesToUtf8(bytes)) }),
  hex: (bytes) => ({ bytes: hexToBytes(bytesToUtf8(bytes)) }),
  octal: (bytes) => ({ bytes: octalToBytes(bytesToUtf8(bytes)) }),
  binary: (bytes) => ({ bytes: binaryToBytes(bytesToUtf8(bytes)) }),
  gzip: (bytes) => ({
    bytes,
    note: "Gzip decode is a stub — no decompressor is bundled in the renderer.",
  }),
};

const ENCODERS: Record<string, ByteFn> = {
  url: (bytes) => asText(percentEncode(bytes)),
  html: (bytes) => asText(htmlEncode(bytesToUtf8(bytes))),
  base64: (bytes) => asText(encodeBase64(bytes)),
  asciihex: (bytes) => asText(bytesToHex(bytes, " ")),
  hex: (bytes) => asText(bytesToHex(bytes, "")),
  octal: (bytes) => asText(bytesToOctal(bytes)),
  binary: (bytes) => asText(bytesToBinary(bytes)),
  gzip: (bytes) => ({
    bytes,
    note: "Gzip encode is a stub — no compressor is bundled in the renderer.",
  }),
};

const HASHERS: Record<string, ByteFn> = {
  sha256: (bytes) => asText(sha256Hex(bytes)),
  md5: () => ({
    bytes: EMPTY,
    note: "MD5 unavailable — not implemented (output intentionally not fabricated).",
  }),
  sha1: () => ({
    bytes: EMPTY,
    note: "SHA-1 unavailable — not implemented (output intentionally not fabricated).",
  }),
};

const KIND_MAPS: Record<string, Record<string, ByteFn>> = {
  decode: DECODERS,
  encode: ENCODERS,
  hash: HASHERS,
};

function applyOp(bytes: Uint8Array, kind: string, opId: string): OpResult {
  const fn = KIND_MAPS[kind]?.[opId];
  if (!fn) return { bytes, note: `Unknown operation ${kind}/${opId}` };
  return fn(bytes);
}

function isLikelyBase64(str: string): boolean {
  const trimmed = str.trim();
  const compact = trimmed.replace(/\s/g, "");
  return compact.length >= 4 && compact.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(compact);
}

function smartDecode(bytes: Uint8Array): OpResult {
  const str = bytesToUtf8(bytes);
  if (/%[0-9a-fA-F]{2}/.test(str)) {
    return {
      bytes: percentDecode(str),
      note: "Smart decode: input looked URL-encoded → URL-decoded.",
    };
  }
  if (isLikelyBase64(str)) {
    const dec = decodeBase64(str);
    if (dec.length > 0)
      return { bytes: dec, note: "Smart decode: input looked Base64 → Base64-decoded." };
  }
  return {
    bytes,
    note: "Smart decode: no confident transform matched — passed through unchanged.",
  };
}

// ---------------------------------------------------------------------------
// Op catalogs (module-scope so JSX never allocates a new array as a prop)
// ---------------------------------------------------------------------------

interface OpDef {
  id: string;
  label: string;
}

const DECODE_OPS: OpDef[] = [
  { id: "url", label: "URL" },
  { id: "html", label: "HTML" },
  { id: "base64", label: "Base64" },
  { id: "asciihex", label: "ASCII hex" },
  { id: "hex", label: "Hex" },
  { id: "octal", label: "Octal" },
  { id: "binary", label: "Binary" },
  { id: "gzip", label: "Gzip" },
];

const ENCODE_OPS: OpDef[] = [
  { id: "url", label: "URL" },
  { id: "html", label: "HTML" },
  { id: "base64", label: "Base64" },
  { id: "asciihex", label: "ASCII hex" },
  { id: "hex", label: "Hex" },
  { id: "octal", label: "Octal" },
  { id: "binary", label: "Binary" },
  { id: "gzip", label: "Gzip" },
];

const HASH_OPS: OpDef[] = [
  { id: "md5", label: "MD5" },
  { id: "sha1", label: "SHA-1" },
  { id: "sha256", label: "SHA-256" },
];

type ViewMode = "text" | "hex";

interface Stage {
  id: number;
  bytes: Uint8Array;
  view: ViewMode;
  editable: boolean;
  note?: string;
}

type ApplyFn = (stageId: number, kind: string, opId: string) => void;
type ToggleFn = (stageId: number, view: ViewMode) => void;
type ChangeFn = (stageId: number, text: string) => void;
type SmartFn = (stageId: number) => void;

function stageText(stage: Stage): string {
  return stage.view === "hex" ? bytesToHex(stage.bytes, " ") : bytesToUtf8(stage.bytes);
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

function ToggleButton({
  stageId,
  label,
  value,
  active,
  onToggle,
}: {
  stageId: number;
  label: string;
  value: ViewMode;
  active: boolean;
  onToggle: ToggleFn;
}) {
  const handlePress = useCallback(() => onToggle(stageId, value), [onToggle, stageId, value]);
  return (
    <Pressable onPress={handlePress} style={[styles.toggle, active && styles.toggleActive]}>
      <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function ViewToggle({
  stageId,
  view,
  onToggle,
}: {
  stageId: number;
  view: ViewMode;
  onToggle: ToggleFn;
}) {
  return (
    <View style={styles.toggleRow}>
      <ToggleButton
        stageId={stageId}
        label="Text"
        value="text"
        active={view === "text"}
        onToggle={onToggle}
      />
      <ToggleButton
        stageId={stageId}
        label="Hex"
        value="hex"
        active={view === "hex"}
        onToggle={onToggle}
      />
    </View>
  );
}

function OpChip({
  op,
  kind,
  stageId,
  onApply,
}: {
  op: OpDef;
  kind: string;
  stageId: number;
  onApply: ApplyFn;
}) {
  const handlePress = useCallback(
    () => onApply(stageId, kind, op.id),
    [onApply, stageId, kind, op.id],
  );
  return (
    <Pressable onPress={handlePress} style={styles.chip}>
      <Text style={styles.chipLabel}>{op.label}</Text>
    </Pressable>
  );
}

function OpGroup({
  label,
  kind,
  ops,
  stageId,
  onApply,
}: {
  label: string;
  kind: string;
  ops: OpDef[];
  stageId: number;
  onApply: ApplyFn;
}) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.chipRow}>
        {ops.map((op) => (
          <OpChip key={op.id} op={op} kind={kind} stageId={stageId} onApply={onApply} />
        ))}
      </View>
    </View>
  );
}

function SmartButton({ stageId, onSmart }: { stageId: number; onSmart: SmartFn }) {
  const handlePress = useCallback(() => onSmart(stageId), [onSmart, stageId]);
  return (
    <Button size="sm" variant="secondary" onPress={handlePress}>
      Smart decode
    </Button>
  );
}

function OpBar({
  stageId,
  onApply,
  onSmart,
}: {
  stageId: number;
  onApply: ApplyFn;
  onSmart: SmartFn;
}) {
  return (
    <View style={styles.opBar}>
      <OpGroup
        label="Decode as"
        kind="decode"
        ops={DECODE_OPS}
        stageId={stageId}
        onApply={onApply}
      />
      <OpGroup
        label="Encode as"
        kind="encode"
        ops={ENCODE_OPS}
        stageId={stageId}
        onApply={onApply}
      />
      <OpGroup label="Hash" kind="hash" ops={HASH_OPS} stageId={stageId} onApply={onApply} />
      <SmartButton stageId={stageId} onSmart={onSmart} />
    </View>
  );
}

function StageBody({ stage, onChangeText }: { stage: Stage; onChangeText: ChangeFn }) {
  const handleChange = useCallback(
    (text: string) => onChangeText(stage.id, text),
    [onChangeText, stage.id],
  );
  const value = stageText(stage);
  if (stage.editable) {
    return (
      <TextInput
        value={value}
        onChangeText={handleChange}
        multiline
        placeholder="Type or paste data to decode…"
        style={styles.input}
      />
    );
  }
  return (
    <ScrollView style={styles.output} horizontal>
      <Text selectable style={styles.mono}>
        {value}
      </Text>
    </ScrollView>
  );
}

function StageView({
  stage,
  onChangeText,
  onToggleView,
  onApply,
  onSmart,
}: {
  stage: Stage;
  onChangeText: ChangeFn;
  onToggleView: ToggleFn;
  onApply: ApplyFn;
  onSmart: SmartFn;
}) {
  return (
    <View style={styles.stage}>
      <View style={styles.stageHead}>
        <ViewToggle stageId={stage.id} view={stage.view} onToggle={onToggleView} />
        {stage.note ? <Text style={styles.note}>{stage.note}</Text> : null}
      </View>
      <StageBody stage={stage} onChangeText={onChangeText} />
      <OpBar stageId={stage.id} onApply={onApply} onSmart={onSmart} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function DecoderPanel() {
  const [stages, setStages] = useState<Stage[]>(() => [
    { id: 0, bytes: EMPTY, view: "text", editable: true },
  ]);
  const nextId = useRef(1);

  const handleChangeText = useCallback<ChangeFn>((stageId, text) => {
    setStages((prev) => {
      const idx = prev.findIndex((s) => s.id === stageId);
      if (idx === -1) return prev;
      const src = prev[idx];
      if (!src) return prev;
      const bytes = src.view === "hex" ? hexToBytes(text) : utf8ToBytes(text);
      const updated: Stage = { ...src, bytes, note: undefined };
      return [...prev.slice(0, idx), updated];
    });
  }, []);

  const handleToggleView = useCallback<ToggleFn>((stageId, view) => {
    setStages((prev) => prev.map((s) => (s.id === stageId ? { ...s, view } : s)));
  }, []);

  const handleApply = useCallback<ApplyFn>((stageId, kind, opId) => {
    setStages((prev) => {
      const idx = prev.findIndex((s) => s.id === stageId);
      if (idx === -1) return prev;
      const src = prev[idx];
      if (!src) return prev;
      const result = applyOp(src.bytes, kind, opId);
      const stage: Stage = {
        id: nextId.current++,
        bytes: result.bytes,
        view: "text",
        editable: false,
        note: result.note,
      };
      return [...prev.slice(0, idx + 1), stage];
    });
  }, []);

  const handleSmart = useCallback<SmartFn>((stageId) => {
    setStages((prev) => {
      const idx = prev.findIndex((s) => s.id === stageId);
      if (idx === -1) return prev;
      const src = prev[idx];
      if (!src) return prev;
      const result = smartDecode(src.bytes);
      const stage: Stage = {
        id: nextId.current++,
        bytes: result.bytes,
        view: "text",
        editable: false,
        note: result.note,
      };
      return [...prev.slice(0, idx + 1), stage];
    });
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Decoder</Text>
      <Text style={styles.hint}>
        Type or paste data above. Each transform appends a new panel below (Burp-style cascade).
        URL, Base64, ASCII hex and SHA-256 are fully functional.
      </Text>
      {stages.map((stage) => (
        <StageView
          key={stage.id}
          stage={stage}
          onChangeText={handleChangeText}
          onToggleView={handleToggleView}
          onApply={handleApply}
          onSmart={handleSmart}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[3], gap: theme.spacing[3] },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  stage: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  stageHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  toggleRow: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    overflow: "hidden",
  },
  toggle: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
  },
  toggleActive: { backgroundColor: WB_ORANGE },
  toggleLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  toggleLabelActive: { color: "#ffffff", fontWeight: theme.fontWeight.semibold },
  note: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    textAlignVertical: "top",
  },
  output: {
    maxHeight: 160,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  opBar: { gap: theme.spacing[2] },
  group: { gap: theme.spacing[1] },
  groupLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface0,
  },
  chipLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foreground },
}));
