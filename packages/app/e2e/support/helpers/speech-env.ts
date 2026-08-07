const LOCAL_SPEECH_ENV_KEYS = [
  "JAGENTDESK_LOCAL_MODELS_DIR",
  "JAGENTDESK_DICTATION_LOCAL_STT_MODEL",
  "JAGENTDESK_VOICE_LOCAL_STT_MODEL",
  "JAGENTDESK_VOICE_LOCAL_TTS_MODEL",
  "JAGENTDESK_VOICE_LOCAL_TTS_SPEAKER_ID",
  "JAGENTDESK_VOICE_LOCAL_TTS_SPEED",
] as const;

const DISABLED_E2E_SPEECH_ENV = {
  JAGENTDESK_DICTATION_ENABLED: "0",
  JAGENTDESK_VOICE_MODE_ENABLED: "0",
  JAGENTDESK_DICTATION_STT_PROVIDER: "openai",
  JAGENTDESK_VOICE_TURN_DETECTION_PROVIDER: "openai",
  JAGENTDESK_VOICE_STT_PROVIDER: "openai",
  JAGENTDESK_VOICE_TTS_PROVIDER: "openai",
} as const;

export function withDisabledE2ESpeechEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Default app E2E does not cover speech flows; keep restarts from starting
  // background local-model downloads for unrelated tests.
  const next: NodeJS.ProcessEnv = {
    ...env,
    ...DISABLED_E2E_SPEECH_ENV,
  };

  for (const key of LOCAL_SPEECH_ENV_KEYS) {
    delete next[key];
  }

  return next;
}
