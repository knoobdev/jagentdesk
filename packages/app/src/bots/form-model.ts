import type { AgentProvider, ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import { BotInputSchema, type Bot, type BotInput } from "@jagentdesk/protocol/bots/types";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 64;
const NAME_MAX = 64;
export const IDENTITY_MAX = 500;
const DEFAULT_INTERVAL_MINUTES = 60;

export type BotFormField =
  | "name"
  | "slug"
  | "identity"
  | "provider"
  | "model"
  | "mode"
  | "interval";
/** i18n keys, one per field that holds a wrong value. */
export type BotFieldErrors = Partial<Record<BotFormField, string>>;
export interface BotFormValidation {
  errors: BotFieldErrors;
  /** i18n key naming the first empty required field; Create stays disabled while it is set. */
  missing: string | null;
}

/** Lowercase, hyphen-separated slug from a display name ("Heo Con" → "heo-con"). */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
}

function parseInterval(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return Number.isSafeInteger(minutes) && minutes >= 1 ? minutes : null;
}

export function validateBotDraft(draft: BotDraft): BotFormValidation {
  const errors: BotFieldErrors = {};
  const name = draft.name.trim();
  if (name.length > NAME_MAX) errors.name = "bots.errors.nameTooLong";
  if (draft.slug && (draft.slug.length > SLUG_MAX || !SLUG_PATTERN.test(draft.slug)))
    errors.slug = "bots.errors.slug";
  if (draft.identity.trim().length > IDENTITY_MAX) errors.identity = "bots.errors.identityTooLong";
  if (draft.lookAround && parseInterval(draft.interval) === null)
    errors.interval = "bots.errors.interval";
  let missing: string | null = null;
  if (!name) missing = "bots.required.name";
  else if (!draft.slug) missing = "bots.required.slug";
  else if (!draft.provider) missing = "bots.required.provider";
  else if (!draft.model) missing = "bots.required.model";
  else if (!draft.modeId) missing = "bots.required.mode";
  return { errors, missing };
}

export interface BotInputOptions {
  /** The host accepts an empty identity (`features.botsOptionalIdentity`). */
  optionalIdentity: boolean;
}

export interface BotDraft {
  name: string;
  slug: string;
  identity: string;
  provider: AgentProvider | null;
  providerLabel: string;
  modelLabel: string;
  modeLabel: string;
  model: string;
  modeId: string;
  defaultRepo: string;
  unattended: boolean;
  lookAround: boolean;
  interval: string;
  /** Set once the owner types a slug; until then the slug follows the name. */
  slugEdited: boolean;
}
export class BotFormModel {
  private listeners = new Set<() => void>();
  private state: BotDraft;
  constructor(bot: Bot | null) {
    if (!bot) {
      this.state = {
        name: "",
        slug: "",
        identity: "",
        provider: null,
        providerLabel: "",
        modelLabel: "",
        modeLabel: "",
        model: "",
        modeId: "",
        defaultRepo: "",
        unattended: false,
        lookAround: false,
        interval: String(DEFAULT_INTERVAL_MINUTES),
        slugEdited: false,
      };
      return;
    }
    this.state = {
      name: bot.name,
      slug: bot.slug,
      identity: bot.identity,
      provider: bot.provider,
      providerLabel: bot.provider,
      modelLabel: bot.model,
      modeLabel: bot.modeId,
      model: bot.model,
      modeId: bot.modeId,
      defaultRepo: bot.defaultRepo ?? "",
      unattended: bot.unattended,
      lookAround: bot.lookAround.enabled,
      interval: String(bot.lookAround.intervalMinutes),
      slugEdited: true,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  private publish(state: BotDraft) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  set<K extends keyof BotDraft>(key: K, value: BotDraft[K]) {
    this.publish({ ...this.state, [key]: value });
  }
  setName(name: string) {
    const draft = this.state;
    this.publish({ ...draft, name, slug: draft.slugEdited ? draft.slug : slugFromName(name) });
  }
  /** Clearing the slug hands it back to the name. */
  setSlug(slug: string) {
    const edited = slug !== "";
    this.publish({
      ...this.state,
      slug: edited ? slug : slugFromName(this.state.name),
      slugEdited: edited,
    });
  }
  validation(): BotFormValidation {
    return validateBotDraft(this.state);
  }
  selectProvider(entry: ProviderSnapshotEntry) {
    const models = entry.models ?? [];
    const model = models.find((candidate) => candidate.isDefault) ?? models[0];
    this.state = {
      ...this.state,
      provider: entry.provider,
      providerLabel: entry.label ?? entry.provider,
      modelLabel: model?.label ?? "",
      modeLabel:
        entry.modes?.find((mode) => mode.id === entry.defaultModeId)?.label ??
        entry.modes?.[0]?.label ??
        "",
      model: model?.id ?? "",
      modeId: entry.defaultModeId ?? entry.modes?.[0]?.id ?? "",
    };
    for (const listener of this.listeners) listener();
  }
  selectModel(value: string, label: string) {
    this.state = { ...this.state, model: value, modelLabel: label };
    for (const listener of this.listeners) listener();
  }
  selectMode(value: string, label: string) {
    this.state = { ...this.state, modeId: value, modeLabel: label };
    for (const listener of this.listeners) listener();
  }
  input(options: BotInputOptions): BotInput | null {
    const draft = this.state;
    const validation = validateBotDraft(draft);
    if (validation.missing || Object.keys(validation.errors).length > 0) return null;
    const name = draft.name.trim();
    const identity = draft.identity.trim();
    const result = BotInputSchema.safeParse({
      name,
      slug: draft.slug,
      // COMPAT(botsOptionalIdentity): added in v0.10.1; older hosts require an identity, so the
      // name stands in. Remove after 2027-05-26.
      identity: identity !== "" || options.optionalIdentity ? identity : name,
      provider: draft.provider,
      model: draft.model,
      modeId: draft.modeId,
      defaultRepo: draft.defaultRepo.trim() || undefined,
      unattended: draft.unattended,
      lookAround: {
        enabled: draft.lookAround,
        intervalMinutes: parseInterval(draft.interval) ?? DEFAULT_INTERVAL_MINUTES,
      },
    });
    return result.success ? result.data : null;
  }
}
