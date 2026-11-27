// The New bot dialog's form model (docs/forms.md): plain TypeScript, no React. Ported from Orca
// dfdb4fda (MIT) src/renderer/src/components/bots/NewBotDialog.tsx:131-260 (state and submit gate),
// NewBotPurposeField.tsx:9-10,47-60 (identity limit and counter), BotPictureCarousel.tsx:41-45,116-120
// (wrapped carousel), BotRunsOnPicker.tsx:43-50 (folder preview) and new-bot-draft.ts:18-50 (a
// template's identity box). Spec 37.5, 37.5.1.
import {
  BOT_AVATAR_COLORS,
  BOT_IDENTITY_COUNTER_FROM,
  BOT_IDENTITY_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  DEFAULT_BOT_AVATAR_COLOR,
  PICKABLE_BOT_MASCOT_IDS,
  botFolderName,
} from "@jagentdesk/protocol/bots/rules";
import type { AgentProvider, ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";

export interface PickerOption {
  id: string;
  label: string;
}

/** Search in the Provider and Model pickers: by name or id, any case, a plain substring (A37.5.3b). */
export function filterPickerOptions<T extends PickerOption>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
  );
}

/** The carousel wraps both ways (`BotPictureCarousel.tsx` go()). */
export function wrapIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

/** The mascot of a stored `mascot:<id>`, as its place in the carousel; -1 when it isn't offered. */
export function pickableMascotIndex(avatar: string | null | undefined): number {
  if (!avatar?.startsWith("mascot:")) return -1;
  const id = avatar.slice("mascot:".length);
  return PICKABLE_BOT_MASCOT_IDS.findIndex((entry) => entry === id);
}

export function mascotAvatar(index: number): string {
  return `mascot:${PICKABLE_BOT_MASCOT_IDS[wrapIndex(index, PICKABLE_BOT_MASCOT_IDS.length)]}`;
}

export function isBotAvatarColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/.test(value);
}

/**
 * "Folder: {{path}}": the folder the name asks for, with the `-2`, `-3`… the daemon would add for
 * folders bots already hold, under the bots directory when a bot on this host shows where it is.
 * The daemon still decides (it also skips folders deleted bots held).
 */
export function botFolderPreview(
  name: string,
  bots: readonly { folder?: string; slug: string; home?: string }[],
): string {
  const base = botFolderName(name);
  const taken = new Set(bots.map((bot) => bot.folder ?? bot.slug));
  let folder = base;
  for (let suffix = 2; taken.has(folder); suffix += 1) folder = `${base}-${suffix}`;
  const home = bots.find((bot) => bot.home)?.home;
  if (!home) return folder;
  const at = Math.max(home.lastIndexOf("/"), home.lastIndexOf("\\"));
  return at > 0 ? `${home.slice(0, at + 1)}${folder}` : folder;
}

export interface NewBotTemplateSeed {
  id: string;
  name: string;
  mascot: string;
  watches: string;
  does: string;
  reports: string;
}

/** `new-bot-draft.ts` shownTemplateIdentity: what it watches, does and reports, as sentences. */
export function templateIdentity(
  template: Pick<NewBotTemplateSeed, "watches" | "does" | "reports">,
  say: { watches: (what: string) => string; reports: (what: string) => string },
): string {
  const lines = [
    template.watches ? say.watches(template.watches) : null,
    template.does || null,
    template.reports ? say.reports(template.reports) : null,
  ].filter((line): line is string => Boolean(line));
  return lines
    .map((line) => line.trim())
    .map((line) => (/[.!?…]$/.test(line) ? line : `${line}.`))
    .join(" ");
}

export type ProviderResolution = "pending" | "complete";

export interface NewBotFormState {
  name: string;
  identity: string;
  /** A template's identity box as it opened: no counter, no limit until it is edited. */
  prefilledIdentity: string | null;
  mascotIndex: number;
  avatarColor: string;
  avatarOutfit: string | null;
  provider: AgentProvider | null;
  providerLabel: string;
  model: string;
  modelLabel: string;
  providers: readonly ProviderSnapshotEntry[];
  resolution: ProviderResolution;
  /** "Change" opened the Provider and Model pickers. */
  runsOnOpen: boolean;
  pictureOpen: boolean;
  /** Create was pressed: validation shows from then on. */
  submitted: boolean;
  creating: boolean;
  error: string | null;
  templateId: string | null;
  // Derived on every publish.
  identityCount: number;
  showIdentityCounter: boolean;
  identityTooLong: boolean;
  nameMissing: boolean;
  noAgents: boolean;
  canSubmit: boolean;
}

export interface OpenNewBotFormInput {
  /** The random mascot a new bot starts with (`bot-new-record.ts`: one of the 19). */
  mascotIndex: number;
  template?: NewBotTemplateSeed | null;
  /** The template's identity box, already worded in the UI language. */
  templateIdentityText?: string | null;
  initialName?: string;
}

function readyEntries(entries: readonly ProviderSnapshotEntry[]): ProviderSnapshotEntry[] {
  return entries.filter((entry) => entry.enabled && entry.status === "ready");
}

function defaultModel(entry: ProviderSnapshotEntry) {
  const models = entry.models ?? [];
  return models.find((candidate) => candidate.isDefault) ?? models[0] ?? null;
}

export class NewBotFormModel {
  private listeners = new Set<() => void>();
  private state: NewBotFormState;

  constructor(input: OpenNewBotFormInput) {
    this.state = derive({
      name: input.initialName ?? "",
      identity: "",
      prefilledIdentity: null,
      mascotIndex: wrapIndex(input.mascotIndex, PICKABLE_BOT_MASCOT_IDS.length),
      avatarColor: DEFAULT_BOT_AVATAR_COLOR,
      avatarOutfit: null,
      provider: null,
      providerLabel: "",
      model: "",
      modelLabel: "",
      providers: [],
      resolution: "pending",
      runsOnOpen: false,
      pictureOpen: false,
      submitted: false,
      creating: false,
      error: null,
      templateId: null,
      identityCount: 0,
      showIdentityCounter: false,
      identityTooLong: false,
      nameMissing: true,
      noAgents: false,
      canSubmit: false,
    });
    if (input.template) this.applyTemplate(input.template, input.templateIdentityText ?? null);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;

  private publish(patch: Partial<NewBotFormState>) {
    this.state = derive({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }

  /** A template that loaded after the dialog opened: its name, mascot and identity, once. */
  applyTemplate(template: NewBotTemplateSeed, identityText: string | null) {
    if (this.state.templateId === template.id) return;
    const mascot = pickableMascotIndex(`mascot:${template.mascot}`);
    this.publish({
      templateId: template.id,
      name: this.state.name || template.name,
      mascotIndex: mascot === -1 ? this.state.mascotIndex : mascot,
      identity: identityText ?? this.state.identity,
      prefilledIdentity: identityText,
    });
  }

  /** The host's providers arrived or changed: keep the pick, or take the first ready one. */
  applyProviders(entries: readonly ProviderSnapshotEntry[], loaded: boolean) {
    const providers = readyEntries(entries);
    const kept = providers.find((entry) => entry.provider === this.state.provider);
    if (kept || !loaded) {
      this.publish({ providers, resolution: loaded ? "complete" : this.state.resolution });
      return;
    }
    const first = providers[0];
    const model = first ? defaultModel(first) : null;
    this.publish({
      providers,
      resolution: "complete",
      provider: first?.provider ?? null,
      providerLabel: first ? (first.label ?? first.provider) : "",
      model: model?.id ?? "",
      modelLabel: model?.label ?? "",
    });
  }

  setName(name: string) {
    this.publish({ name: name.slice(0, BOT_NAME_MAX_LENGTH), error: null });
  }
  setIdentity(identity: string) {
    this.publish({ identity, error: null });
  }
  toggleRunsOn() {
    this.publish({ runsOnOpen: !this.state.runsOnOpen });
  }
  togglePicture() {
    this.publish({ pictureOpen: !this.state.pictureOpen });
  }
  stepMascot(delta: number) {
    this.publish({
      mascotIndex: wrapIndex(this.state.mascotIndex + delta, PICKABLE_BOT_MASCOT_IDS.length),
    });
  }
  setPicture(next: { avatar: string; avatarColor: string; avatarOutfit: string | null }) {
    const index = pickableMascotIndex(next.avatar);
    this.publish({
      mascotIndex: index === -1 ? this.state.mascotIndex : index,
      avatarColor: isBotAvatarColor(next.avatarColor) ? next.avatarColor : this.state.avatarColor,
      avatarOutfit: next.avatarOutfit,
    });
  }
  selectProvider(provider: string) {
    const entry = this.state.providers.find((candidate) => candidate.provider === provider);
    if (!entry) return;
    const model = defaultModel(entry);
    this.publish({
      provider: entry.provider,
      providerLabel: entry.label ?? entry.provider,
      model: model?.id ?? "",
      modelLabel: model?.label ?? "",
    });
  }
  selectModel(model: string, label: string) {
    this.publish({ model, modelLabel: label });
  }

  /** Create pressed: true when it may go to the daemon; otherwise validation now shows. */
  submit(): boolean {
    this.publish({ submitted: true });
    return this.state.canSubmit && !this.state.creating;
  }
  startCreating() {
    this.publish({ creating: true, error: null });
  }
  failCreating(message: string) {
    this.publish({ creating: false, error: message });
  }

  picture(): { avatar: string; avatarColor: string; avatarOutfit: string | null } {
    return {
      avatar: mascotAvatar(this.state.mascotIndex),
      avatarColor: this.state.avatarColor,
      avatarOutfit: this.state.avatarOutfit,
    };
  }

  /** The identity to send: nothing when left empty, or left as the template wrote it. */
  identityToSend(): string | undefined {
    const identity = this.state.identity.trim();
    if (!identity) return undefined;
    if (
      this.state.prefilledIdentity !== null &&
      this.state.identity === this.state.prefilledIdentity
    )
      return undefined;
    return identity;
  }
}

function derive(state: NewBotFormState): NewBotFormState {
  const edited = state.prefilledIdentity === null || state.identity !== state.prefilledIdentity;
  const identityCount = state.identity.length;
  const identityTooLong = edited && identityCount > BOT_IDENTITY_MAX_LENGTH;
  const nameMissing = state.name.trim() === "";
  const noAgents = state.resolution === "complete" && state.providers.length === 0;
  return {
    ...state,
    identityCount,
    showIdentityCounter: edited && identityCount >= BOT_IDENTITY_COUNTER_FROM,
    identityTooLong,
    nameMissing,
    noAgents,
    canSubmit:
      !nameMissing &&
      !identityTooLong &&
      !noAgents &&
      state.provider !== null &&
      state.model !== "",
  };
}

export const BOT_AVATAR_COLOR_NAME_KEYS: Record<(typeof BOT_AVATAR_COLORS)[number], string> = {
  "#b3dbf4": "bots.new.colorSky",
  "#ffffff": "bots.new.colorWhite",
  "#c9b8e8": "bots.new.colorLavender",
  "#f4c4cf": "bots.new.colorPink",
  "#f8cfa8": "bots.new.colorPeach",
  "#f6e3a1": "bots.new.colorButter",
  "#c5dfb5": "bots.new.colorSage",
  "#b5e3d8": "bots.new.colorMint",
  "#8fa3b8": "bots.new.colorSlate",
  "#3a3f4b": "bots.new.colorGraphite",
  "#1f2126": "bots.new.colorInk",
};

export const BOT_AVATAR_OUTFIT_NAME_KEYS: Record<string, string> = {
  tie: "bots.new.outfitTie",
  detective: "bots.new.outfitDetective",
  "hard-hat": "bots.new.outfitHardHat",
  reviewer: "bots.new.outfitReviewer",
  "night-shift": "bots.new.outfitNightShift",
  artist: "bots.new.outfitArtist",
  scientist: "bots.new.outfitScientist",
  party: "bots.new.outfitParty",
  security: "bots.new.outfitSecurity",
};
