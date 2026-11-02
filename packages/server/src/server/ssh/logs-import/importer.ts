import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  SshImportCounts,
  SshImportIssue,
  SshImportJumpHop,
  SshImportKeyDraft,
  SshImportKnownHostDraft,
  SshImportPreview,
  SshImportResult,
  SshImportServerDraft,
  SshImportSource,
} from "@jagentdesk/protocol/ssh/logs-import-schemas";
import { parseServersCsv } from "./csv.js";
import { inspectPrivateKey, scanKeyFiles, type KeyFileCandidate } from "./key-files.js";
import { parseKnownHosts, type KnownHostDraftBase } from "./known-hosts.js";
import { parseSshConfig, type ServerDraftBase } from "./ssh-config.js";

// Import preview/apply (spec 25.9). Parsing is pure; persistence goes through the
// owner's SshImportSink, which saves into S1 storage (servers.json, known_hosts.json,
// keys.json + secret store). Result: added / duplicates (skipped) / failures per line.

export interface SshImportExistingServer {
  id: string;
  label: string;
  address: string;
  port?: number;
  username?: string;
}

export interface SshImportServerInput {
  label: string;
  address: string;
  port?: number;
  username?: string;
  groupId?: string;
  tags: string[];
  /** Key imported from the matching IdentityFile, to attach to the server. */
  keyId?: string;
  /** Server ids, first hop first (spec 25.2 `jumpChain`). */
  jumpChain: string[];
}

export interface SshImportKnownHost {
  host: string;
  port: number;
  keyType: string;
  publicKey: string;
  fingerprintSha256: string;
}

export interface SshImportExistingKey {
  id: string;
  fingerprintSha256: string;
}

export interface SshImportKeyInput {
  label: string;
  privateKey: string;
  passphrase?: string;
}

/** Implemented by the owner on top of S1 storage. */
export interface SshImportSink {
  listServers(): Promise<SshImportExistingServer[]>;
  /** Returns the id of the group at `path` (outermost first), creating missing levels. */
  ensureGroup(path: readonly string[]): Promise<string>;
  saveServer(server: SshImportServerInput): Promise<string>;
  listKnownHosts(): Promise<SshImportKnownHost[]>;
  addKnownHost(entry: SshImportKnownHost): Promise<void>;
  listKeys(): Promise<SshImportExistingKey[]>;
  /** Stores the private key in the secret store; returns the new key id. */
  importKey(input: SshImportKeyInput): Promise<string>;
}

export interface SshImportApplyParams {
  source: SshImportSource;
  serverDraftIds?: readonly string[];
  importKnownHosts: boolean;
  keyPaths: readonly string[];
  passphrases?: Readonly<Record<string, string>>;
}

interface SourceContents {
  servers: ServerDraftBase[];
  knownHosts: KnownHostDraftBase[];
  keys: KeyFileCandidate[];
  issues: SshImportIssue[];
}

export class SshImportPassphraseError extends Error {}

function serverKey(server: { address: string; port?: number; username?: string }): string {
  return `${server.address.toLowerCase()}|${server.port ?? 22}|${server.username ?? ""}`;
}

function knownHostKey(entry: { host: string; port: number; keyType: string }): string {
  return `${entry.host.toLowerCase()}|${entry.port}|${entry.keyType}`;
}

function emptyCounts(): SshImportCounts {
  return { added: 0, duplicates: 0, failed: [] };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export class SshImporter {
  constructor(private readonly options: { sink: SshImportSink; userHome: string }) {}

  async preview(source: SshImportSource): Promise<SshImportPreview> {
    const contents = await this.read(source);
    const existingServers = await this.options.sink.listServers();
    const existingByKey = new Map(existingServers.map((server) => [serverKey(server), server]));
    const knownHosts = await this.options.sink.listKnownHosts();
    const knownHostKeys = new Set(knownHosts.map(knownHostKey));
    const keyFingerprints = new Set(
      (await this.options.sink.listKeys()).map((k) => k.fingerprintSha256),
    );
    const servers: SshImportServerDraft[] = contents.servers.map((draft) => {
      const duplicate = existingByKey.get(serverKey(draft));
      if (!duplicate) return { ...draft, status: "new" };
      return { ...draft, status: "duplicate", duplicateOfServerId: duplicate.id };
    });
    const knownHostDrafts: SshImportKnownHostDraft[] = contents.knownHosts.map((entry) => ({
      ...entry,
      status: knownHostKeys.has(knownHostKey(entry)) ? "duplicate" : "new",
    }));
    const keys: SshImportKeyDraft[] = contents.keys.map((key) => ({
      ...key,
      status:
        key.fingerprintSha256 !== null && keyFingerprints.has(key.fingerprintSha256)
          ? "duplicate"
          : "new",
    }));
    return { servers, knownHosts: knownHostDrafts, keys, issues: contents.issues };
  }

  async apply(params: SshImportApplyParams): Promise<SshImportResult> {
    const contents = await this.read(params.source);
    const keyResult = await this.applyKeys(contents.keys, params);
    const servers = await this.applyServers(
      contents.servers,
      params.serverDraftIds,
      keyResult.keyIdByPath,
    );
    const knownHosts = params.importKnownHosts
      ? await this.applyKnownHosts(contents.knownHosts)
      : emptyCounts();
    return { servers, knownHosts, keys: keyResult.counts, issues: contents.issues };
  }

  private async read(source: SshImportSource): Promise<SourceContents> {
    const homeDir = this.options.userHome;
    if (source.kind === "csv") {
      const parsed = parseServersCsv(source.text, "CSV");
      return { servers: parsed.servers, knownHosts: [], keys: [], issues: parsed.issues };
    }
    if (source.kind === "ssh_config") {
      const parsed = parseSshConfig(source.text, { file: "ssh_config", homeDir });
      return { servers: parsed.servers, knownHosts: [], keys: [], issues: parsed.issues };
    }
    const sshDir = path.join(homeDir, ".ssh");
    const configText = (await readOptional(path.join(sshDir, "config"))) ?? "";
    const config = parseSshConfig(configText, { file: "~/.ssh/config", homeDir });
    const knownHostsText = (await readOptional(path.join(sshDir, "known_hosts"))) ?? "";
    const knownHosts = parseKnownHosts(knownHostsText, "~/.ssh/known_hosts");
    const keys = await scanKeyFiles(sshDir);
    return {
      servers: config.servers,
      knownHosts: knownHosts.knownHosts,
      keys,
      issues: [...config.issues, ...knownHosts.issues],
    };
  }

  private async applyKeys(
    candidates: readonly KeyFileCandidate[],
    params: SshImportApplyParams,
  ): Promise<{ counts: SshImportCounts; keyIdByPath: Map<string, string> }> {
    const counts = emptyCounts();
    const keyIdByPath = new Map<string, string>();
    const existing = await this.options.sink.listKeys();
    const idByFingerprint = new Map(existing.map((key) => [key.fingerprintSha256, key.id]));
    for (const candidate of candidates) {
      const knownId =
        candidate.fingerprintSha256 === null
          ? undefined
          : idByFingerprint.get(candidate.fingerprintSha256);
      if (knownId) keyIdByPath.set(candidate.path, knownId);
    }
    const selected = new Set(params.keyPaths);
    for (const candidate of candidates) {
      if (!selected.has(candidate.path)) continue;
      const location = { file: candidate.path, line: 1 };
      if (keyIdByPath.has(candidate.path)) {
        counts.duplicates += 1;
        continue;
      }
      try {
        const passphrase = params.passphrases?.[candidate.path];
        const data = await fs.readFile(candidate.path);
        const inspection = inspectPrivateKey(data, passphrase);
        if (inspection.kind !== "plain") {
          throw new SshImportPassphraseError(
            passphrase ? "The passphrase is wrong" : "This key needs its passphrase",
          );
        }
        const known = idByFingerprint.get(inspection.fingerprintSha256);
        if (known) {
          keyIdByPath.set(candidate.path, known);
          counts.duplicates += 1;
          continue;
        }
        const keyId = await this.options.sink.importKey({
          label: candidate.label,
          privateKey: data.toString("utf8"),
          ...(passphrase ? { passphrase } : {}),
        });
        idByFingerprint.set(inspection.fingerprintSha256, keyId);
        keyIdByPath.set(candidate.path, keyId);
        counts.added += 1;
      } catch (error) {
        counts.failed.push({ location, message: messageOf(error) });
      }
    }
    return { counts, keyIdByPath };
  }

  private async applyServers(
    drafts: readonly ServerDraftBase[],
    selectedIds: readonly string[] | undefined,
    keyIdByPath: ReadonlyMap<string, string>,
  ): Promise<SshImportCounts> {
    const counts = emptyCounts();
    const sink = this.options.sink;
    const existing = await sink.listServers();
    const idByServerKey = new Map(existing.map((server) => [serverKey(server), server.id]));
    const byAlias = new Map(drafts.map((draft) => [draft.alias.toLowerCase(), draft]));
    const idByAlias = new Map<string, string>();
    const selected = selectedIds ? new Set(selectedIds) : null;
    const order = orderWithJumpHosts(
      drafts.filter((draft) => !selected || selected.has(draft.draftId)),
      byAlias,
    );
    for (const entry of order) {
      if (entry.kind === "loop") {
        counts.failed.push({
          location: entry.draft.location,
          message: "ProxyJump hosts form a loop",
        });
        continue;
      }
      const { draft } = entry;
      const known = idByServerKey.get(serverKey(draft));
      if (known) {
        idByAlias.set(draft.alias.toLowerCase(), known);
        counts.duplicates += 1;
        continue;
      }
      try {
        const jumpChain: string[] = [];
        for (const hop of draft.jumpChain) {
          jumpChain.push(await this.resolveHop(hop, { idByAlias, idByServerKey, counts }));
        }
        const groupId =
          draft.groupPath.length > 0 ? await sink.ensureGroup(draft.groupPath) : undefined;
        const keyId = draft.identityFile ? keyIdByPath.get(draft.identityFile) : undefined;
        const id = await sink.saveServer({
          label: draft.label,
          address: draft.address,
          ...(draft.port !== undefined ? { port: draft.port } : {}),
          ...(draft.username ? { username: draft.username } : {}),
          ...(groupId ? { groupId } : {}),
          tags: draft.tags,
          ...(keyId ? { keyId } : {}),
          jumpChain,
        });
        idByAlias.set(draft.alias.toLowerCase(), id);
        idByServerKey.set(serverKey(draft), id);
        counts.added += 1;
      } catch (error) {
        counts.failed.push({ location: draft.location, message: messageOf(error) });
      }
    }
    return counts;
  }

  /** A hop is an imported alias, an existing server, or a new server created for it. */
  private async resolveHop(
    hop: SshImportJumpHop,
    state: {
      idByAlias: Map<string, string>;
      idByServerKey: Map<string, string>;
      counts: SshImportCounts;
    },
  ): Promise<string> {
    const aliased = hop.alias ? state.idByAlias.get(hop.alias.toLowerCase()) : undefined;
    if (aliased) return aliased;
    const known = state.idByServerKey.get(serverKey(hop));
    if (known) return known;
    const label = [
      hop.username ? `${hop.username}@` : "",
      hop.address,
      hop.port ? `:${hop.port}` : "",
    ].join("");
    const id = await this.options.sink.saveServer({
      label,
      address: hop.address,
      ...(hop.port !== undefined ? { port: hop.port } : {}),
      ...(hop.username ? { username: hop.username } : {}),
      tags: [],
      jumpChain: [],
    });
    state.idByServerKey.set(serverKey(hop), id);
    if (hop.alias) state.idByAlias.set(hop.alias.toLowerCase(), id);
    state.counts.added += 1;
    return id;
  }

  private async applyKnownHosts(entries: readonly KnownHostDraftBase[]): Promise<SshImportCounts> {
    const counts = emptyCounts();
    const stored = new Map(
      (await this.options.sink.listKnownHosts()).map((entry) => [knownHostKey(entry), entry]),
    );
    for (const entry of entries) {
      const existing = stored.get(knownHostKey(entry));
      if (existing && existing.publicKey === entry.publicKey) {
        counts.duplicates += 1;
        continue;
      }
      if (existing) {
        // A different stored key is only replaceable by ssh.knownhosts.replace (spec 25.3).
        counts.failed.push({
          location: entry.location,
          message: `${entry.host}:${entry.port} already has a different ${entry.keyType} key`,
        });
        continue;
      }
      try {
        const record: SshImportKnownHost = {
          host: entry.host,
          port: entry.port,
          keyType: entry.keyType,
          publicKey: entry.publicKey,
          fingerprintSha256: entry.fingerprintSha256,
        };
        await this.options.sink.addKnownHost(record);
        stored.set(knownHostKey(entry), record);
        counts.added += 1;
      } catch (error) {
        counts.failed.push({ location: entry.location, message: messageOf(error) });
      }
    }
    return counts;
  }
}

type OrderedDraft =
  | { kind: "draft"; draft: ServerDraftBase }
  | { kind: "loop"; draft: ServerDraftBase };

/**
 * Selected drafts with the drafts their ProxyJump aliases name placed first, so every
 * hop already has an id when the server that uses it is saved.
 */
export function orderWithJumpHosts(
  selected: readonly ServerDraftBase[],
  byAlias: ReadonlyMap<string, ServerDraftBase>,
): OrderedDraft[] {
  const order: OrderedDraft[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (draft: ServerDraftBase): boolean => {
    const key = draft.alias.toLowerCase();
    const current = state.get(key);
    if (current === "done") return true;
    if (current === "visiting") return false;
    state.set(key, "visiting");
    for (const hop of draft.jumpChain) {
      const target = hop.alias ? byAlias.get(hop.alias.toLowerCase()) : undefined;
      if (target && !visit(target)) {
        state.set(key, "done");
        order.push({ kind: "loop", draft });
        return false;
      }
    }
    state.set(key, "done");
    order.push({ kind: "draft", draft });
    return true;
  };
  for (const draft of selected) visit(draft);
  return order;
}
