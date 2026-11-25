/**
 * What a composer is being used for. `Composer` and `MessageInput` are one
 * component with two jobs, not two components: a terminal prompt still wants
 * the same bordered surface, grow-on-newline, submit button, focus handling,
 * and keyboard shift that a chat message gets.
 *
 * `message` is a plain text message to something that is not an agent turn (a bot's
 * inbox): text only, no attachments, voice or agent chips it could not carry.
 *
 * Callers pick a mode and nothing else. What a mode implies lives here, so the
 * two presentations cannot drift apart one prop at a time.
 */
export type ComposerInputMode = "chat" | "terminal" | "message";

export interface ComposerInputModePresentation {
  /** Attachments, dictation/voice, slash-and-@ autocomplete, and the model/mode
   * chips are all chat-agent affordances. A terminal prompt becomes argv. */
  showAttachments: boolean;
  showVoice: boolean;
  showAutocomplete: boolean;
  showAgentControls: boolean;
  /** Argv is read character by character, so it gets the terminal's own font. */
  isMonospace: boolean;
  /** i18n key for the text input's accessible name. */
  accessibilityLabelKey: string;
}

const PRESENTATION_BY_MODE: Record<ComposerInputMode, ComposerInputModePresentation> = {
  chat: {
    showAttachments: true,
    showVoice: true,
    showAutocomplete: true,
    showAgentControls: true,
    isMonospace: false,
    accessibilityLabelKey: "composer.input.accessibilityLabel",
  },
  terminal: {
    showAttachments: false,
    showVoice: false,
    showAutocomplete: false,
    showAgentControls: false,
    isMonospace: true,
    accessibilityLabelKey: "composer.input.terminalAccessibilityLabel",
  },
  message: {
    showAttachments: false,
    showVoice: false,
    showAutocomplete: false,
    showAgentControls: false,
    isMonospace: false,
    accessibilityLabelKey: "composer.input.accessibilityLabel",
  },
};

export function resolveComposerInputMode(mode: ComposerInputMode): ComposerInputModePresentation {
  return PRESENTATION_BY_MODE[mode];
}
