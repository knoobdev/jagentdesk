import type { AgentProvider, ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import { BotInputSchema, type Bot, type BotInput } from "@jagentdesk/protocol/bots/types";

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
        interval: "60",
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
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  set<K extends keyof BotDraft>(key: K, value: BotDraft[K]) {
    this.state = { ...this.state, [key]: value };
    for (const listener of this.listeners) listener();
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
  input(): BotInput | null {
    const draft = this.state;
    const result = BotInputSchema.safeParse({
      name: draft.name,
      slug: draft.slug,
      identity: draft.identity,
      provider: draft.provider,
      model: draft.model,
      modeId: draft.modeId,
      defaultRepo: draft.defaultRepo.trim() || undefined,
      unattended: draft.unattended,
      lookAround: { enabled: draft.lookAround, intervalMinutes: Number(draft.interval) },
    });
    return result.success ? result.data : null;
  }
}
