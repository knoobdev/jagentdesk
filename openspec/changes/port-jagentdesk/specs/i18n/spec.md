## ADDED Requirements

### Requirement: Client supports the cloned locale set
The client MUST support exactly the eight locales `ar`, `en`, `es`, `fr`, `ja`, `pt-BR`, `ru`, and `zh-CN`, plus the `system` selection, with `en` as the default locale (`scratchpad/reference/packages/app/src/i18n/locales.ts:1-20,23-42`).

#### Scenario: Unsupported locale is rejected
- **GIVEN** a persisted language value is not `system` or one of the eight supported locale IDs
- **WHEN** `parseAppLanguage` parses it
- **THEN** it returns `null` (`scratchpad/reference/packages/app/src/i18n/locales.ts:23-33,127-130`)

### Requirement: System language resolves deterministically
When language is `system`, the client MUST inspect system locale tags in order, map supported prefixes to the eight locale IDs, and fall back to `en` when none matches (`scratchpad/reference/packages/app/src/i18n/locales.ts:151-187`).

#### Scenario: System locale selects Brazilian Portuguese
- **GIVEN** the configured language is `system` and system locales include `pt-BR`
- **WHEN** the client resolves the supported locale
- **THEN** it returns `pt-BR` (`scratchpad/reference/packages/app/src/i18n/locales.ts:151-178`)

#### Scenario: Unknown system locale falls back to English
- **GIVEN** the configured language is `system` and no system locale matches a supported mapping
- **WHEN** the client resolves the supported locale
- **THEN** it returns `en` (`scratchpad/reference/packages/app/src/i18n/locales.ts:185-187`)

### Requirement: Locale is selected from application settings at render time
The client MUST obtain the language setting, read browser or native system locales, resolve the locale, synchronize i18next before rendering children, and provide the i18next context (`scratchpad/reference/packages/app/src/i18n/provider.tsx:1-29`).

#### Scenario: Explicit language overrides system locales
- **GIVEN** settings language is `ja` and the operating system locale is `en-US`
- **WHEN** `I18nProvider` renders
- **THEN** it resolves `ja` and supplies the i18next provider with the synchronized language (`scratchpad/reference/packages/app/src/i18n/provider.tsx:22-29`; `scratchpad/reference/packages/app/src/i18n/locales.ts:151-157`)

### Requirement: Product UI strings use translation keys
Product UI code MUST use translation keys resolved by i18next rather than hard-coded user-facing strings; the English resource MUST provide the default UI strings, including composer placeholders and actions (`scratchpad/reference/packages/app/src/i18n/resources/en.ts:1-39,77-93`).

#### Scenario: Composer exposes platform-specific translated placeholders
- **GIVEN** the composer renders on desktop or mobile
- **WHEN** it requests its placeholder
- **THEN** it resolves `composer.placeholders.desktop` or `composer.placeholders.mobile` from the English resource or active locale (`scratchpad/reference/packages/app/src/i18n/resources/en.ts:77-82`)

