import type { ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pino from "pino";
import { spawnProcess } from "../../utils/spawn.js";
import type { Adb } from "./adb.js";
import {
  FFMPEG_MJPEG_QSCALE,
  JpegStreamSplitter,
  SCREEN_MAX_DIM,
  jpegFrame,
  type JpegFrame,
} from "./image.js";

// scrcpy-server (Apache-2.0) speaks no backward or forward compatibility: the version passed on
// the command line must equal the bundled jar's (doc/develop.md, v5.0.1).
export const SCRCPY_VERSION = "5.0.1";
export const SCRCPY_SERVER_SHA256 =
  "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
const REMOTE_JAR = "/data/local/tmp/jagentdesk-scrcpy-server.jar";
const SCREEN_MAX_FPS = 15;
const CONNECT_ATTEMPTS = 50;
const CONNECT_RETRY_MS = 100;

const CODEC_H264 = 0x68323634;

// Source: src/server/devices → ../../../vendor/scrcpy; build: dist/server/server/devices →
// ../../vendor/scrcpy. adb pushes the file, so a packaged daemon reads the asar-unpacked copy.
const VENDOR_CANDIDATES = ["../../../vendor/scrcpy", "../../vendor/scrcpy"];

export function resolveScrcpyServer(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of VENDOR_CANDIDATES) {
    const file = path.join(path.resolve(here, candidate), `scrcpy-server-v${SCRCPY_VERSION}`);
    const unpacked = file.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
    if (unpacked !== file && existsSync(unpacked)) return unpacked;
    if (existsSync(file)) return file;
  }
  return null;
}

// ── control messages (server/.../control/ControlMessageReader.java @ v5.0.1) ──

export const MotionAction = { Down: 0, Up: 1, Move: 2 } as const;
export type MotionAction = (typeof MotionAction)[keyof typeof MotionAction];
export const KeyAction = { Down: 0, Up: 1 } as const;

const TYPE_INJECT_KEYCODE = 0;
const TYPE_INJECT_TEXT = 1;
const TYPE_INJECT_TOUCH_EVENT = 2;
const TYPE_ROTATE_DEVICE = 11;
// The scrcpy client's POINTER_ID_GENERIC_FINGER: injected as a touchscreen finger, not a mouse.
const POINTER_ID_GENERIC_FINGER = -2n;
const INJECT_TEXT_MAX_LENGTH = 300;

export interface TouchInput {
  action: MotionAction;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function encodeTouch(input: TouchInput): Buffer {
  const buffer = Buffer.alloc(32);
  buffer.writeUInt8(TYPE_INJECT_TOUCH_EVENT, 0);
  buffer.writeUInt8(input.action, 1);
  buffer.writeBigInt64BE(POINTER_ID_GENERIC_FINGER, 2);
  buffer.writeInt32BE(Math.round(input.x), 10);
  buffer.writeInt32BE(Math.round(input.y), 14);
  buffer.writeUInt16BE(input.width, 18);
  buffer.writeUInt16BE(input.height, 20);
  // u16 fixed point: 1.0 → 0xffff; a lifted finger reports 0.
  buffer.writeUInt16BE(input.action === MotionAction.Up ? 0 : 0xffff, 22);
  buffer.writeInt32BE(0, 24); // actionButton
  buffer.writeInt32BE(0, 28); // buttons
  return buffer;
}

export function encodeKeycode(action: number, keycode: number): Buffer {
  const buffer = Buffer.alloc(14);
  buffer.writeUInt8(TYPE_INJECT_KEYCODE, 0);
  buffer.writeUInt8(action, 1);
  buffer.writeInt32BE(keycode, 2);
  buffer.writeInt32BE(0, 6); // repeat
  buffer.writeInt32BE(0, 10); // metaState
  return buffer;
}

export function encodeText(text: string): Buffer[] {
  const messages: Buffer[] = [];
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index += INJECT_TEXT_MAX_LENGTH) {
    const bytes = Buffer.from(chars.slice(index, index + INJECT_TEXT_MAX_LENGTH).join(""), "utf8");
    const message = Buffer.alloc(5 + bytes.length);
    message.writeUInt8(TYPE_INJECT_TEXT, 0);
    message.writeUInt32BE(bytes.length, 1);
    bytes.copy(message, 5);
    messages.push(message);
  }
  return messages;
}

export function encodeRotate(): Buffer {
  return Buffer.from([TYPE_ROTATE_DEVICE]);
}

// ── video socket (doc/develop.md "Video and audio") ──

export type VideoEvent =
  | { type: "codec"; codecId: number }
  | { type: "session"; width: number; height: number }
  | { type: "packet"; config: boolean; keyFrame: boolean; data: Buffer };

// After the codec id (u32), 12-byte headers: a session packet has the MSB set and carries
// width/height; a media packet carries flags + PTS (u64) and the payload size (u32).
export class ScrcpyVideoParser {
  private buffer: Buffer = Buffer.alloc(0);
  private codecRead = false;

  push(chunk: Buffer): VideoEvent[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const events: VideoEvent[] = [];
    if (!this.codecRead) {
      if (this.buffer.length < 4) return events;
      events.push({ type: "codec", codecId: this.buffer.readUInt32BE(0) });
      this.buffer = this.buffer.subarray(4);
      this.codecRead = true;
    }
    while (this.buffer.length >= 12) {
      const first = this.buffer.readUInt8(0);
      if (first & 0x80) {
        events.push({
          type: "session",
          width: this.buffer.readUInt32BE(4),
          height: this.buffer.readUInt32BE(8),
        });
        this.buffer = this.buffer.subarray(12);
        continue;
      }
      const size = this.buffer.readUInt32BE(8);
      if (this.buffer.length < 12 + size) break;
      events.push({
        type: "packet",
        config: (first & 0x40) !== 0,
        keyFrame: (first & 0x20) !== 0,
        data: Buffer.from(this.buffer.subarray(12, 12 + size)),
      });
      this.buffer = this.buffer.subarray(12 + size);
    }
    return events;
  }
}

export function scrcpyServerArgs(scid: string): string[] {
  return [
    `CLASSPATH=${REMOTE_JAR}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    SCRCPY_VERSION,
    `scid=${scid}`,
    "log_level=warn",
    "tunnel_forward=true",
    "audio=false",
    "control=true",
    "video_codec=h264",
    `max_size=${SCREEN_MAX_DIM}`,
    `max_fps=${SCREEN_MAX_FPS}`,
    "send_device_meta=false",
    "cleanup=true",
    "power_off_on_close=false",
    "clipboard_autosync=false",
  ];
}

export function ffmpegDecodeArgs(): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-threads",
    "1",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    // Not -fflags nobuffer: with the raw h264 demuxer it discards every frame.
    "-flags",
    "low_delay",
    "-f",
    "h264",
    "-i",
    "pipe:0",
    "-an",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "yuvj420p",
    "-c:v",
    "mjpeg",
    "-q:v",
    String(FFMPEG_MJPEG_QSCALE),
    "-f",
    "image2pipe",
    "pipe:1",
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// adb forward accepts the TCP connection even before the device-side socket exists, then drops it.
// The server's dummy byte on the first socket tells a live connection from that.
async function connectFirstSocket(port: number): Promise<{ socket: net.Socket; rest: Buffer }> {
  for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
    const result = await new Promise<{ socket: net.Socket; rest: Buffer } | null>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const fail = () => {
        socket.destroy();
        resolve(null);
      };
      socket.once("error", fail);
      socket.once("close", fail);
      socket.once("data", (chunk: Buffer) => {
        socket.removeListener("error", fail);
        socket.removeListener("close", fail);
        socket.pause();
        resolve({ socket, rest: chunk.subarray(1) });
      });
    });
    if (result) return result;
    await delay(CONNECT_RETRY_MS);
  }
  throw new Error("scrcpy-server did not accept the video connection");
}

function connectSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export interface ScrcpySessionOptions {
  adb: Adb;
  serial: string;
  ffmpeg: string;
  logger: pino.Logger;
  onFrame: (frame: JpegFrame) => void;
  onExit: (reason: string) => void;
}

// One scrcpy-server on a device: H.264 over an adb forward (bound by the adb server to
// 127.0.0.1), decoded by the host's ffmpeg into JPEG frames, plus the control socket for input.
export class ScrcpySession {
  private ffmpeg: ChildProcess | null = null;
  private splitter = new JpegStreamSplitter();
  private stopped = false;
  private videoSize: { width: number; height: number } | null = null;

  private constructor(
    private readonly options: ScrcpySessionOptions,
    private readonly server: ChildProcess,
    private readonly port: number,
    private readonly video: net.Socket,
    private readonly control: net.Socket,
  ) {}

  static async start(options: ScrcpySessionOptions): Promise<ScrcpySession> {
    const { adb, serial, logger } = options;
    const jar = resolveScrcpyServer();
    if (!jar) throw new Error("scrcpy-server is not bundled with this daemon");
    // cleanup=true deletes the jar when the server exits, so every session pushes it again.
    await adb.run(["-s", serial, "push", jar, REMOTE_JAR], 60_000);
    const scid = randomInt(0, 0x7fffffff).toString(16).padStart(8, "0");
    const port = Number.parseInt(
      (await adb.run(["-s", serial, "forward", "tcp:0", `localabstract:scrcpy_${scid}`])).trim(),
      10,
    );
    if (!Number.isFinite(port)) throw new Error("adb forward returned no port");
    const server = adb.spawn(["-s", serial, "shell", ...scrcpyServerArgs(scid)]);
    server.stdout?.on("data", (chunk: Buffer) => {
      logger.debug({ serial, out: chunk.toString("utf8").trim() }, "scrcpy-server");
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      logger.warn({ serial, err: chunk.toString("utf8").trim() }, "scrcpy-server");
    });
    try {
      const { socket: video, rest } = await connectFirstSocket(port);
      const control = await connectSocket(port);
      const session = new ScrcpySession(options, server, port, video, control);
      session.attach(rest);
      return session;
    } catch (error) {
      server.kill();
      await adb.run(["-s", serial, "forward", "--remove", `tcp:${port}`]).catch(() => {});
      throw error;
    }
  }

  get size(): { width: number; height: number } | null {
    return this.videoSize;
  }

  private attach(initial: Buffer): void {
    const parser = new ScrcpyVideoParser();
    const handle = (chunk: Buffer) => {
      for (const event of parser.push(chunk)) this.onVideoEvent(event);
    };
    this.video.on("data", handle);
    this.video.on("close", () => this.stop("video socket closed"));
    this.video.on("error", () => {});
    this.control.on("error", () => {});
    // Device messages (clipboard, acks) are not used; drain them.
    this.control.on("data", () => {});
    this.server.on("exit", () => this.stop("scrcpy-server exited"));
    if (initial.length > 0) handle(initial);
    this.video.resume();
  }

  private onVideoEvent(event: VideoEvent): void {
    if (event.type === "codec") {
      if (event.codecId !== CODEC_H264)
        this.stop(`unexpected video codec 0x${event.codecId.toString(16)}`);
      return;
    }
    if (event.type === "session") {
      // A new capture session (rotation) restarts the encoder with SPS/PPS + a key frame, so
      // a fresh decoder starts cleanly at the new size.
      const resized =
        this.videoSize !== null &&
        (this.videoSize.width !== event.width || this.videoSize.height !== event.height);
      this.videoSize = { width: event.width, height: event.height };
      if (resized || !this.ffmpeg) this.restartDecoder();
      return;
    }
    this.ffmpeg?.stdin?.write(event.data);
  }

  private restartDecoder(): void {
    this.ffmpeg?.kill();
    this.splitter = new JpegStreamSplitter();
    const child = spawnProcess(this.options.ffmpeg, ffmpegDecodeArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const splitter = this.splitter;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const jpeg of splitter.push(chunk)) {
        const frame = jpegFrame(jpeg);
        if (frame) this.options.onFrame(frame);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.options.logger.debug({ err: chunk.toString("utf8").trim() }, "scrcpy ffmpeg");
    });
    child.stdin?.on("error", () => {});
    child.on("exit", () => {
      if (this.ffmpeg === child) this.stop("ffmpeg exited");
    });
    this.ffmpeg = child;
  }

  private send(message: Buffer): void {
    if (this.stopped) throw new Error("The screen session ended");
    this.control.write(message);
  }

  // Coordinates are in video pixels (the frame size, ≤ 1280 on the long edge).
  touch(action: MotionAction, x: number, y: number): void {
    const size = this.videoSize;
    if (!size) throw new Error("The screen session has not started yet");
    this.send(encodeTouch({ action, x, y, width: size.width, height: size.height }));
  }

  key(keycode: number): void {
    this.send(encodeKeycode(KeyAction.Down, keycode));
    this.send(encodeKeycode(KeyAction.Up, keycode));
  }

  text(value: string): void {
    for (const message of encodeText(value)) this.send(message);
  }

  rotate(): void {
    this.send(encodeRotate());
  }

  stop(reason = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    this.video.destroy();
    this.control.destroy();
    this.server.kill();
    this.ffmpeg?.kill();
    this.ffmpeg = null;
    const { adb, serial } = this.options;
    void adb.run(["-s", serial, "forward", "--remove", `tcp:${this.port}`]).catch(() => {});
    this.options.onExit(reason);
  }
}
