import { createHash } from "node:crypto";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { FetchLike, FetchResponseLike } from "../remote-sources.js";

/** Isolated temp HOME + JAGENTDESK_HOME. Never the real home directory. */
export function makeTempRoots(): { root: string; home: string; jdHome: string } {
  const root = mkdtempSync(path.join(tmpdir(), "jad-native-skills-"));
  return { root, home: path.join(root, "home"), jdHome: path.join(root, "jd-home") };
}

export async function writeSkill(
  dir: string,
  frontmatter: string,
  body = "Do the thing.\n",
  extra: Record<string, string> = {},
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}`);
  for (const [relative, content] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), content);
  }
}

/** Every entry below `root`: type, content hash / link target. Order-independent. */
export async function snapshotTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const absolute = path.join(dir, name);
      const relative = path.relative(root, absolute);
      const stats = await fs.lstat(absolute);
      if (stats.isSymbolicLink()) {
        out.push(`l ${relative} -> ${await fs.readlink(absolute)}`);
      } else if (stats.isDirectory()) {
        out.push(`d ${relative}`);
        await walk(absolute);
      } else {
        const digest = createHash("sha256")
          .update(await fs.readFile(absolute))
          .digest("hex");
        out.push(`f ${relative} ${digest}`);
      }
    }
  };
  await walk(root);
  return out;
}

function header(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function padded(data: Buffer): Buffer {
  const remainder = data.length % 512;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder, 0)]);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length += 1;
  return Buffer.from(`${length}${body}`, "utf8");
}

/** A GitHub-style tarball: pax global header with the commit, then `<top>/…` files. */
export function makeTarGz(
  files: Record<string, string>,
  options: { top?: string; commit?: string; rawEntries?: Array<[string, string]> } = {},
): Buffer {
  const parts: Buffer[] = [];
  if (options.commit) {
    const pax = paxRecord("comment", options.commit);
    parts.push(header("pax_global_header", pax.length, "g"), padded(pax));
  }
  const top = options.top ?? "repo-HEAD";
  for (const [relative, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    parts.push(header(`${top}/${relative}`, data.length, "0"), padded(data));
  }
  for (const [name, content] of options.rawEntries ?? []) {
    const data = Buffer.from(content, "utf8");
    parts.push(header(name, data.length, "0"), padded(data));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

/** Serves fixed URLs; any other URL fails the test loudly. */
export function fakeFetch(routes: Record<string, Buffer | object>): FetchLike & {
  calls: string[];
} {
  const calls: string[] = [];
  const impl = async (url: string): Promise<FetchResponseLike> => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) {
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
        return new Uint8Array(buffer).slice().buffer;
      },
      json: async () => body,
    };
  };
  return Object.assign(impl, { calls });
}
