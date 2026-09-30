import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { makeTarGz } from "../skills-native/test-utils/fixtures.js";
import { HostToolInstaller, type ManagerRunner } from "./installer.js";
import { getToolDefinition, hostTarget } from "./registry.js";
import { findSha256, type HttpFetch, type HttpResponse } from "./release.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "jad-host-tools-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function response(body: Buffer | string | object, status = 200): HttpResponse {
  const buffer = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(buffer.toString("utf8")),
    text: async () => buffer.toString("utf8"),
    arrayBuffer: async () => new Uint8Array(buffer).slice().buffer,
  };
}

function fakeFetch(
  routes: Record<string, Buffer | string | object>,
): HttpFetch & { calls: string[] } {
  const calls: string[] = [];
  const impl: HttpFetch = async (url) => {
    calls.push(url);
    const route = routes[url];
    return route === undefined ? response("not found", 404) : response(route);
  };
  return Object.assign(impl, { calls });
}

function installer(options: {
  fetch?: HttpFetch;
  installed?: Record<string, string>;
  platform?: NodeJS.Platform;
  arch?: string;
  runManager?: ManagerRunner;
  now?: () => number;
}) {
  const installed = { ...options.installed };
  return new HostToolInstaller({
    jagentdeskHome: home,
    logger: createTestLogger(),
    fetch: options.fetch,
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "arm64",
    find: async (name) => installed[name] ?? null,
    runManager: options.runManager,
    now: options.now,
  });
}

const GH_VERSION = "2.102.0";
const GH_ASSET = `gh_${GH_VERSION}_macOS_arm64.zip`;
const GH_RELEASE_URL = "https://api.github.com/repos/cli/cli/releases/latest";

function ghRoutes(archive: Buffer, digest = sha256(archive)) {
  const assetUrl = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ASSET}`;
  const listUrl = `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt`;
  return {
    assetUrl,
    routes: {
      [GH_RELEASE_URL]: {
        tag_name: `v${GH_VERSION}`,
        assets: [
          { name: GH_ASSET, browser_download_url: assetUrl, size: archive.length },
          { name: `gh_${GH_VERSION}_checksums.txt`, browser_download_url: listUrl },
        ],
      },
      [listUrl]: `${digest}  ${GH_ASSET}\n${"0".repeat(64)}  gh_${GH_VERSION}_linux_amd64.tar.gz\n`,
      [assetUrl]: archive,
    },
  };
}

describe("tool registry", () => {
  it("maps hosts to vendor names", () => {
    expect(hostTarget("win32", "x64")).toEqual({ os: "windows", arch: "amd64" });
    expect(hostTarget("darwin", "arm64")).toEqual({ os: "darwin", arch: "arm64" });
    expect(hostTarget("freebsd", "x64")).toBeNull();
  });

  it("names the release asset for every host", () => {
    const gh = getToolDefinition("gh")!.release!;
    expect(gh.assetFor({ os: "darwin", arch: "arm64" }, "2.102.0")?.asset).toBe(
      "gh_2.102.0_macOS_arm64.zip",
    );
    expect(gh.assetFor({ os: "linux", arch: "amd64" }, "2.102.0")?.asset).toBe(
      "gh_2.102.0_linux_amd64.tar.gz",
    );
    const cloudflared = getToolDefinition("cloudflared")!.release!;
    expect(cloudflared.assetFor({ os: "windows", arch: "arm64" }, "2026.9.3")).toBeNull();
    const helm = getToolDefinition("helm")!.release!;
    expect(helm.assetFor({ os: "windows", arch: "amd64" }, "3.22.0")?.asset).toBe(
      "helm-v3.22.0-windows-amd64.zip",
    );
    expect(getToolDefinition("constructor")).toBeNull();
  });

  it("reads sha256sum lists", () => {
    const hex = "a".repeat(64);
    expect(findSha256(`${hex}  tool.zip\n${"b".repeat(64)}  other.zip`, "tool.zip")).toBe(hex);
    expect(findSha256(`${hex} *tool.zip`, "tool.zip")).toBe(hex);
    expect(findSha256(`${hex}  other.zip`, "tool.zip")).toBeNull();
  });
});

describe("HostToolInstaller", () => {
  it("reports an installed tool as present without any network call", async () => {
    const fetch = fakeFetch({});
    const plan = await installer({ fetch, installed: { gh: "/usr/local/bin/gh" } }).plan("gh");
    expect(plan).toMatchObject({ method: "present", destination: "/usr/local/bin/gh" });
    expect(fetch.calls).toEqual([]);
  });

  it("prefers a user-scope package manager", async () => {
    const plan = await installer({
      installed: { winget: "C:\\winget.exe" },
      platform: "win32",
      arch: "x64",
    }).plan("gh");
    expect(plan).toMatchObject({ method: "package-manager", manager: "winget" });
    expect(plan.command).toEqual(
      expect.arrayContaining(["winget", "install", "--id", "GitHub.cli", "--scope", "user"]),
    );
  });

  it("installs the verified release for this OS and architecture", async () => {
    const archive = Buffer.from(
      zipSync({ [`gh_${GH_VERSION}_macOS_arm64/bin/gh`]: new TextEncoder().encode("#!/bin/sh\n") }),
    );
    const { routes } = ghRoutes(archive);
    const fetch = fakeFetch(routes);
    const tools = installer({ fetch });
    const plan = await tools.plan("gh");
    expect(plan).toMatchObject({
      method: "release",
      version: GH_VERSION,
      checksum: "sha256",
      sizeBytes: archive.length,
    });
    expect(plan.url).toContain("macOS_arm64");
    // The binary is downloaded only when installing.
    expect(fetch.calls.some((url) => url.endsWith(GH_ASSET))).toBe(false);

    // After install the binary is found through tools/bin.
    const bin = path.join(home, "tools", "bin", "gh");
    const lines: string[] = [];
    const withFind = new HostToolInstaller({
      jagentdeskHome: home,
      logger: createTestLogger(),
      fetch,
      platform: "darwin",
      arch: "arm64",
      find: async (name) => (name === "gh" && (await fs.stat(bin).catch(() => null)) ? bin : null),
    });
    const secondPlan = await withFind.plan("gh");
    const result = await withFind.install(secondPlan.planId, (line) => lines.push(line));
    expect(result).toMatchObject({ ok: true, path: bin });
    expect(await fs.readFile(bin, "utf8")).toBe("#!/bin/sh\n");
    expect((await fs.stat(bin)).mode & 0o111).not.toBe(0);
    expect(lines.some((line) => line.startsWith("Verified SHA-256"))).toBe(true);
  });

  it("rejects a download whose checksum does not match and leaves nothing behind", async () => {
    const archive = Buffer.from(zipSync({ "bin/gh": new TextEncoder().encode("x") }));
    const { routes } = ghRoutes(archive, "f".repeat(64));
    const tools = installer({ fetch: fakeFetch(routes) });
    const plan = await tools.plan("gh");
    await expect(tools.install(plan.planId, () => undefined)).rejects.toMatchObject({
      code: "checksum_mismatch",
    });
    await expect(fs.stat(path.join(home, "tools", "gh"))).rejects.toThrow();
    await expect(fs.stat(path.join(home, "tools", "bin", "gh"))).rejects.toThrow();
  });

  it("uses the GitHub digest for cloudflared and extracts a tar.gz", async () => {
    const archive = makeTarGz({ cloudflared: "#!/bin/sh\n" });
    const assetUrl =
      "https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/cloudflared-darwin-arm64.tgz";
    const fetch = fakeFetch({
      "https://api.github.com/repos/cloudflare/cloudflared/releases/latest": {
        tag_name: "2026.9.3",
        assets: [
          {
            name: "cloudflared-darwin-arm64.tgz",
            browser_download_url: assetUrl,
            digest: `sha256:${sha256(archive)}`,
          },
        ],
      },
      [assetUrl]: archive,
    });
    const bin = path.join(home, "tools", "bin", "cloudflared");
    const tools = new HostToolInstaller({
      jagentdeskHome: home,
      logger: createTestLogger(),
      fetch,
      platform: "darwin",
      arch: "arm64",
      find: async (name) =>
        name === "cloudflared" && (await fs.stat(bin).catch(() => null)) ? bin : null,
    });
    const plan = await tools.plan("cloudflared");
    expect(plan.version).toBe("2026.9.3");
    expect(await tools.install(plan.planId, () => undefined)).toMatchObject({ ok: true });
  });

  it("offers only instructions where no build exists", async () => {
    const plan = await installer({
      fetch: fakeFetch({
        "https://api.github.com/repos/cloudflare/cloudflared/releases/latest": {
          tag_name: "2026.9.3",
          assets: [],
        },
      }),
      platform: "win32",
      arch: "arm64",
    }).plan("cloudflared");
    expect(plan.method).toBe("manual");
    expect(plan.notes.join(" ")).toContain("no build for windows arm64");
  });

  it("refuses an expired or unknown plan", async () => {
    let now = 0;
    const tools = installer({ installed: { gh: "/bin/gh" }, now: () => now });
    const plan = await tools.plan("gh");
    now = 11 * 60_000;
    await expect(tools.install(plan.planId, () => undefined)).rejects.toMatchObject({
      code: "plan_expired",
    });
    await expect(tools.plan("rm")).rejects.toMatchObject({ code: "unknown_tool" });
  });
});
