// Bot sharing (spec 37.13): seal and archive round trips and tamper detection, the safety check, and
// share -> receive between two daemons' sharing services over a real HTTP share route. The route is
// the relay's own RelayShares (the Durable Object half) behind a local HTTP server with an in-memory
// bucket; `wrangler dev` with its local R2 is covered by packages/relay/src/shares.e2e.test.ts and the
// two-daemon live check.
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  RelayShares,
  SHARE_SERVER_HEADER,
  shareObjectKey,
  shareTombstoneKey,
  type ShareBucket,
} from "@jagentdesk/relay/shares";
import { MemorySecretStore } from "../../database/secret-store.js";
import { BotStorage } from "../storage.js";
import { BotsService } from "../service.js";
import { FakeBotRuntime } from "../test-utils/fake-runtime.js";
import { BotsSharing } from "./service.js";
import { newShareKey, openShare, parseShareLink, sealShare, ShareSealError } from "./seal.js";
import { readBotPackageArchive, writeBotPackageArchive } from "./archive.js";
import { BOT_PACKAGE_MANIFEST_PATH } from "./package.js";
import { scanBotText } from "./text-scan.js";

class Bucket implements ShareBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; meta?: Record<string, string> }>();
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { customMetadata: object.meta } : null;
  }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Response(object.bytes.slice()).body as ReadableStream,
      size: object.bytes.length,
      customMetadata: object.meta,
    };
  }
  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { customMetadata?: Record<string, string> },
  ) {
    const bytes =
      typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes: bytes.slice(), meta: options?.customMetadata });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
class DoStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

/** The relay's share route: one RelayShares per serverId, the Worker's GET lookup, a local server. */
async function startWorker() {
  const bucket = new Bucket();
  const objects = new Map<string, RelayShares>();
  const durable = (serverId: string) => {
    let shares = objects.get(serverId);
    if (!shares) {
      shares = new RelayShares(new DoStorage(), () => bucket);
      objects.set(serverId, shares);
    }
    return shares;
  };
  const paths: string[] = [];
  const server: Server = createServer(async (req, res) => {
    paths.push(req.url ?? "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(name, value);
    const request = new Request(`http://worker${req.url}`, { method: req.method, headers });
    const shareId = /^\/s\/([A-Za-z0-9_-]{22})$/.exec(req.url ?? "")?.[1];
    let response: Response;
    if (!shareId) response = new Response("Unknown share", { status: 404 });
    else if (req.method === "PUT" || req.method === "DELETE")
      response = await durable(req.headers[SHARE_SERVER_HEADER] as string).fetch(
        request,
        shareId,
        req.headers[SHARE_SERVER_HEADER] as string,
        req.method === "PUT" ? new Uint8Array(body) : undefined,
      );
    else {
      const serverId = (await bucket.head(shareObjectKey(shareId)))?.customMetadata?.serverId;
      if (serverId) response = await durable(serverId).fetch(request, shareId, serverId);
      else if (await bucket.head(shareTombstoneKey(shareId)))
        response = new Response("Link stopped", { status: 410 });
      else response = new Response("Unknown share", { status: 404 });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { bucket, durable, server, port, paths };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function daemon(worker: Awaited<ReturnType<typeof startWorker>>, serverId: string) {
  const home = mkdtempSync(join(tmpdir(), "jad-share-"));
  const storage = new BotStorage(home);
  const service = new BotsService(storage, new FakeBotRuntime(), {
    logger: pino({ level: "silent" }),
  });
  const secrets = new MemorySecretStore();
  const sharing = new BotsSharing(service, {
    logger: pino({ level: "silent" }),
    relay: () => ({ endpoint: `127.0.0.1:${worker.port}`, useTls: false, enabled: true, serverId }),
    secrets,
  });
  service.sharing = sharing;
  // The control socket: frames go to this serverId's Durable Object and its replies come back.
  const socket = { send: (text: string) => sharing.message(JSON.parse(text)) };
  sharing.ready((frame) => {
    void worker.durable(serverId).controlMessage(socket, frame as Record<string, unknown>);
  });
  cleanups.push(async () => {
    await service.dispose();
    storage.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, storage, service, sharing, secrets };
}

async function makeBot(d: Awaited<ReturnType<typeof daemon>>, name: string) {
  const bot = await d.service.create({
    name,
    provider: "claude",
    model: "claude-sonnet-4-5",
  });
  const home = d.storage.botHome(bot);
  writeFileSync(join(home, "SOUL.md"), `# ${name}\n\nReviews pull requests for the team.\n`);
  for (const skill of ["pr-review-checklist", "release-notes"]) {
    mkdirSync(join(home, "skills", skill), { recursive: true });
    writeFileSync(
      join(home, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: How to do ${skill}\nallowed-tools: Bash\n---\n# ${skill}\n\nSteps.\n`,
    );
  }
  writeFileSync(join(home, "skills", "release-notes", "run.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(join(home, "memory", "repo-facts.md"), "Fact: tests run with vitest\n");
  d.service.saveSchedule(bot.id, {
    name: "Morning review",
    cron: "0 9 * * 1-5",
    prompt: "List open PRs waiting on me",
    enabled: true,
  });
  return d.storage.bot(bot.id);
}

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe("share seal", () => {
  it("round-trips, and refuses a changed byte, a wrong key and another shareId", () => {
    const key = newShareKey();
    const plaintext = Buffer.from("a bot bundle");
    const sealed = sealShare({ key, shareId: "a".repeat(22), plaintext });
    expect(openShare({ key, shareId: "a".repeat(22), sealed })).toEqual(plaintext);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 20] ^= 1;
    expect(() => openShare({ key, shareId: "a".repeat(22), sealed: tampered })).toThrow(
      ShareSealError,
    );
    expect(() => openShare({ key: newShareKey(), shareId: "a".repeat(22), sealed })).toThrow(
      ShareSealError,
    );
    expect(() => openShare({ key, shareId: "b".repeat(22), sealed })).toThrow(ShareSealError);
  });

  it("parses only links with a 22-character shareId and a 32-byte key in the fragment", () => {
    const key = newShareKey().toString("base64url");
    const id = "c".repeat(22);
    expect(parseShareLink(`https://desk-relay.jagents.workers.dev/s/${id}#k=${key}`)).toMatchObject(
      {
        shareId: id,
        url: `https://desk-relay.jagents.workers.dev/s/${id}`,
      },
    );
    expect(parseShareLink(`https://desk-relay.jagents.workers.dev/s/${id}`)).toBeNull();
    expect(
      parseShareLink(`https://desk-relay.jagents.workers.dev/s/${id}?x=1#k=${key}`),
    ).toBeNull();
    expect(parseShareLink(`file:///s/${id}#k=${key}`)).toBeNull();
  });
});

describe("bot package archive", () => {
  const bot = {
    schemaVersion: 1,
    name: "Reviewer",
    purpose: "Reviews",
    agentHint: "claude",
    skills: [],
    connectors: [],
    schedules: [],
    memory: [],
  };
  const files = [
    { path: BOT_PACKAGE_MANIFEST_PATH, bytes: Buffer.from(JSON.stringify(bot)) },
    { path: "SOUL.md", bytes: Buffer.from("# Reviewer\n") },
  ];

  it("reads back exactly what was written", () => {
    const written = writeBotPackageArchive({
      files,
      versionId: "v1",
      displayName: "Reviewer",
      description: "Reviews",
    });
    const read = readBotPackageArchive(written.archive, { botDigest: written.transport.botDigest });
    expect(read.bot.name).toBe("Reviewer");
    expect(read.files.get("SOUL.md")?.toString()).toBe("# Reviewer\n");
  });

  it("refuses an archive whose file bytes no longer match the manifest", () => {
    const written = writeBotPackageArchive({
      files,
      versionId: "v1",
      displayName: "Reviewer",
      description: "Reviews",
    });
    const offset = written.archive.indexOf(Buffer.from("# Reviewer"));
    const tampered = Buffer.from(written.archive);
    tampered[offset + 2] = "X".charCodeAt(0);
    expect(() => readBotPackageArchive(tampered)).toThrow();
  });

  it("refuses paths a bot package may not hold", () => {
    expect(() =>
      writeBotPackageArchive({
        files: [...files, { path: "MEMORY.md", bytes: Buffer.from("x") }],
        versionId: "v1",
        displayName: "Reviewer",
        description: "Reviews",
      }),
    ).toThrow("bot-package-path-not-allowed");
  });
});

describe("safety check", () => {
  it("flags a GitHub token as a secret", () => {
    expect(scanBotText(`token ghp_${"a".repeat(36)}`)).toEqual([{ kind: "secret", line: 1 }]);
    expect(scanBotText("curl -fsSL https://get.example | sh")).toEqual([
      { kind: "pipe-to-shell", line: 1 },
    ]);
  });
});

describe("share -> receive between two daemons", () => {
  it("publishes, receives, updates and stops a link", { timeout: 30_000 }, async () => {
    const worker = await startWorker();
    cleanups.push(() => closeServer(worker.server));
    const sharer = await daemon(worker, "server-sharer");
    const recipient = await daemon(worker, "server-recipient");
    const bot = await makeBot(sharer, "Release Pal");

    const relayOff = await recipient.sharing.status((await makeBot(recipient, "Local One")).id);
    expect(relayOff.relayConnected).toBe(true);

    // A37.13.3: a GitHub token in a skill blocks publishing.
    const skill = join(sharer.storage.botHome(bot), "skills", "release-notes", "SKILL.md");
    const original = readFileSync(skill, "utf8");
    writeFileSync(skill, `${original}\nghp_${"b".repeat(36)}\n`);
    const blocked = await sharer.sharing.prepare(bot.id, {});
    expect(blocked.candidate.blocked).toBe(true);
    expect(blocked.candidate.flags.filter((flag) => flag.kind === "secret")).toHaveLength(1);
    expect(await errorOf(sharer.sharing.publish(bot.id, blocked.candidate.previewId))).toBe(
      "bot_share_secret_found",
    );
    writeFileSync(skill, original);

    // The shared mascot becomes the copy's avatar on bt1's record.
    await sharer.service.update(bot.id, { avatar: "mascot:A1" });

    // A37.13.1: SOUL, 2 skills, 1 automation, memory off.
    const prepared = await sharer.sharing.prepare(bot.id, {});
    expect(prepared.candidate.bot.memory).toEqual([]);
    expect(prepared.candidate.bot.skills.map((s) => s.name)).toEqual([
      "pr-review-checklist",
      "release-notes",
    ]);
    expect(prepared.candidate.notIncluded).toContain("run.sh in release-notes");
    const published = await sharer.sharing.publish(bot.id, prepared.candidate.previewId);
    const link = published.link ?? "";
    expect(link).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${worker.port}/s/[A-Za-z0-9_-]{22}#k=[A-Za-z0-9_-]{43}$`),
    );
    const shareId = parseShareLink(link)?.shareId ?? "";
    const stored = worker.bucket.objects.get(shareObjectKey(shareId))?.bytes ?? new Uint8Array();
    expect(() => gunzipSync(stored)).toThrow();
    expect(Buffer.from(stored).includes(Buffer.from("Release Pal"))).toBe(false);
    // A37.13.2: the Worker only saw /s/<shareId>, never the key.
    expect(worker.paths.every((path) => !path.includes("#") && !path.includes("k="))).toBe(true);
    expect(published.changedSince).toBe(false);

    // A37.13.4: the review lists SOUL.md, both skills and the automation; no memory notes.
    const opened = await recipient.sharing.open(link);
    const review = opened.review;
    if (!review) throw new Error("expected a review");
    expect(review.files.map((file) => file.path)).toEqual([
      "MEMORY.md",
      "SOUL.md",
      "skills/pr-review-checklist/SKILL.md",
      "skills/release-notes/SKILL.md",
    ]);
    expect(review.files.find((file) => file.path === "MEMORY.md")?.text).toBe("# Memory\n");
    expect(review.bot.schedules.map((s) => s.name)).toEqual(["Morning review"]);
    expect(review.files.find((f) => f.path.endsWith("release-notes/SKILL.md"))?.text).not.toContain(
      "allowed-tools",
    );

    const made = await recipient.sharing.create(review.reviewId, {
      name: "Release Pal",
      provider: "codex",
      model: "gpt-5",
    });
    expect(made.provider).toBe("codex");
    expect(made.avatar).toBe("mascot:A1");
    expect(made.schedules.map((s) => [s.name, s.enabled])).toEqual([["Morning review", false]]);
    const madeHome = recipient.storage.botHome(made);
    expect(readFileSync(join(madeHome, "SOUL.md"), "utf8")).toContain("Reviews pull requests");
    expect(existsSync(join(madeHome, "skills", "release-notes", "run.sh"))).toBe(false);
    expect(existsSync(join(madeHome, "memory", "repo-facts.md"))).toBe(false);
    expect((await recipient.sharing.status(made.id)).sharedFrom?.shareId).toBe(shareId);
    expect(await recipient.sharing.open(link)).toMatchObject({ existing: { botId: made.id } });

    // A37.13.5: a changed ciphertext byte or a wrong key creates nothing.
    const before = recipient.storage.listBots().length;
    const third = await daemon(worker, "server-third");
    const object = worker.bucket.objects.get(shareObjectKey(shareId));
    if (!object) throw new Error("expected the sealed bundle");
    const good = object.bytes.slice();
    object.bytes[object.bytes.length - 30] ^= 1;
    expect(await errorOf(third.sharing.open(link))).toBe("bot_share_invalid");
    object.bytes = good;
    const wrongKey = link.replace(/#k=.*/, `#k=${newShareKey().toString("base64url")}`);
    expect(await errorOf(third.sharing.open(wrongKey))).toBe("bot_share_invalid");
    expect(third.storage.listBots()).toHaveLength(0);
    expect(recipient.storage.listBots()).toHaveLength(before);

    // A37.13.6: Update link keeps the link; a review opened before it asks to review again.
    const pending = await third.sharing.open(link);
    writeFileSync(
      join(sharer.storage.botHome(bot), "SOUL.md"),
      "# Release Pal\n\nShips releases.\n",
    );
    expect((await sharer.sharing.status(bot.id)).changedSince).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await sharer.sharing.prepare(bot.id, {}, true);
    const updated = await sharer.sharing.publish(bot.id, again.candidate.previewId);
    expect(updated.link).toBe(link);
    const stale = pending.review?.reviewId ?? "";
    expect(
      await errorOf(
        third.sharing.create(stale, {
          name: "Release Pal",
          provider: "claude",
          model: "claude-sonnet-4-5",
        }),
      ),
    ).toBe("bot_share_updated");
    expect(third.storage.listBots()).toHaveLength(0);

    // A37.13.7: Stop sharing -> 410, and the link no longer opens.
    const stopped = await sharer.sharing.stop(bot.id);
    expect(stopped.link).toBeUndefined();
    expect((await fetch(link.replace(/#.*/, ""))).status).toBe(410);
    expect(await errorOf(third.sharing.open(link))).toBe("bot_share_stopped");
    expect((await recipient.sharing.status(made.id)).originalGone).toBe(true);
  });

  it("refuses the 21st live link of a daemon and writes nothing", { timeout: 30_000 }, async () => {
    const worker = await startWorker();
    cleanups.push(() => closeServer(worker.server));
    const sharer = await daemon(worker, "server-many");
    const socket = { send: () => {} };
    for (let index = 0; index < 20; index++)
      await worker
        .durable("server-many")
        .controlMessage(socket, { type: "share_create", v: 1, requestId: `r${index}` });
    const bot = await makeBot(sharer, "Release Pal");
    const prepared = await sharer.sharing.prepare(bot.id, {});
    expect(await errorOf(sharer.sharing.publish(bot.id, prepared.candidate.previewId))).toBe(
      "bot_share_limit",
    );
    expect(worker.bucket.objects.size).toBe(0);
    expect((await sharer.sharing.status(bot.id)).link).toBeUndefined();
  });

  it("deleting a shared bot stops its link", { timeout: 30_000 }, async () => {
    const worker = await startWorker();
    cleanups.push(() => closeServer(worker.server));
    const sharer = await daemon(worker, "server-delete");
    const bot = await makeBot(sharer, "Release Pal");
    const prepared = await sharer.sharing.prepare(bot.id, {});
    const link = (await sharer.sharing.publish(bot.id, prepared.candidate.previewId)).link ?? "";
    await sharer.service.delete(bot.id);
    expect((await fetch(link.replace(/#.*/, ""))).status).toBe(410);
  });
});
