import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ForwardingRuleSchema,
  type ForwardingRule,
  type ForwardingRuleInput,
} from "@jagentdesk/protocol/ssh/forwarding-schemas";
import { writePrivateFileAtomicSync } from "../../private-files.js";

export type ForwardingErrorCode =
  | "not_found"
  | "invalid_rule"
  | "port_in_use"
  | "permission_denied"
  | "bind_unavailable"
  | "remote_bind_refused"
  | "connection_lost"
  | "failed";

export class ForwardingError extends Error {
  constructor(
    readonly code: ForwardingErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ForwardingError";
  }
}

const ForwardingFileSchema = z.object({ rules: z.array(ForwardingRuleSchema) });

export const DEFAULT_BIND_ADDRESS = "127.0.0.1";

/** Checks the fields a rule kind needs and fills defaults. */
export function normalizeRule(
  input: ForwardingRuleInput,
): Omit<ForwardingRule, "id" | "createdAtMs" | "updatedAtMs"> {
  const label = input.label.trim();
  if (!label) throw new ForwardingError("invalid_rule", "A rule needs a label");
  const bindAddress = input.bindAddress?.trim() || DEFAULT_BIND_ADDRESS;
  const base = {
    label,
    kind: input.kind,
    serverId: input.serverId,
    bindAddress,
    bindPort: input.bindPort,
  };
  if (input.kind === "dynamic") {
    if (input.bindPort === 0) {
      throw new ForwardingError("invalid_rule", "A SOCKS proxy needs a fixed local port");
    }
    return base;
  }
  const destHost = input.destHost?.trim();
  if (!destHost || !input.destPort) {
    throw new ForwardingError(
      "invalid_rule",
      "Local and remote rules need a destination host and port",
    );
  }
  if (input.kind === "local" && input.bindPort === 0) {
    throw new ForwardingError("invalid_rule", "A local rule needs a fixed local port");
  }
  return { ...base, destHost, destPort: input.destPort };
}

// `forwarding.json` under `$JAGENTDESK_HOME/ssh/` (spec 25.2): atomic writes, 0600 file, 0700 dir.
export class ForwardingRuleStore {
  private readonly filePath: string;
  private rules = new Map<string, ForwardingRule>();

  constructor(sshDir: string) {
    this.filePath = path.join(sshDir, "forwarding.json");
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed = ForwardingFileSchema.parse(JSON.parse(raw));
    this.rules = new Map(parsed.rules.map((rule) => [rule.id, rule]));
  }

  list(): ForwardingRule[] {
    return Array.from(this.rules.values());
  }

  get(id: string): ForwardingRule | null {
    return this.rules.get(id) ?? null;
  }

  put(rule: ForwardingRule): void {
    this.rules.set(rule.id, rule);
    this.persist();
  }

  delete(id: string): void {
    this.rules.delete(id);
    this.persist();
  }

  private persist(): void {
    writePrivateFileAtomicSync(this.filePath, JSON.stringify({ rules: this.list() }, null, 2));
  }
}
