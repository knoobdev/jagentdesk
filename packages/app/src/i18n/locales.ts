export type SupportedLocale = "ar" | "en" | "es" | "fr" | "ja" | "pt-BR" | "ru" | "vi" | "zh-CN";
export type AppLanguage = "system" | SupportedLocale;

export interface LanguageOption {
  value: AppLanguage;
  labelKey: string;
}

export const DEFAULT_LOCALE: SupportedLocale = "en";

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "system", labelKey: "settings.general.language.options.system" },
  { value: "ar", labelKey: "settings.general.language.options.ar" },
  { value: "en", labelKey: "settings.general.language.options.en" },
  { value: "es", labelKey: "settings.general.language.options.es" },
  { value: "fr", labelKey: "settings.general.language.options.fr" },
  { value: "ja", labelKey: "settings.general.language.options.ja" },
  { value: "pt-BR", labelKey: "settings.general.language.options.ptBR" },
  { value: "ru", labelKey: "settings.general.language.options.ru" },
  { value: "vi", labelKey: "settings.general.language.options.vi" },
  { value: "zh-CN", labelKey: "settings.general.language.options.zhCN" },
];

const SUPPORTED_LANGUAGES = new Set<AppLanguage>([
  "system",
  "ar",
  "en",
  "es",
  "fr",
  "ja",
  "pt-BR",
  "ru",
  "vi",
  "zh-CN",
]);
const LANGUAGE_NATIVE_NAMES: Record<SupportedLocale, string> = {
  ar: "العربية",
  en: "English",
  es: "Español",
  fr: "Français",
  ja: "日本語",
  "pt-BR": "Português brasileiro",
  ru: "Русский",
  vi: "Tiếng Việt",
  "zh-CN": "简体中文",
};
const LANGUAGE_NAMES_BY_LOCALE: Record<SupportedLocale, Record<SupportedLocale, string>> = {
  ar: {
    ar: "العربية",
    en: "الإنجليزية",
    es: "الإسبانية",
    fr: "الفرنسية",
    ja: "اليابانية",
    "pt-BR": "البرتغالية البرازيلية",
    vi: "الفيتنامية",
    ru: "الروسية",
    "zh-CN": "الصينية المبسطة",
  },
  en: {
    ar: "Arabic",
    en: "English",
    es: "Spanish",
    fr: "French",
    ja: "Japanese",
    "pt-BR": "Brazilian Portuguese",
    vi: "Vietnamese",
    ru: "Russian",
    "zh-CN": "Simplified Chinese",
  },
  es: {
    ar: "árabe",
    en: "inglés",
    es: "español",
    fr: "francés",
    ja: "japonés",
    "pt-BR": "portugués brasileño",
    vi: "vietnamita",
    ru: "ruso",
    "zh-CN": "chino simplificado",
  },
  fr: {
    ar: "arabe",
    en: "anglais",
    es: "espagnol",
    fr: "français",
    ja: "japonais",
    "pt-BR": "portugais brésilien",
    vi: "vietnamien",
    ru: "russe",
    "zh-CN": "chinois simplifié",
  },
  ja: {
    ar: "アラビア語",
    en: "英語",
    es: "スペイン語",
    fr: "フランス語",
    ja: "日本語",
    "pt-BR": "ブラジルポルトガル語",
    vi: "ベトナム語",
    ru: "ロシア語",
    "zh-CN": "簡体字中国語",
  },
  "pt-BR": {
    ar: "árabe",
    en: "inglês",
    es: "espanhol",
    fr: "francês",
    ja: "japonês",
    "pt-BR": "Português brasileiro",
    vi: "vietnamita",
    ru: "russo",
    "zh-CN": "chinês simplificado",
  },
  ru: {
    ar: "арабский",
    en: "английский",
    es: "испанский",
    fr: "французский",
    ja: "японский",
    "pt-BR": "бразильский португальский",
    vi: "вьетнамский",
    ru: "русский",
    "zh-CN": "упрощенный китайский",
  },
  vi: {
    ar: "Tiếng Ả Rập",
    en: "Tiếng Anh",
    es: "Tiếng Tây Ban Nha",
    fr: "Tiếng Pháp",
    ja: "Tiếng Nhật",
    "pt-BR": "Tiếng Bồ Đào Nha (Brazil)",
    ru: "Tiếng Nga",
    vi: "Tiếng Việt",
    "zh-CN": "Tiếng Trung giản thể",
  },
  "zh-CN": {
    ar: "阿拉伯语",
    en: "英语",
    es: "西班牙语",
    fr: "法语",
    ja: "日语",
    "pt-BR": "巴西葡萄牙语",
    vi: "越南语",
    ru: "俄语",
    "zh-CN": "简体中文",
  },
};

export function parseAppLanguage(value: unknown): AppLanguage | null {
  return typeof value === "string" && SUPPORTED_LANGUAGES.has(value as AppLanguage)
    ? (value as AppLanguage)
    : null;
}

export function formatLanguageOptionLabel(
  option: LanguageOption,
  activeLocale: SupportedLocale,
  systemLabel: string,
): string {
  if (option.value === "system") {
    return systemLabel;
  }

  const nativeName = LANGUAGE_NATIVE_NAMES[option.value];
  const activeLanguageName = LANGUAGE_NAMES_BY_LOCALE[activeLocale][option.value];
  if (nativeName === activeLanguageName) {
    return nativeName;
  }

  return `${nativeName} - ${activeLanguageName}`;
}

// Languages that accept any region variant (e.g. en-US, ar-EG, vi-VN) — matched
// on the base subtag. Portuguese and Chinese are intentionally NOT here: only
// specific variants map (pt/pt-br → pt-BR; zh/zh-cn/zh-hans* → zh-CN), so
// pt-PT and zh-TW correctly fall through to the default.
const SYSTEM_LOCALE_BY_BASE: Record<string, SupportedLocale> = {
  ar: "ar",
  en: "en",
  es: "es",
  fr: "fr",
  ja: "ja",
  ru: "ru",
  vi: "vi",
};

function matchSystemLocale(normalized: string): SupportedLocale | null {
  const base = normalized.split("-")[0] ?? "";
  const anyRegion = SYSTEM_LOCALE_BY_BASE[base];
  if (anyRegion) {
    return anyRegion;
  }
  if (normalized === "pt" || normalized === "pt-br") {
    return "pt-BR";
  }
  if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-hans")) {
    return "zh-CN";
  }
  return null;
}

export function resolveSupportedLocale(
  language: AppLanguage,
  systemLocales: readonly string[],
): SupportedLocale {
  if (language !== "system") {
    return language;
  }

  for (const locale of systemLocales) {
    const match = matchSystemLocale(locale.toLowerCase());
    if (match) {
      return match;
    }
  }

  return DEFAULT_LOCALE;
}
