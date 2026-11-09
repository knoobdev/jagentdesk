import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SshService } from "./ssh-service.js";

const dirs: string[] = [];
async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jad-ssh-storage-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readAllJson(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== "secrets.json");
  return (await Promise.all(files.map((f) => readFile(path.join(dir, f), "utf8")))).join("\n");
}

describe("SshStorage (spec 25.2)", () => {
  it("keeps every secret out of the JSON files and off the wire", async () => {
    const jagentdeskHome = await home();
    const service = new SshService({ jagentdeskHome });
    await service.initialize();
    const password = "pw-" + "x".repeat(12);
    const proxyPassword = "proxy-" + "y".repeat(10);
    const passphrase = "pass-" + "z".repeat(10);
    const server = await service.saveServer(
      {
        id: "",
        label: "web",
        address: "<host>",
        username: "jad",
        proxy: { type: "http", host: "<proxy>", port: 3128, username: "u" },
      },
      { password, proxyPassword },
    );
    const key = await service.generateKey({ label: "laptop", type: "ed25519", passphrase });
    const identity = await service.saveIdentity({ id: "", label: "ops", keyId: key.id }, password);
    await service.storage.flush();

    const sshDir = path.join(jagentdeskHome, "ssh");
    const json = await readAllJson(sshDir);
    expect(
      json.includes(password) || json.includes(proxyPassword) || json.includes(passphrase),
    ).toBe(false);
    expect(json).not.toContain("PRIVATE KEY");
    expect(await service.storage.secrets.get(`ssh.password.${server.id}`)).toBe(password);
    expect(await service.storage.secrets.get(`ssh.proxy.${server.id}`)).toBe(proxyPassword);
    expect(await service.storage.secrets.get(`ssh.passphrase.${key.id}`)).toBe(passphrase);
    expect(await service.storage.secrets.get(`ssh.key.${key.id}`)).toContain("OPENSSH PRIVATE KEY");
    const wire = JSON.stringify([
      await service.getServerInfo(server.id),
      identity,
      key,
      service.storage.listKeys(),
    ]);
    expect(wire.includes(password) || wire.includes(passphrase) || wire.includes("PRIVATE")).toBe(
      false,
    );
    expect([
      server.hasPassword,
      server.proxy?.hasPassword,
      identity.hasPassword,
      key.hasPassphrase,
    ]).toEqual([true, true, true, true]);
    // secrets.json is sealed (AES-256-GCM): plaintext never appears in it either.
    const sealed = await readFile(path.join(sshDir, "secrets.json"), "utf8");
    expect(sealed.includes(password) || sealed.includes(passphrase)).toBe(false);
  });

  it("writes 0600 files in a 0700 directory and reloads them", async () => {
    const jagentdeskHome = await home();
    const service = new SshService({ jagentdeskHome });
    await service.initialize();
    const group = await service.saveGroup({ id: "", label: "Production", username: "deploy" });
    const server = await service.saveServer(
      { id: "", label: "web", address: "<host>", groupId: group.id, tags: ["web"] },
      { password: "pw-for-mode-check" },
    );
    await service.storage.flush();
    const sshDir = path.join(jagentdeskHome, "ssh");
    expect((await stat(sshDir)).mode & 0o777).toBe(0o700);
    for (const file of ["servers.json", "groups.json", "secret.key", "secrets.json"]) {
      expect((await stat(path.join(sshDir, file))).mode & 0o777).toBe(0o600);
    }
    const reloaded = new SshService({ jagentdeskHome });
    await reloaded.initialize();
    expect(reloaded.resolveConfig(server.id)?.username).toBe("deploy");
  });

  it("deleting a group moves its servers and child groups to the parent", async () => {
    const service = new SshService({ jagentdeskHome: await home() });
    await service.initialize();
    const top = await service.saveGroup({ id: "", label: "top", username: "top-user" });
    const mid = await service.saveGroup({ id: "", label: "mid", parentId: top.id });
    const leaf = await service.saveGroup({ id: "", label: "leaf", parentId: mid.id });
    const server = await service.saveServer({
      id: "",
      label: "s",
      address: "<host>",
      groupId: mid.id,
    });
    await service.deleteGroup(mid.id);
    expect([
      service.storage.getServer(server.id)?.groupId,
      service.storage.getGroup(leaf.id)?.parentId,
    ]).toEqual([top.id, top.id]);
    await expect(service.saveGroup({ ...top, parentId: leaf.id })).rejects.toThrow(
      "A group cannot be nested inside itself.",
    );
  });

  it("keeps daemon-owned fields of later milestones across a user save", async () => {
    const service = new SshService({ jagentdeskHome: await home() });
    await service.initialize();
    const saved = await service.saveServer({ id: "", label: "s", address: "<host>" });
    service.storage.patchServerExtras(saved.id, { environment: { os: "linux", detectedAtMs: 1 } });
    await service.saveServer({ id: saved.id, label: "renamed", address: "<host>" });
    expect(service.storage.getServer(saved.id)).toMatchObject({
      label: "renamed",
      environment: { os: "linux", detectedAtMs: 1 },
    });
  });

  it("imports an encrypted key only with its passphrase and exports the public half", async () => {
    const service = new SshService({ jagentdeskHome: await home() });
    await service.initialize();
    const generated = await service.generateKey({
      label: "g",
      type: "ecdsa-256",
      passphrase: "secret-pass",
    });
    const privateKey = (await service.storage.secrets.get(`ssh.key.${generated.id}`))!;
    await expect(service.importKey({ label: "i", privateKey })).rejects.toThrow(
      "This private key is encrypted. Enter its passphrase.",
    );
    const imported = await service.importKey({ label: "i", privateKey, passphrase: "secret-pass" });
    expect([imported.type, imported.fingerprintSha256, imported.hasPassphrase]).toEqual([
      "ecdsa-256",
      generated.fingerprintSha256,
      true,
    ]);
    expect(service.exportPublicKey(imported.id)).toBe(`${generated.publicKey} i`);
    expect(service.exportPublicKey(imported.id, "pem")).toContain("BEGIN PUBLIC KEY");
  });

  it("rejects a tailnet route combined with a proxy, inherited or not (spec 33.2)", async () => {
    const service = new SshService({ jagentdeskHome: await home() });
    await service.initialize();
    await expect(
      service.saveServer({
        id: "",
        label: "wsl",
        address: "100.64.0.2",
        via: "tailnet",
        proxy: { type: "socks5", host: "127.0.0.1", port: 1080 },
      }),
    ).rejects.toThrow("A tailnet route cannot be combined with a proxy");
    const group = await service.saveGroup({
      id: "",
      label: "proxied",
      proxy: { type: "socks5", host: "127.0.0.1", port: 1080 },
    });
    await expect(
      service.saveServer({
        id: "",
        label: "wsl",
        address: "100.64.0.2",
        groupId: group.id,
        via: "tailnet",
      }),
    ).rejects.toThrow("A tailnet route cannot be combined with a proxy");
  });

  it("round-trips via and remoteExec through servers.json (spec 33.2/33.3)", async () => {
    const jagentdeskHome = await home();
    const service = new SshService({ jagentdeskHome });
    await service.initialize();
    const saved = await service.saveServer({
      id: "",
      label: "wsl",
      address: "100.64.0.2",
      via: "tailnet",
      remoteExec: { enabled: true, workRoot: "~/remote-work" },
    });
    await service.storage.flush();

    const reloaded = new SshService({ jagentdeskHome });
    await reloaded.initialize();
    expect(reloaded.storage.getServer(saved.id)).toMatchObject({
      via: "tailnet",
      remoteExec: { enabled: true, workRoot: "~/remote-work" },
    });
    // The connect path reads `via` off the resolved config.
    expect(reloaded.resolveConfig(saved.id)?.via).toBe("tailnet");
    await expect(reloaded.getServerInfo(saved.id)).resolves.toMatchObject({
      via: "tailnet",
      remoteExec: { enabled: true, workRoot: "~/remote-work" },
    });
  });
});
