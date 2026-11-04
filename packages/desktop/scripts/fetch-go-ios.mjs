#!/usr/bin/env node
// Bundles go-ios (MIT, github.com/danielpaulus/go-ios) for the OS this desktop build targets
// (spec 27.1). Pinned version + sha256; output goes to .cache/go-ios, which electron-builder copies
// to resources/bin/go-ios. Usage: node scripts/fetch-go-ios.mjs [darwin|linux|win32]
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const VERSION = "1.3.2";
const ASSETS = {
  darwin: {
    asset: "go-ios-mac.zip",
    sha256: "100f225bfdd039081bcbdaf45029df3e67032673f3e0ca1fa3c050898c230c57",
  },
  linux: {
    asset: "go-ios-linux.zip",
    sha256: "a55fdb4c507391c0548252e01d1deb6ae3c7fd99cfbce842c6f80569cc125604",
  },
  win32: {
    asset: "go-ios-win.zip",
    sha256: "939c6bcaafed183a92afb9f79cc11b1f935fa6389bfc94d3902e3f52c4dff3fe",
  },
};

const platform = process.argv[2] ?? process.platform;
const spec = ASSETS[platform];
if (!spec) {
  console.error(`go-ios has no build for ${platform}`);
  process.exit(1);
}

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(desktopDir, ".cache", "go-ios");
const archive = path.join(desktopDir, ".cache", `go-ios-${VERSION}-${spec.asset}`);

let bytes;
if (existsSync(archive)) {
  bytes = await readFile(archive);
} else {
  const url = `https://github.com/danielpaulus/go-ios/releases/download/v${VERSION}/${spec.asset}`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Download failed (${response.status}): ${url}`);
    process.exit(1);
  }
  bytes = Buffer.from(await response.arrayBuffer());
}
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== spec.sha256) {
  console.error(
    `go-ios checksum mismatch for ${spec.asset}: expected ${spec.sha256}, got ${digest}`,
  );
  process.exit(1);
}
await mkdir(path.dirname(archive), { recursive: true });
await writeFile(archive, bytes);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const [name, data] of Object.entries(unzipSync(new Uint8Array(bytes)))) {
  if (name.endsWith("/")) continue;
  const target = path.join(outDir, path.basename(name));
  await writeFile(target, data);
  await chmod(target, 0o755);
}
// MIT: the notice ships next to the binary.
await writeFile(
  path.join(outDir, "LICENSE"),
  await readFile(path.join(desktopDir, "assets", "third-party", "go-ios", "LICENSE")),
);
console.log(`go-ios ${VERSION} (${spec.asset}) → ${outDir}`);
