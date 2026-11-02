import path from "node:path";
import type {
  SshImportIssue,
  SshImportJumpHop,
  SshImportServerDraft,
} from "@jagentdesk/protocol/ssh/logs-import-schemas";

// Parser for OpenSSH client config (spec 25.9): Host blocks with HostName, User,
// Port, IdentityFile and ProxyJump become server drafts. Settings resolve like ssh(1)
// does: every block whose patterns match the alias applies, first value wins, so
// `Host *` defaults reach the concrete hosts. Wildcard-only blocks, Match blocks and
// Include are reported as skipped; ProxyCommand is reported as ignored.

export type ServerDraftBase = Omit<SshImportServerDraft, "status" | "duplicateOfServerId">;

export interface ParsedServerDrafts {
  servers: ServerDraftBase[];
  issues: SshImportIssue[];
}

interface ConfigOption {
  key: string; // lower-case keyword
  args: string[];
  line: number;
}

interface ConfigBlock {
  kind: "global" | "host" | "match";
  patterns: string[];
  line: number;
  options: ConfigOption[];
}

interface EffectiveHost {
  alias: string;
  line: number;
  values: Map<string, ConfigOption>;
}

export interface SshConfigParseOptions {
  /** Shown in issues and draft ids, e.g. "~/.ssh/config". */
  file: string;
  /** Home directory used to expand `~` and `%d` in IdentityFile. */
  homeDir: string;
}

const LINE_PATTERN = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/;

/** Splits arguments on whitespace, honouring double quotes. */
function splitArgs(rest: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of rest) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && /\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

function parseBlocks(text: string): ConfigBlock[] {
  const blocks: ConfigBlock[] = [{ kind: "global", patterns: [], line: 0, options: [] }];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const match = LINE_PATTERN.exec(raw);
    const key = (match?.[1] ?? raw).toLowerCase();
    const args = splitArgs(match?.[2] ?? "");
    const line = index + 1;
    if (key === "host") {
      blocks.push({ kind: "host", patterns: args, line, options: [] });
    } else if (key === "match") {
      blocks.push({ kind: "match", patterns: args, line, options: [] });
    } else {
      blocks.at(-1)!.options.push({ key, args, line });
    }
  }
  return blocks;
}

function isWildcard(pattern: string): boolean {
  return pattern.startsWith("!") || /[*?]/.test(pattern);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

/** ssh_config(5) pattern lists: one positive match and no negated match. */
function blockMatches(block: ConfigBlock, alias: string): boolean {
  if (block.kind === "global") return true;
  if (block.kind === "match") return false;
  let positive = false;
  for (const pattern of block.patterns) {
    if (pattern.startsWith("!")) {
      if (globToRegExp(pattern.slice(1)).test(alias)) return false;
    } else if (globToRegExp(pattern).test(alias)) {
      positive = true;
    }
  }
  return positive;
}

/** First value wins across every block that applies to `alias` (ssh_config(5)). */
function resolveOptions(blocks: readonly ConfigBlock[], alias: string): Map<string, ConfigOption> {
  const values = new Map<string, ConfigOption>();
  const options = blocks.filter((block) => blockMatches(block, alias)).flatMap((b) => b.options);
  for (const option of options) {
    if (!values.has(option.key)) values.set(option.key, option);
  }
  return values;
}

function effectiveHosts(blocks: readonly ConfigBlock[]): EffectiveHost[] {
  const seen = new Set<string>();
  const hosts: EffectiveHost[] = [];
  for (const block of blocks) {
    if (block.kind !== "host") continue;
    for (const alias of block.patterns) {
      if (isWildcard(alias) || seen.has(alias.toLowerCase())) continue;
      seen.add(alias.toLowerCase());
      hosts.push({ alias, line: block.line, values: resolveOptions(blocks, alias) });
    }
  }
  return hosts;
}

function expandHostName(value: string, alias: string): string {
  return value.replace(/%(%|h)/g, (_token, code: string) => (code === "h" ? alias : "%"));
}

function expandPath(value: string, homeDir: string): string {
  const expanded = value.replace(/%d/g, homeDir);
  if (expanded === "~") return homeDir;
  if (expanded.startsWith("~/")) return path.join(homeDir, expanded.slice(2));
  return expanded;
}

interface ParsedHop {
  host: string;
  port?: number;
  username?: string;
}

/** `[ssh://][user@]host[:port]`, with `[v6]:port` for IPv6. */
export function parseJumpHop(spec: string): ParsedHop | null {
  let rest = spec.trim().replace(/^ssh:\/\//, "");
  let username: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    username = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let host = rest;
  let portText: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) {
    host = bracketed[1]!;
    portText = bracketed[2];
  } else {
    const parts = rest.split(":");
    if (parts.length === 2) {
      host = parts[0]!;
      portText = parts[1];
    }
  }
  if (host === "") return null;
  const port = portText === undefined ? undefined : Number(portText);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return null;
  return {
    host,
    ...(port !== undefined ? { port } : {}),
    ...(username ? { username } : {}),
  };
}

function parsePort(option: ConfigOption | undefined): number | undefined | null {
  if (!option) return undefined;
  const port = Number(option.args[0]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function parseSshConfig(text: string, options: SshConfigParseOptions): ParsedServerDrafts {
  const blocks = parseBlocks(text);
  const issues: SshImportIssue[] = [];
  const at = (line: number) => ({ file: options.file, line });
  for (const block of blocks) {
    if (block.kind === "match") {
      issues.push({
        location: at(block.line),
        severity: "skipped",
        code: "match_block",
        message: "Match blocks are not imported",
      });
    }
    if (block.kind === "host" && block.patterns.every(isWildcard)) {
      issues.push({
        location: at(block.line),
        severity: "skipped",
        code: "wildcard_host",
        message: `Host ${block.patterns.join(" ")} is a pattern; its settings apply to matching hosts`,
      });
    }
    for (const option of block.options) {
      if (option.key === "include") {
        issues.push({
          location: at(option.line),
          severity: "skipped",
          code: "include",
          message: `Include ${option.args.join(" ")} is not followed`,
        });
      }
    }
  }

  const hosts = effectiveHosts(blocks);
  const byAlias = new Map(hosts.map((host) => [host.alias.toLowerCase(), host]));
  const servers: ServerDraftBase[] = [];
  for (const host of hosts) {
    const port = parsePort(host.values.get("port"));
    if (port === null) {
      issues.push({
        location: at(host.values.get("port")!.line),
        severity: "error",
        code: "invalid_line",
        message: `Host ${host.alias}: Port must be a number from 1 to 65535`,
      });
      continue;
    }
    const proxyCommand = host.values.get("proxycommand");
    if (proxyCommand && proxyCommand.args[0]?.toLowerCase() !== "none") {
      issues.push({
        location: at(proxyCommand.line),
        severity: "skipped",
        code: "proxy_command",
        message: `Host ${host.alias}: ProxyCommand is not supported and was ignored`,
      });
    }
    const jumpChain = resolveJumpChain({ host, byAlias, issues, at });
    const hostName = host.values.get("hostname")?.args[0];
    const user = host.values.get("user")?.args[0];
    const identityFile = host.values.get("identityfile")?.args[0];
    servers.push({
      draftId: `${options.file}:${host.line}:${host.alias}`,
      alias: host.alias,
      label: host.alias,
      address: hostName ? expandHostName(hostName, host.alias) : host.alias,
      ...(port !== undefined ? { port } : {}),
      ...(user ? { username: user } : {}),
      groupPath: [],
      tags: [],
      ...(identityFile ? { identityFile: expandPath(identityFile, options.homeDir) } : {}),
      jumpChain,
      location: at(host.line),
    });
  }
  return { servers, issues };
}

function resolveJumpChain(params: {
  host: EffectiveHost;
  byAlias: ReadonlyMap<string, EffectiveHost>;
  issues: SshImportIssue[];
  at: (line: number) => { file: string; line: number };
}): SshImportJumpHop[] {
  const option = params.host.values.get("proxyjump");
  if (!option) return [];
  const value = option.args.join("");
  if (value.toLowerCase() === "none") return [];
  const hops: SshImportJumpHop[] = [];
  for (const spec of value.split(",")) {
    const hop = parseJumpHop(spec);
    if (!hop) {
      params.issues.push({
        location: params.at(option.line),
        severity: "error",
        code: "invalid_line",
        message: `Host ${params.host.alias}: ProxyJump "${spec}" is not [user@]host[:port]`,
      });
      return [];
    }
    const target = params.byAlias.get(hop.host.toLowerCase());
    if (!target) {
      hops.push({
        address: hop.host,
        ...(hop.port ? { port: hop.port } : {}),
        ...(hop.username ? { username: hop.username } : {}),
      });
      continue;
    }
    const hostName = target.values.get("hostname")?.args[0];
    const targetPort = parsePort(target.values.get("port"));
    const targetUser = target.values.get("user")?.args[0];
    const port = hop.port ?? targetPort ?? undefined;
    const username = hop.username ?? targetUser;
    hops.push({
      alias: target.alias,
      address: hostName ? expandHostName(hostName, target.alias) : target.alias,
      ...(port ? { port } : {}),
      ...(username ? { username } : {}),
    });
  }
  return hops;
}
