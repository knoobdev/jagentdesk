// The template record as Orca dfdb4fda (MIT) declares it: src/shared/bots/bot-templates.ts:45-88.
export interface BotTemplateRecord {
  id: string;
  category: string;
  name: string;
  line: string;
  firstChat: string;
  mascot: string;
  watches: string;
  does: string;
  reports: string;
  connectors: readonly string[];
  schedules: readonly { id: string; when: string; what: string; rrule: string; prompt: string }[];
  events: readonly { id: string; name: string; source: string; event: string; prompt: string }[];
  skills: readonly string[];
  needsSetup?: string;
  example: readonly string[];
}

/** `renderer/.../bots/templates/bot-template-labels.ts`. */
export const BOT_TEMPLATE_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  coding: "Coding",
  releases: "Releases & CI",
  support: "Support & triage",
  planning: "Planning & docs",
  ops: "Ops",
  personal: "Personal assistant",
};

/** Where a template's first-chat setup note is written in the new bot's home. */
export const BOT_SETUP_FILE = "memory/setup.md";
