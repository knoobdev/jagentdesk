import path from "node:path";
import { z } from "zod";
import {
  SshSnippetPackageSchema,
  SshSnippetSchema,
  type SshSnippet,
  type SshSnippetInput,
  type SshSnippetPackage,
  type SshSnippetPackageInput,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { WriteQueue, newSshId, readSecureJson, writeSecureJsonAtomic } from "./secure-file.js";

const LibraryFileSchema = z.object({
  packages: z.array(SshSnippetPackageSchema),
  snippets: z.array(SshSnippetSchema),
});
type LibraryFile = z.infer<typeof LibraryFileSchema>;

const EMPTY_LIBRARY: LibraryFile = { packages: [], snippets: [] };

export class SnippetNotFoundError extends Error {
  constructor(
    readonly kind: "snippet" | "package",
    readonly id: string,
  ) {
    super(`${kind} ${id} not found`);
  }
}

export class SnippetValidationError extends Error {}

/** `snippets.json` (spec 25.2): snippet packages and snippets. */
export class SnippetLibrary {
  private readonly filePath: string;
  private readonly queue = new WriteQueue();

  constructor(
    sshHome: string,
    private readonly now: () => number,
  ) {
    this.filePath = path.join(sshHome, "snippets.json");
  }

  list(): Promise<LibraryFile> {
    return readSecureJson(this.filePath, LibraryFileSchema, EMPTY_LIBRARY);
  }

  async get(id: string): Promise<SshSnippet> {
    const library = await this.list();
    const snippet = library.snippets.find((entry) => entry.id === id);
    if (!snippet) throw new SnippetNotFoundError("snippet", id);
    return snippet;
  }

  save(input: SshSnippetInput): Promise<SshSnippet> {
    return this.queue.run(async () => {
      const label = input.label.trim();
      if (label === "") throw new SnippetValidationError("Snippet label is required");
      if (input.script.trim() === "")
        throw new SnippetValidationError("Snippet script is required");
      const library = await this.list();
      if (input.packageId && !library.packages.some((p) => p.id === input.packageId)) {
        throw new SnippetNotFoundError("package", input.packageId);
      }
      const now = this.now();
      const existing = input.id ? library.snippets.find((s) => s.id === input.id) : undefined;
      if (input.id && !existing) throw new SnippetNotFoundError("snippet", input.id);
      const snippet: SshSnippet = {
        id: existing?.id ?? newSshId("snp"),
        label,
        script: input.script,
        ...(input.packageId ? { packageId: input.packageId } : {}),
        defaultTargets: [...new Set(input.defaultTargets)],
        createdAtMs: existing?.createdAtMs ?? now,
        updatedAtMs: now,
      };
      const snippets = existing
        ? library.snippets.map((s) => (s.id === snippet.id ? snippet : s))
        : [...library.snippets, snippet];
      await writeSecureJsonAtomic(this.filePath, { ...library, snippets });
      return snippet;
    });
  }

  delete(id: string): Promise<void> {
    return this.queue.run(async () => {
      const library = await this.list();
      const snippets = library.snippets.filter((s) => s.id !== id);
      await writeSecureJsonAtomic(this.filePath, { ...library, snippets });
    });
  }

  savePackage(input: SshSnippetPackageInput): Promise<SshSnippetPackage> {
    return this.queue.run(async () => {
      const label = input.label.trim();
      if (label === "") throw new SnippetValidationError("Package label is required");
      const library = await this.list();
      const existing = input.id ? library.packages.find((p) => p.id === input.id) : undefined;
      if (input.id && !existing) throw new SnippetNotFoundError("package", input.id);
      const pkg: SshSnippetPackage = { id: existing?.id ?? newSshId("spk"), label };
      const packages = existing
        ? library.packages.map((p) => (p.id === pkg.id ? pkg : p))
        : [...library.packages, pkg];
      await writeSecureJsonAtomic(this.filePath, { ...library, packages });
      return pkg;
    });
  }

  deletePackage(id: string): Promise<void> {
    return this.queue.run(async () => {
      const library = await this.list();
      const now = this.now();
      const packages = library.packages.filter((p) => p.id !== id);
      // The parsed file is ours to change; moved snippets leave the package in place.
      for (const snippet of library.snippets) {
        if (snippet.packageId !== id) continue;
        delete snippet.packageId;
        snippet.updatedAtMs = now;
      }
      await writeSecureJsonAtomic(this.filePath, { packages, snippets: library.snippets });
    });
  }
}
