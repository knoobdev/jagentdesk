// Build the app WEB bundle (plain web platform, includes the /share guest route) into a SEPARATE
// output dir and copy it next to the server dist as `share-app-dist`, so the daemon's ShareServer
// can serve the real app to session-share guests (ADR-0019). Kept separate from packages/app/dist
// (which build:desktop fills with the ELECTRON build for the desktop renderer via extraResources).
// Runs after build:server (which cleans dist) and before electron-builder packages the daemon.
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "packages/app");
const webDist = join(appDir, "dist-share");
const serverDist = join(root, "packages/server/dist/server");
const target = join(serverDist, "share-app-dist");

if (!existsSync(serverDist)) {
  throw new Error("[share-app-dist] server dist missing — run build:server first");
}

console.log("[share-app-dist] building guest app web bundle (plain web) → dist-share…");
rmSync(webDist, { recursive: true, force: true });
execSync("npx expo export --platform web --output-dir dist-share", {
  cwd: appDir,
  stdio: "inherit",
});

if (!existsSync(join(webDist, "index.html"))) {
  throw new Error("[share-app-dist] guest web build missing after expo export");
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(webDist, target, { recursive: true });
console.log(`[share-app-dist] copied ${webDist} → ${target}`);
