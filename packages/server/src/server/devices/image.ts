import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand, spawnProcess } from "../../utils/spawn.js";
import { imageSize } from "../simulator/simulator-service.js";

// Spec 27.5: frames are JPEG, long edge ≤ 1280 px, quality 70.
export const SCREEN_MAX_DIM = 1280;
export const SCREEN_JPEG_QUALITY = 70;
// ffmpeg's mjpeg encoder takes a qscale (2 best … 31 worst), not a 0–100 quality; 7 lands at the
// size/sharpness of a libjpeg quality-70 frame for phone UI content.
export const FFMPEG_MJPEG_QSCALE = 7;

export interface JpegFrame {
  jpeg: Buffer;
  width: number;
  height: number;
}

// Splits a concatenated JPEG byte stream (ffmpeg image2pipe, WDA MJPEG bodies) into frames.
// Entropy-coded data stuffs every 0xFF with 0x00, so 0xFFD9 only ever marks an end of image.
export class JpegStreamSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.buffer.indexOf(SOI);
      if (start < 0) {
        this.buffer = Buffer.alloc(0);
        return frames;
      }
      const end = this.buffer.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) this.buffer = this.buffer.subarray(start);
        return frames;
      }
      frames.push(Buffer.from(this.buffer.subarray(start, end + 2)));
      this.buffer = this.buffer.subarray(end + 2);
    }
  }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

export function jpegFrame(jpeg: Buffer): JpegFrame | null {
  const dims = imageSize(jpeg);
  return dims ? { jpeg, width: dims.width, height: dims.height } : null;
}

export class ImageEncoderUnavailableError extends Error {
  constructor() {
    super("Install ffmpeg on the host to view Android screens (no JPEG encoder found)");
    this.name = "ImageEncoderUnavailableError";
  }
}

export interface ImageTools {
  ffmpeg: string | null;
}

// Fit inside maxDim × maxDim, never upscale, keep even sizes for the encoder.
export function scaleFilter(maxDim: number): string {
  return `scale=w='min(${maxDim},iw)':h='min(${maxDim},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

function runFfmpegOnce(ffmpeg: string, input: Buffer, maxDim: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vf",
        scaleFilter(maxDim),
        "-frames:v",
        "1",
        "-c:v",
        "mjpeg",
        "-q:v",
        String(FFMPEG_MJPEG_QSCALE),
        "-f",
        "image2pipe",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `ffmpeg exited with ${code}`));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function sipsToJpeg(input: Buffer, maxDim: number): Promise<Buffer> {
  const source = join(tmpdir(), `jad-screen-${randomUUID()}.png`);
  const target = join(tmpdir(), `jad-screen-${randomUUID()}.jpg`);
  try {
    await writeFile(source, input);
    await execCommand(
      "sips",
      [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(SCREEN_JPEG_QUALITY),
        "-Z",
        String(maxDim),
        source,
        "--out",
        target,
      ],
      { timeout: 30_000 },
    );
    return await readFile(target);
  } finally {
    await unlink(source).catch(() => {});
    await unlink(target).catch(() => {});
  }
}

// PNG (screencap, WDA /screenshot) → JPEG capped at maxDim: ffmpeg anywhere, sips on macOS.
export async function encodeJpeg(
  input: Buffer,
  maxDim: number,
  tools: ImageTools,
): Promise<JpegFrame> {
  let jpeg: Buffer;
  if (tools.ffmpeg) jpeg = await runFfmpegOnce(tools.ffmpeg, input, maxDim);
  else if (process.platform === "darwin") jpeg = await sipsToJpeg(input, maxDim);
  else throw new ImageEncoderUnavailableError();
  const frame = jpegFrame(jpeg);
  if (!frame) throw new Error("The JPEG encoder produced no image");
  return frame;
}
