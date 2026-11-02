import { describe, expect, it } from "vitest";
import {
  IAC,
  SB,
  SE,
  TelnetCommand,
  TelnetOption,
  TTYPE_IS,
  TTYPE_SEND,
  createTelnetStreamParser,
  encodeNaws,
  encodeTelnetCommand,
  encodeTelnetData,
  encodeTelnetSubnegotiation,
  encodeTtypeIs,
  type TelnetParsedChunk,
  type TelnetSequence,
} from "./iac.js";

function parseAll(chunks: Uint8Array[]): TelnetParsedChunk {
  const parser = createTelnetStreamParser();
  const sequences: TelnetSequence[] = [];
  const data: number[] = [];
  for (const chunk of chunks) {
    const parsed = parser.push(chunk);
    sequences.push(...parsed.sequences);
    data.push(...parsed.data);
  }
  return { sequences, data: Uint8Array.from(data) };
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function splitIntoChunks(stream: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < stream.length; offset += size) {
    chunks.push(stream.slice(offset, offset + size));
  }
  return chunks;
}

describe("encodeTelnetCommand / decode round-trip", () => {
  const commands = [
    TelnetCommand.WILL,
    TelnetCommand.WONT,
    TelnetCommand.DO,
    TelnetCommand.DONT,
  ] as const;

  it("round-trips every command/option pair", () => {
    for (const command of commands) {
      for (const option of [TelnetOption.ECHO, TelnetOption.SGA, TelnetOption.TTYPE, 99]) {
        const encoded = encodeTelnetCommand(command, option);
        expect(Array.from(encoded)).toEqual([IAC, command, option]);
        const parsed = parseAll([encoded]);
        expect(parsed.sequences).toEqual([{ kind: "command", command, option }]);
        expect(parsed.data.length).toBe(0);
      }
    }
  });

  it("uses the RFC 854 command byte values", () => {
    expect(TelnetCommand.WILL).toBe(0xfc);
    expect(TelnetCommand.WONT).toBe(0xfb);
    expect(TelnetCommand.DO).toBe(0xfd);
    expect(TelnetCommand.DONT).toBe(0xfe);
  });
});

describe("data escaping", () => {
  it("reads an escaped 0xff 0xff in data as a single 0xff byte", () => {
    const parsed = parseAll([bytes(0x41, IAC, IAC, 0x42)]);
    expect(parsed.sequences).toEqual([]);
    expect(Array.from(parsed.data)).toEqual([0x41, 0xff, 0x42]);
  });

  it("doubles raw 0xff bytes and passes ordinary text through untouched", () => {
    expect(Array.from(encodeTelnetData("abc"))).toEqual([0x61, 0x62, 0x63]);
    expect(Array.from(encodeTelnetData("a\u001b[31mb"))).toEqual([
      0x61, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x62,
    ]);
    expect(Array.from(encodeTelnetData(bytes(0x61, 0xff, 0x62)))).toEqual([0x61, IAC, IAC, 0x62]);
  });

  it("encodeTelnetData output survives the parser unchanged", () => {
    const parsed = parseAll([encodeTelnetData("x\uffffy")]);
    expect(parsed.sequences).toEqual([]);
    expect(Buffer.from(parsed.data).toString("utf8")).toBe("x\uffffy");
  });
});

describe("subnegotiation", () => {
  it("parses IAC SB NAWS ... IAC SE into a sub sequence", () => {
    const stream = bytes(IAC, SB, TelnetOption.NAWS, 0, 80, 0, 24, IAC, SE);
    const parsed = parseAll([stream]);
    expect(parsed.sequences).toEqual([
      { kind: "sub", option: TelnetOption.NAWS, data: bytes(0, 80, 0, 24) },
    ]);
    expect(parsed.data.length).toBe(0);
  });

  it("parses IAC SB TTYPE SEND IAC SE", () => {
    const stream = bytes(IAC, SB, TelnetOption.TTYPE, TTYPE_SEND, IAC, SE);
    const parsed = parseAll([stream]);
    expect(parsed.sequences).toEqual([
      { kind: "sub", option: TelnetOption.TTYPE, data: bytes(TTYPE_SEND) },
    ]);
  });

  it("encodeNaws writes the RFC 1073 big-endian payload", () => {
    expect(Array.from(encodeNaws(80, 24))).toEqual([
      IAC,
      SB,
      TelnetOption.NAWS,
      0,
      80,
      0,
      24,
      IAC,
      SE,
    ]);
    expect(Array.from(encodeNaws(300, 100))).toEqual([
      IAC,
      SB,
      TelnetOption.NAWS,
      1,
      44,
      0,
      100,
      IAC,
      SE,
    ]);
  });

  it("encodeTtypeIs writes SB TTYPE IS <name> SE and survives a parse round-trip", () => {
    const encoded = encodeTtypeIs("xterm-256color");
    expect(Array.from(encoded)).toEqual([
      IAC,
      SB,
      TelnetOption.TTYPE,
      TTYPE_IS,
      ...new TextEncoder().encode("xterm-256color"),
      IAC,
      SE,
    ]);
    const parsed = parseAll([encoded]);
    expect(parsed.sequences).toEqual([
      {
        kind: "sub",
        option: TelnetOption.TTYPE,
        data: bytes(TTYPE_IS, ...new TextEncoder().encode("xterm-256color")),
      },
    ]);
  });

  it("escapes 0xff inside a subnegotiation payload and unescapes on parse", () => {
    const encoded = encodeTelnetSubnegotiation(TelnetOption.NAWS, bytes(0xff, 0x01));
    expect(Array.from(encoded)).toEqual([IAC, SB, TelnetOption.NAWS, IAC, IAC, 0x01, IAC, SE]);
    const parsed = parseAll([encoded]);
    expect(parsed.sequences).toEqual([
      { kind: "sub", option: TelnetOption.NAWS, data: bytes(0xff, 0x01) },
    ]);
  });
});

describe("stream splitting", () => {
  it("separates interleaved IAC sequences from data bytes", () => {
    const stream = new Uint8Array([
      ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.ECHO)),
      ...new TextEncoder().encode("login: "),
      ...Array.from(encodeTelnetCommand(TelnetCommand.DO, TelnetOption.SGA)),
      ...new TextEncoder().encode("ok"),
      ...Array.from(encodeNaws(80, 24)),
    ]);
    const parsed = parseAll([stream]);
    expect(parsed.sequences).toEqual([
      { kind: "command", command: TelnetCommand.WILL, option: TelnetOption.ECHO },
      { kind: "command", command: TelnetCommand.DO, option: TelnetOption.SGA },
      { kind: "sub", option: TelnetOption.NAWS, data: bytes(0, 80, 0, 24) },
    ]);
    expect(Buffer.from(parsed.data).toString("utf8")).toBe("login: ok");
  });

  it("reassembles sequences split across chunk boundaries identically to one push", () => {
    const stream = new Uint8Array([
      ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.SGA)),
      0x41,
      IAC, // split mid-escape here
      IAC,
      0x42,
      ...Array.from(encodeTelnetSubnegotiation(TelnetOption.TTYPE, bytes(TTYPE_SEND))),
      ...Array.from(encodeTelnetCommand(TelnetCommand.DO, TelnetOption.NAWS)),
    ]);
    const whole = parseAll([stream]);
    for (const size of [1, 2, 3, 5, 7]) {
      const chunked = parseAll(splitIntoChunks(stream, size));
      expect(chunked.sequences).toEqual(whole.sequences);
      expect(Array.from(chunked.data)).toEqual(Array.from(whole.data));
    }
    expect(whole.sequences).toEqual([
      { kind: "command", command: TelnetCommand.WILL, option: TelnetOption.SGA },
      { kind: "sub", option: TelnetOption.TTYPE, data: bytes(TTYPE_SEND) },
      { kind: "command", command: TelnetCommand.DO, option: TelnetOption.NAWS },
    ]);
    expect(Array.from(whole.data)).toEqual([0x41, 0xff, 0x42]);
  });

  it("drops single-byte IAC codes like NOP without consuming following data", () => {
    const parsed = parseAll([bytes(IAC, 0xf1, 0x41)]); // IAC NOP, "A"
    expect(parsed.sequences).toEqual([]);
    expect(Array.from(parsed.data)).toEqual([0x41]);
  });

  it("drops a malformed subnegotiation that ends IAC <byte other than SE/IAC>", () => {
    const parsed = parseAll([bytes(IAC, SB, TelnetOption.NAWS, 0, 1, IAC, 0x41, 0x42)]);
    expect(parsed.sequences).toEqual([]);
    expect(Array.from(parsed.data)).toEqual([0x42]);
  });

  it("keeps pending state when a chunk ends mid-command and mid-SB", () => {
    const parser = createTelnetStreamParser();
    expect(parser.push(bytes(IAC, SB, TelnetOption.NAWS, 0)).sequences).toEqual([]);
    const second = parser.push(bytes(80, 0, 24, IAC));
    expect(second.sequences).toEqual([]);
    const third = parser.push(bytes(SE, 0x41));
    expect(third.sequences).toEqual([
      { kind: "sub", option: TelnetOption.NAWS, data: bytes(0, 80, 0, 24) },
    ]);
    expect(Array.from(third.data)).toEqual([0x41]);
  });
});
