import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import {
  buildSkillInvocationLine,
  isValidSkillName,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_PROVIDER_ORDER,
  type SkillCatalogItem,
  type SkillCatalogItemRef,
  type SkillEntry,
  type SkillFile,
  type SkillPluginInstallResult,
  type SkillScope,
  type SkillSourceRef,
  type SkillSourceSpec,
  type SkillSourceStatus,
  type SkillWrittenPaths,
} from "@jagentdesk/protocol/native-skills";
import {
  applySkillMutation,
  type LearnedEntry,
  type Skill,
  type SkillMutation,
} from "@jagentdesk/protocol/skills";
import { NativeSkillsError } from "./errors.js";
import { copyTree, hashTree, listSkillFiles } from "./fs-utils.js";
import {
  appendLesson,
  composeBody,
  LESSONS_MARKER,
  normalizeLesson,
  renderSkillMarkdown,
  replaceFrontmatterName,
  slugifySkillName,
} from "./frontmatter.js";
import {
  compatSkillId,
  readOwnedContent,
  toLegacySkill,
  trainingAsSkill,
  trainingFromSkill,
} from "./legacy-compat.js";
import {
  emptyLock,
  SkillsLockStore,
  type OwnedSkillRecord,
  type SkillsLock,
} from "./lock-store.js";
import { migrateLegacySkills } from "./migration.js";
import {
  assertWritable,
  conflictError,
  disableOwned,
  enableOwned,
  findAvailableName,
  findConflicts,
  installOwned,
  installTargets,
  moveForeignAside,
  ownedSkillId,
  removeOwned,
  restoreForeign,
  type OpsContext,
} from "./owned-ops.js";
import { parseSkillId } from "./paths.js";
import { SkillSourceBrowser } from "./source-browser.js";
import type { FetchLike } from "./remote-sources.js";
import type { CommandRunner } from "./provider-marketplace.js";
import { readSkillDir, scanSkills } from "./scanner.js";

export type LegacySkillsListener = (skills: Skill[]) => void;

export interface NativeSkillsServiceOptions {
  jagentdeskHome: string;
  /** Home directory of the daemon user (global skill directories live here). */
  homeDir: string;
  logger: Logger;
  fetch?: FetchLike;
  runCommand?: CommandRunner;
  now?: () => number;
}

export interface AuthorInput {
  skillId?: string;
  name: string;
  description: string;
  body: string;
  scope: SkillScope;
  cwd?: string;
}

/**
 * Daemon-side source of truth for native skills (spec 22, ADR-0022). Also
 * serves the legacy `skills.get` / `skills.mutate` API (COMPAT(nativeSkills))
 * from the same owned skills, so it is a drop-in for the old JSON store.
 */
export class NativeSkillsService {
  readonly skillsHome: string;
  private readonly homeDir: string;
  private readonly logger: Logger;
  private readonly lockStore: SkillsLockStore;
  private readonly now: () => number;
  private readonly browser: SkillSourceBrowser;
  private lock: SkillsLock = emptyLock();
  private compat: Skill[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<LegacySkillsListener>();

  constructor(options: NativeSkillsServiceOptions) {
    this.skillsHome = path.join(options.jagentdeskHome, "skills");
    this.homeDir = path.resolve(options.homeDir);
    this.logger = options.logger.child({ module: "skills-native" });
    this.lockStore = new SkillsLockStore(this.skillsHome, this.logger);
    this.now = options.now ?? Date.now;
    this.browser = new SkillSourceBrowser({
      cacheDir: path.join(this.skillsHome, "cache"),
      skillsHome: this.skillsHome,
      homeDir: this.homeDir,
      fetch: options.fetch,
      runCommand: options.runCommand,
      now: this.now,
      onBackgroundError: (error, spec) =>
        this.logger.warn({ err: error, spec }, "Background skill source refresh failed"),
    });
  }

  async initialize(): Promise<void> {
    this.lock = await this.lockStore.load();
    await this.exclusive(async () => {
      const migrated = await migrateLegacySkills({
        skillsHome: this.skillsHome,
        ctx: this.ctx(),
        logger: this.logger,
        existing: () => this.scan(null),
        persist: () => this.lockStore.save(this.lock),
      });
      if (migrated > 0) this.logger.info({ migrated }, "Migrated legacy JSON skills");
    });
    await this.refreshCompat();
  }

  // ── COMPAT(nativeSkills): legacy store surface ─────────────────────────────
  get(): Skill[] {
    return this.compat;
  }

  onChange(listener: LegacySkillsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async mutate(mutation: SkillMutation): Promise<Skill[]> {
    await this.exclusive(() => this.applyLegacyMutation(mutation));
    await this.changed();
    return this.compat;
  }

  // ── Native API (spec 22.4) ─────────────────────────────────────────────────
  async listCatalog(cwd?: string): Promise<{ skills: SkillEntry[]; written: SkillWrittenPaths }> {
    const projectRoot = await this.resolveProjectRoot(cwd);
    return { skills: await this.scan(projectRoot), written: this.writtenPaths() };
  }

  async getSkill(
    skillId: string,
    cwd?: string,
  ): Promise<{ skill: SkillEntry; files: SkillFile[]; body: string }> {
    const skill = await this.resolveEntry(skillId, cwd);
    const info = await readSkillDir(skill.realPath);
    return { skill, files: await listSkillFiles(skill.realPath), body: info?.body ?? "" };
  }

  /**
   * Items of `source`; without it, of the configured sources (`sourceId`, or
   * every enabled source merged).
   */
  async browse(
    source: SkillSourceRef | undefined,
    options: { sourceId?: string; query?: string; refresh?: boolean } = {},
  ): Promise<SkillCatalogItem[]> {
    const projectRoot = source?.kind === "local" ? await this.resolveProjectRoot(source.cwd) : null;
    const installed = await this.scan(projectRoot);
    return this.browser.browse(source, installed, options);
  }

  // ── Configured sources (sources.json) ──────────────────────────────────────
  listSources(): Promise<SkillSourceStatus[]> {
    return this.browser.listSources();
  }

  async addSource(source: string | SkillSourceSpec, label?: string): Promise<SkillSourceStatus> {
    // Listing (network) runs outside the mutation queue; only the store is serialized.
    const spec = await this.browser.validateSource(source);
    const added = await this.exclusive(() => this.browser.storeSource(spec, label));
    await this.changed();
    return added;
  }

  async removeSource(sourceId: string): Promise<void> {
    await this.exclusive(() => this.browser.removeSource(sourceId));
    await this.changed();
  }

  async setSourceEnabled(sourceId: string, enabled: boolean): Promise<SkillSourceStatus> {
    const updated = await this.exclusive(() => this.browser.setSourceEnabled(sourceId, enabled));
    await this.changed();
    return updated;
  }

  /** Settles when background source refreshes are done (tests). */
  idle(): Promise<void> {
    return this.browser.idle();
  }

  async install(input: {
    item: SkillCatalogItemRef;
    scope: SkillScope;
    cwd?: string;
    rename?: string;
  }): Promise<{ skill: SkillEntry | null; plugin: SkillPluginInstallResult | null }> {
    const projectRoot = await this.projectRootFor(input.scope, input.cwd);
    if (input.item.source.kind === "provider-marketplace") {
      const plugin = await this.exclusive(() =>
        this.installPlugin(input.item, input.scope, projectRoot),
      );
      await this.changed();
      return { skill: null, plugin };
    }
    // Network download happens outside the mutation queue; only the write is serialized.
    const resolved = await this.browser.resolveSkillItem(input.item);
    const record = await this.exclusive(async () => {
      const name = input.rename?.trim() || resolved.name;
      const renamed = name !== resolved.frontmatterName;
      return this.installNew(name, input.scope, projectRoot, {
        source: resolved.source,
        populate: async (realPath) => {
          await copyTree(resolved.dir, realPath);
          if (renamed) await this.rewriteName(realPath, name);
        },
      });
    });
    await this.changed();
    return { skill: await this.entryForRecord(record), plugin: null };
  }

  async uninstall(input: {
    skillId: string;
    cwd?: string;
    confirm?: boolean;
  }): Promise<{ removed: string[]; backupPath: string | null }> {
    const result = await this.exclusive(async () => {
      const entry = await this.resolveEntry(input.skillId, input.cwd);
      const owned = this.ownedRecordFor(entry);
      if (owned) {
        const removed = await removeOwned(this.ctx(), owned);
        await this.lockStore.save(this.lock);
        return { removed, backupPath: null };
      }
      this.requireConfirm(input.confirm, `Removing "${entry.name}"`);
      return this.removeForeign(entry);
    });
    await this.changed();
    return result;
  }

  async setEnabled(input: {
    skillId: string;
    enabled: boolean;
    cwd?: string;
    confirm?: boolean;
  }): Promise<SkillEntry> {
    const skillId = await this.exclusive(async () => {
      const entry = await this.resolveEntry(input.skillId, input.cwd);
      if (entry.enabled === input.enabled) return entry.skillId;
      const owned = this.ownedRecordFor(entry);
      if (owned) {
        await (input.enabled ? enableOwned(this.ctx(), owned) : disableOwned(this.ctx(), owned));
      } else {
        await this.setForeignEnabled(entry, input.enabled, input.confirm);
      }
      await this.lockStore.save(this.lock);
      return entry.skillId;
    });
    await this.changed();
    return this.resolveEntry(skillId, input.cwd);
  }

  async author(input: AuthorInput): Promise<SkillEntry> {
    const record = await this.exclusive(() =>
      input.skillId ? this.updateAuthored(input) : this.createAuthored(input),
    );
    await this.changed();
    return this.entryForRecord(record);
  }

  async learn(input: {
    skillId: string;
    lesson: string;
    approved: boolean;
    cwd?: string;
  }): Promise<SkillEntry> {
    const record = await this.exclusive(async () => {
      const owned = await this.requireOwned(input.skillId, input.cwd);
      await this.recordLearn(owned, input.lesson, input.approved);
      return owned;
    });
    await this.changed();
    return this.entryForRecord(record);
  }

  async fork(input: { skillId: string; name?: string; cwd?: string }): Promise<SkillEntry> {
    const record = await this.exclusive(async () => {
      const entry = await this.resolveEntry(input.skillId, input.cwd);
      const requested = input.name?.trim();
      const name =
        requested || (await this.availableName(entry.name, entry.scope, entry.projectRoot));
      return this.installNew(name, entry.scope, entry.projectRoot, {
        source: { kind: "fork", ref: entry.skillId, revision: await hashTree(entry.realPath) },
        populate: async (realPath) => {
          await copyTree(entry.realPath, realPath);
          if (name !== entry.name) await this.rewriteName(realPath, name);
        },
      });
    });
    await this.changed();
    return this.entryForRecord(record);
  }

  /**
   * Spec 22.7: the invocation line the daemon prefixes to a turn for the
   * attached skills. Unknown or disabled skills, and skills the provider cannot
   * see, are skipped (logged). Providers without verified skill directories
   * (generic ACP) get the sentence form for every attached skill.
   */
  async buildInvocationPrefix(
    skillIds: readonly string[],
    provider: string,
    cwd?: string | null,
  ): Promise<string> {
    if (skillIds.length === 0) return "";
    const projectRoot = await this.resolveProjectRoot(cwd ?? undefined).catch(() => null);
    const entries = await this.scan(projectRoot);
    const knownProvider = (SKILL_PROVIDER_ORDER as readonly string[]).includes(provider);
    const names: string[] = [];
    for (const skillId of skillIds) {
      const entry = this.findEntry(entries, skillId);
      if (!entry || !entry.enabled || (knownProvider && !entry.visibleTo.includes(provider))) {
        this.logger.warn({ skillId, provider }, "Attached skill is not available to the provider");
        continue;
      }
      names.push(entry.name);
    }
    return buildSkillInvocationLine(provider, names);
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private ctx(): OpsContext {
    return { homeDir: this.homeDir, skillsHome: this.skillsHome, lock: this.lock, now: this.now };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async changed(): Promise<void> {
    await this.refreshCompat();
    for (const listener of this.listeners) {
      listener(this.compat);
    }
  }

  private async refreshCompat(): Promise<void> {
    const skills: Skill[] = [];
    for (const record of this.lock.skills) {
      skills.push(toLegacySkill(record, await readOwnedContent(record)));
    }
    this.compat = skills.sort((a, b) => b.createdAt - a.createdAt);
  }

  private scan(projectRoot: string | null): Promise<SkillEntry[]> {
    return scanSkills({ homeDir: this.homeDir, projectRoot }, this.lock);
  }

  private async resolveProjectRoot(cwd: string | undefined): Promise<string | null> {
    if (!cwd) return null;
    if (!path.isAbsolute(cwd)) {
      throw new NativeSkillsError("invalid_request", `cwd must be an absolute path: ${cwd}`);
    }
    const stats = await fs.stat(cwd).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new NativeSkillsError("invalid_request", `cwd is not a directory: ${cwd}`);
    }
    return path.resolve(cwd);
  }

  private async projectRootFor(scope: SkillScope, cwd: string | undefined): Promise<string | null> {
    if (scope === "global") return null;
    const root = await this.resolveProjectRoot(cwd);
    if (!root) {
      throw new NativeSkillsError("invalid_request", "Project scope needs the workspace cwd");
    }
    return root;
  }

  private findEntry(entries: readonly SkillEntry[], skillId: string): SkillEntry | undefined {
    const byLegacy = this.lock.skills.find((record) => record.legacyId === skillId);
    const id = byLegacy ? ownedSkillId(byLegacy) : skillId;
    return entries.find((entry) => entry.skillId === id);
  }

  /** The project root a skillId refers to when the request carries no cwd. */
  private recordedProjectRoot(skillId: string): string | null {
    const owned = this.lock.skills.find(
      (record) => record.legacyId === skillId || ownedSkillId(record) === skillId,
    );
    if (owned?.projectRoot) return owned.projectRoot;
    const moved = this.lock.disabled.find((record) => record.skillId === skillId);
    return moved?.projectRoot ?? null;
  }

  private async resolveEntry(skillId: string, cwd?: string): Promise<SkillEntry> {
    const legacy = this.lock.skills.find((record) => record.legacyId === skillId);
    const parsed = parseSkillId(legacy ? ownedSkillId(legacy) : skillId);
    if (!parsed) throw new NativeSkillsError("skill_not_found", `Unknown skill: ${skillId}`);
    let projectRoot = await this.resolveProjectRoot(cwd);
    if (parsed.scope === "project" && !projectRoot) {
      projectRoot = this.recordedProjectRoot(skillId);
      if (!projectRoot) {
        throw new NativeSkillsError("invalid_request", "A project skill needs the workspace cwd");
      }
    }
    const entry = this.findEntry(await this.scan(projectRoot), skillId);
    if (!entry) throw new NativeSkillsError("skill_not_found", `Skill not found: ${skillId}`);
    return entry;
  }

  private ownedRecordFor(entry: SkillEntry): OwnedSkillRecord | null {
    if (!entry.owned) return null;
    return (
      this.lock.skills.find(
        (record) =>
          ownedSkillId(record) === entry.skillId &&
          this.sameProject(record.projectRoot, entry.projectRoot),
      ) ?? null
    );
  }

  private sameProject(a: string | null, b: string | null): boolean {
    return (a ? path.resolve(a) : null) === (b ? path.resolve(b) : null);
  }

  private async requireOwned(skillId: string, cwd?: string): Promise<OwnedSkillRecord> {
    const entry = await this.resolveEntry(skillId, cwd);
    const owned = this.ownedRecordFor(entry);
    if (!owned) {
      throw new NativeSkillsError(
        "skill_not_owned",
        `"${entry.name}" was not installed by JAgentDesk. Create your own copy to train it.`,
      );
    }
    return owned;
  }

  private requireConfirm(confirm: boolean | undefined, action: string): void {
    if (confirm !== true) {
      throw new NativeSkillsError(
        "confirmation_required",
        `${action} changes a skill JAgentDesk did not install; confirm to continue.`,
      );
    }
  }

  private async entryForRecord(record: OwnedSkillRecord): Promise<SkillEntry> {
    const entries = await this.scan(record.projectRoot);
    const entry = entries.find(
      (candidate) => candidate.owned && candidate.skillId === ownedSkillId(record),
    );
    if (!entry) throw new NativeSkillsError("skill_not_found", `Skill not found: ${record.name}`);
    return entry;
  }

  private async installNew(
    name: string,
    scope: SkillScope,
    projectRoot: string | null,
    options: Pick<Parameters<typeof installOwned>[2], "source" | "populate" | "legacy">,
  ): Promise<OwnedSkillRecord> {
    if (!isValidSkillName(name)) {
      throw new NativeSkillsError(
        "invalid_skill",
        `Invalid skill name "${name}": use lowercase letters, digits and hyphens`,
      );
    }
    const targets = installTargets(this.ctx(), name, scope, projectRoot);
    const conflicts = await findConflicts(targets, name, scope, await this.scan(projectRoot));
    if (conflicts.length > 0) throw conflictError(name, conflicts);
    const record = await installOwned(this.ctx(), targets, {
      name,
      scope,
      projectRoot,
      ...options,
    });
    await this.lockStore.save(this.lock);
    return record;
  }

  private async availableName(
    base: string,
    scope: SkillScope,
    projectRoot: string | null,
  ): Promise<string> {
    return findAvailableName(this.ctx(), base, scope, projectRoot, await this.scan(projectRoot));
  }

  private async rewriteName(realPath: string, name: string): Promise<void> {
    const file = path.join(realPath, "SKILL.md");
    await fs.writeFile(file, replaceFrontmatterName(await fs.readFile(file, "utf8"), name));
  }

  private async installPlugin(
    item: SkillCatalogItemRef,
    scope: SkillScope,
    projectRoot: string | null,
  ): Promise<SkillPluginInstallResult> {
    const result = await this.browser.installPlugin(item, scope, projectRoot);
    const [plugin, marketplace] = item.itemId.split("@");
    this.lock.plugins.push({
      provider: result.provider,
      plugin: plugin ?? item.itemId,
      marketplace: marketplace ?? "",
      scope,
      projectRoot,
      command: result.command,
      ok: result.ok,
      installed_at_ms: this.now(),
    });
    await this.lockStore.save(this.lock);
    return result;
  }

  private async removeForeign(
    entry: SkillEntry,
  ): Promise<{ removed: string[]; backupPath: string | null }> {
    const ctx = this.ctx();
    const disabled = this.lock.disabled.find((record) => record.skillId === entry.skillId);
    if (disabled && !entry.enabled) {
      this.lock.disabled = this.lock.disabled.filter((record) => record !== disabled);
      this.lock.removed.push(disabled);
      await this.lockStore.save(this.lock);
      return { removed: [], backupPath: path.dirname(disabled.entries[0]?.backupPath ?? "") };
    }
    const record = await moveForeignAside(ctx, entry, "removed");
    this.lock.removed.push(record);
    await this.lockStore.save(this.lock);
    const backupPath = record.entries[0] ? path.dirname(record.entries[0].backupPath) : null;
    return { removed: record.entries.map((moved) => moved.originalPath), backupPath };
  }

  private async setForeignEnabled(
    entry: SkillEntry,
    enabled: boolean,
    confirm: boolean | undefined,
  ): Promise<void> {
    const ctx = this.ctx();
    if (!enabled) {
      this.requireConfirm(confirm, `Disabling "${entry.name}"`);
      this.lock.disabled.push(await moveForeignAside(ctx, entry, "disabled"));
      return;
    }
    const record = this.lock.disabled.find((candidate) => candidate.skillId === entry.skillId);
    if (!record)
      throw new NativeSkillsError("skill_not_found", `No disabled record: ${entry.skillId}`);
    const hash = await restoreForeign(ctx, record);
    if (hash !== record.contentHash) {
      this.logger.warn({ skillId: record.skillId }, "Restored skill content hash differs");
    }
    this.lock.disabled = this.lock.disabled.filter((candidate) => candidate !== record);
  }

  private async createAuthored(input: AuthorInput): Promise<OwnedSkillRecord> {
    const projectRoot = await this.projectRootFor(input.scope, input.cwd);
    const description = this.validDescription(input.description);
    const content = renderSkillMarkdown({ name: input.name, description, body: input.body });
    return this.installNew(input.name, input.scope, projectRoot, {
      source: { kind: "authored", ref: null, revision: null },
      populate: async (realPath) => {
        await fs.mkdir(realPath, { recursive: true });
        await fs.writeFile(path.join(realPath, "SKILL.md"), content);
      },
    });
  }

  private validDescription(description: string): string {
    const value = description.replace(/\s+/g, " ").trim();
    if (!value || value.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      throw new NativeSkillsError(
        "invalid_skill",
        `A skill needs a description of 1–${SKILL_DESCRIPTION_MAX_LENGTH} characters`,
      );
    }
    return value;
  }

  private async updateAuthored(input: AuthorInput): Promise<OwnedSkillRecord> {
    const owned = await this.requireOwned(input.skillId ?? "", input.cwd);
    if (input.name !== owned.name) {
      throw new NativeSkillsError("invalid_request", "Renaming an existing skill is not supported");
    }
    await this.writeOwnedContent(owned, {
      description: this.validDescription(input.description),
      body: input.body,
    });
    return owned;
  }

  /** Rewrite description/instructions of an owned skill, keeping its lessons section. */
  private async writeOwnedContent(
    record: OwnedSkillRecord,
    patch: { description?: string; body?: string },
  ): Promise<void> {
    const dir = record.enabled ? record.realPath : (record.disabledPath ?? record.realPath);
    assertWritable(this.ctx(), dir, record.projectRoot);
    const current = await readOwnedContent(record);
    let body = composeBody(current.instructions, current.lessons);
    if (patch.body !== undefined) {
      body = patch.body.includes(LESSONS_MARKER)
        ? patch.body
        : composeBody(patch.body, current.lessons);
    }
    const description = patch.description ?? current.description;
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      renderSkillMarkdown({ name: record.name, description, body }),
    );
    await this.touch(record, dir);
  }

  private async touch(record: OwnedSkillRecord, dir: string): Promise<void> {
    record.contentHash = await hashTree(dir);
    record.updated_at_ms = this.now();
    await this.lockStore.save(this.lock);
  }

  private async appendLessonTo(record: OwnedSkillRecord, lesson: string): Promise<void> {
    const dir = record.enabled ? record.realPath : (record.disabledPath ?? record.realPath);
    assertWritable(this.ctx(), dir, record.projectRoot);
    const file = path.join(dir, "SKILL.md");
    await fs.writeFile(file, appendLesson(await fs.readFile(file, "utf8"), lesson));
  }

  private async recordLearn(record: OwnedSkillRecord, lesson: string, approved: boolean) {
    const [next] = applySkillMutation([trainingAsSkill(record)], {
      op: "learn",
      id: compatSkillId(record),
      entryId: `lrn_${this.now()}`,
      rating: approved ? "up" : "down",
      content: lesson,
    });
    if (next) record.training = trainingFromSkill(next, record.training.pending);
    const dir = record.enabled ? record.realPath : (record.disabledPath ?? record.realPath);
    if (approved && normalizeLesson(lesson)) await this.appendLessonTo(record, lesson);
    await this.touch(record, dir);
  }

  // ── COMPAT(nativeSkills): legacy mutations mapped onto owned skills ─────────
  private legacyRecord(id: string): OwnedSkillRecord | undefined {
    return this.lock.skills.find((record) => compatSkillId(record) === id);
  }

  private async applyLegacyMutation(mutation: SkillMutation): Promise<void> {
    if (mutation.op === "add") {
      await this.legacyAdd(mutation.skill);
      return;
    }
    const record = this.legacyRecord(mutation.id);
    if (!record) return;
    switch (mutation.op) {
      case "update":
        await this.legacyUpdate(record, mutation.patch);
        return;
      case "remove":
        await removeOwned(this.ctx(), record);
        await this.lockStore.save(this.lock);
        return;
      default:
        await this.legacyTraining(record, mutation);
    }
  }

  private async legacyAdd(skill: Skill): Promise<void> {
    const instructions = skill.instructions.trim();
    const name = await this.availableName(slugifySkillName(skill.name), "global", null);
    const description =
      skill.description.trim() || firstLine(instructions) || skill.name.trim() || name;
    const content = renderSkillMarkdown({
      name,
      description: description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH),
      body: instructions,
    });
    await this.installNew(name, "global", null, {
      source: { kind: "authored", ref: null, revision: null },
      legacy: {
        legacyId: skill.id,
        displayName: skill.name.trim() || name,
        icon: skill.icon.trim() || null,
        tags: skill.tags.filter(Boolean),
      },
      populate: async (realPath) => {
        await fs.mkdir(realPath, { recursive: true });
        await fs.writeFile(path.join(realPath, "SKILL.md"), content);
      },
    });
  }

  private async legacyUpdate(
    record: OwnedSkillRecord,
    patch: Extract<SkillMutation, { op: "update" }>["patch"],
  ): Promise<void> {
    if (patch.name !== undefined) record.displayName = patch.name.trim() || record.displayName;
    if (patch.icon !== undefined) record.icon = patch.icon.trim() || null;
    if (patch.tags !== undefined) record.tags = patch.tags.filter(Boolean);
    const description = patch.description?.trim();
    await this.writeOwnedContent(record, {
      ...(description ? { description } : {}),
      ...(patch.instructions !== undefined ? { body: patch.instructions.trim() } : {}),
    });
  }

  /** train / learn / propose / resolve / graduate through the shared reducer. */
  private async legacyTraining(record: OwnedSkillRecord, mutation: SkillMutation): Promise<void> {
    const before = trainingAsSkill(record);
    const [next] = applySkillMutation([before], mutation);
    if (!next) return;
    const approvedNow = newlyApproved(before.learned, next.learned);
    if (mutation.op === "train" && mutation.correction?.trim()) {
      approvedNow.push(mutation.correction.trim());
    }
    record.training = trainingFromSkill(
      next,
      next.learned.filter((entry) => !entry.approved),
    );
    for (const lesson of approvedNow) {
      await this.appendLessonTo(record, lesson);
    }
    const dir = record.enabled ? record.realPath : (record.disabledPath ?? record.realPath);
    await this.touch(record, dir);
  }

  private writtenPaths(): SkillWrittenPaths {
    const paths = new Set<string>();
    for (const record of this.lock.skills) {
      paths.add(record.enabled ? record.realPath : (record.disabledPath ?? record.realPath));
      if (record.enabled) record.links.forEach((link) => paths.add(link.path));
    }
    for (const record of [...this.lock.disabled, ...this.lock.removed]) {
      record.entries.forEach((entry) => paths.add(entry.backupPath));
    }
    this.lock.createdDirs.forEach((dir) => paths.add(dir));
    return { lockPath: this.lockStore.lockPath, paths: Array.from(paths).sort() };
  }
}

function newlyApproved(before: LearnedEntry[], after: LearnedEntry[]): string[] {
  const approvedBefore = new Set(before.filter((e) => e.approved).map((e) => e.id));
  return after
    .filter((entry) => entry.approved && !approvedBefore.has(entry.id))
    .map((entry) => entry.content);
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? ""
  );
}
