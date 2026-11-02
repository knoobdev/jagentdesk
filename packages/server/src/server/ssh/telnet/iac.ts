// Pure Telnet IAC codec/parser — RFC 854 commands, RFC 1073 NAWS, RFC 1091 TTYPE.
// No I/O: the session feeds socket bytes to createTelnetStreamParser() and writes
// the encode* results back to the socket.

export const IAC = 0xff;
export const SB = 0xfa;
export const SE = 0xf0;

export const TelnetCommand = {
  WILL: 0xfc,
  WONT: 0xfb,
  DO: 0xfd,
  DONT: 0xfe,
} as const;
export type TelnetCommandCode = (typeof TelnetCommand)[keyof typeof TelnetCommand];

// Option codes. ECHO is 1 and SGA is 3 per RFC 854; busybox telnetd negotiates
// exactly these two plus DO NAWS (RFC 1073) and TTYPE (RFC 1091).
export const TelnetOption = {
  ECHO: 1,
  SGA: 3,
  TTYPE: 24,
  NAWS: 31,
} as const;
export type TelnetOptionCode = (typeof TelnetOption)[keyof typeof TelnetOption];

// RFC 1091 keyword bytes inside a TTYPE subnegotiation.
export const TTYPE_SEND = 1;
export const TTYPE_IS = 0;

export interface TelnetCommandSequence {
  kind: "command";
  command: TelnetCommandCode;
  option: number;
}

export interface TelnetSubnegotiationSequence {
  kind: "sub";
  option: number;
  data: Uint8Array;
}

export type TelnetSequence = TelnetCommandSequence | TelnetSubnegotiationSequence;

export interface TelnetParsedChunk {
  sequences: TelnetSequence[];
  data: Uint8Array;
}

export function encodeTelnetCommand(command: TelnetCommandCode, option: number): Uint8Array {
  return Uint8Array.from([IAC, command, option]);
}

export function encodeTelnetSubnegotiation(option: number, data: Uint8Array): Uint8Array {
  const bytes: number[] = [IAC, SB, option];
  for (const byte of data) {
    if (byte === IAC) {
      bytes.push(IAC);
    }
    bytes.push(byte);
  }
  bytes.push(IAC, SE);
  return Uint8Array.from(bytes);
}

export function encodeNaws(cols: number, rows: number): Uint8Array {
  const payload = Uint8Array.from([
    (cols >> 8) & 0xff,
    cols & 0xff,
    (rows >> 8) & 0xff,
    rows & 0xff,
  ]);
  return encodeTelnetSubnegotiation(TelnetOption.NAWS, payload);
}

export function encodeTtypeIs(termType: string): Uint8Array {
  const payload = Uint8Array.from([TTYPE_IS, ...new TextEncoder().encode(termType)]);
  return encodeTelnetSubnegotiation(TelnetOption.TTYPE, payload);
}

// Encode client→server data bytes, doubling every 0xff so the peer's parser
// reads it back as a single 0xff instead of an IAC command. UTF-8 text never
// contains a bare 0xff; the escape matters for byte-level callers.
export function encodeTelnetData(data: string | Uint8Array): Uint8Array {
  const raw = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const bytes: number[] = [];
  for (const byte of raw) {
    if (byte === IAC) {
      bytes.push(IAC);
    }
    bytes.push(byte);
  }
  return Uint8Array.from(bytes);
}

export interface TelnetStreamParser {
  push(chunk: Uint8Array): TelnetParsedChunk;
}

type ParserState = "data" | "iac" | "command" | "sub-option" | "sub-data" | "sub-iac";

function asCommandCode(byte: number): TelnetCommandCode | undefined {
  switch (byte) {
    case TelnetCommand.WILL:
      return TelnetCommand.WILL;
    case TelnetCommand.WONT:
      return TelnetCommand.WONT;
    case TelnetCommand.DO:
      return TelnetCommand.DO;
    case TelnetCommand.DONT:
      return TelnetCommand.DONT;
    default:
      return undefined;
  }
}

export function createTelnetStreamParser(): TelnetStreamParser {
  let state: ParserState = "data";
  let pendingCommand: TelnetCommandCode = TelnetCommand.WILL;
  let pendingSubOption = 0;
  let subData: number[] = [];

  function push(chunk: Uint8Array): TelnetParsedChunk {
    const sequences: TelnetSequence[] = [];
    const data: number[] = [];

    for (const byte of chunk) {
      switch (state) {
        case "data":
          if (byte === IAC) {
            state = "iac";
          } else {
            data.push(byte);
          }
          break;
        case "iac": {
          const command = asCommandCode(byte);
          if (byte === IAC) {
            data.push(IAC);
            state = "data";
          } else if (byte === SB) {
            state = "sub-option";
          } else if (command !== undefined) {
            pendingCommand = command;
            state = "command";
          } else {
            // Single-byte codes (NOP, DM, IP, AYT, …): nothing to interpret.
            state = "data";
          }
          break;
        }
        case "command":
          sequences.push({ kind: "command", command: pendingCommand, option: byte });
          state = "data";
          break;
        case "sub-option":
          pendingSubOption = byte;
          subData = [];
          state = "sub-data";
          break;
        case "sub-data":
          if (byte === IAC) {
            state = "sub-iac";
          } else {
            subData.push(byte);
          }
          break;
        case "sub-iac":
          if (byte === SE) {
            sequences.push({
              kind: "sub",
              option: pendingSubOption,
              data: Uint8Array.from(subData),
            });
            subData = [];
            state = "data";
          } else if (byte === IAC) {
            subData.push(IAC);
            state = "sub-data";
          } else {
            // Malformed SB (IAC followed by neither SE nor IAC): drop the partial.
            subData = [];
            state = "data";
          }
          break;
      }
    }

    return { sequences, data: Uint8Array.from(data) };
  }

  return { push };
}
