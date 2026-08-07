## ADDED Requirements

### Requirement: Single token source for all design values
The app MUST resolve every color, spacing, font size, radius, icon size, weight, and opacity from the exported token tables in `theme.ts` — never from ad-hoc literals — so that a design value has exactly one definition site (jagentdesk theme.ts:438-505, commonTheme:538-548).

#### Scenario: Component reads a spacing token
- **WHEN** a component needs 16px horizontal padding
- **THEN** it references `theme.spacing[4]` (= 16, jagentdesk theme.ts:446), not a hard-coded `16`

#### Scenario: Component reads a color token
- **WHEN** a component needs the app background color
- **THEN** it references `theme.colors.surface0`, not a hard-coded hex (jagentdesk theme.ts:152, 274)

### Requirement: Six named themes
The app MUST expose exactly six themes named `light`, `dark`, `zinc`, `midnight`, `claude`, and `ghostty`, each mapping to a Unistyles theme key via `THEME_TO_UNISTYLES` (jagentdesk theme.ts:110, 634-641).

#### Scenario: Theme name maps to Unistyles key
- **WHEN** the user selects theme `zinc`
- **THEN** the app activates the `darkZinc` Unistyles theme (jagentdesk theme.ts:637)

#### Scenario: Theme picker swatches
- **WHEN** the theme picker renders swatches
- **THEN** it uses `light` `#ffffff`, `dark` `#2D8B62`, `zinc` `#808080`, `midnight` `#4A6BA8`, `claude` `#D97757`, `ghostty` `#8caaee` (jagentdesk theme.ts:643-650)

### Requirement: Light-theme semantic color tokens
The `light` theme MUST define the semantic tokens with these exact values: `surface0` `#ffffff`, `foreground` `#1a1a1e`, `foregroundMuted` `#71717a`, `foregroundExtraMuted` `#a1a1aa`, `accent` `#20744A`, `accentBright` `#239956`, `accentForeground` `#ffffff`, `destructive` `#b04138`, `border` `#e4e4e7`, `borderAccent` `#ececf1` (jagentdesk theme.ts:164-181, 200-201, 173).

#### Scenario: Light surfaces resolve to exact hex
- **WHEN** the light theme is active
- **THEN** `surface1` = `#fafafa`, `surface2` = `#f4f4f5`, `surface3` = `#e4e4e7`, `surface4` = `#d4d4d8` (jagentdesk theme.ts:154-157)

### Requirement: Dark-theme (jagentdesk default) semantic color tokens
The default `dark` theme MUST define these exact values: `surface0` `#181B1A`, `surface1` `#1E2120`, `surface2` `#272A29`, `surface3` `#434645`, `surface4` `#595B5B`, `foreground` `#fafafa`, `foregroundMuted` `#A1A5A4`, `foregroundExtraMuted` `#717574`, `accent` `#20744A`, `accentBright` `#7ccba0`, `accentForeground` `#ffffff`, `destructive` `#c64f43`, `border` `#252B2A`, `borderAccent` `#2F3534` (jagentdesk theme.ts:284-298, 338-355).

#### Scenario: Dark foreground is fixed
- **WHEN** any dark tint theme is active
- **THEN** `foreground` = `#fafafa` regardless of tint (jagentdesk theme.ts:284)

### Requirement: Diff colors are two-tier per color scheme
The app MUST define diff colors with a saturated tier for the diff view and a chroma-reduced Stat tier for row metadata: light `diffAddition` `#15803d`, `diffDeletion` `#b91c1c`, `diffStatAddition` `#32794a`, `diffStatDeletion` `#a43c39`; dark `diffAddition` `#4ade80`, `diffDeletion` `#ef4444`, `diffStatAddition` `#61bf82`, `diffStatDeletion` `#d36461` (jagentdesk theme.ts:119-131).

#### Scenario: Diff stat uses the muted tier
- **WHEN** a file row shows +/- counts as metadata next to a subtitle
- **THEN** it uses `diffStatAddition`/`diffStatDeletion`, not the saturated `diffAddition`/`diffDeletion` (jagentdesk theme.ts:116-118)

### Requirement: Spacing scale
The app MUST define the SPACING scale exactly as `0:0, 1:4, 1.5:6, 2:8, 3:12, 4:16, 6:24, 8:32, 12:48, 16:64, 20:80, 24:96, 32:128` (jagentdesk theme.ts:438-452).

#### Scenario: Spacing key resolves
- **WHEN** `theme.spacing[8]` is read
- **THEN** it returns `32` (jagentdesk theme.ts:450)

### Requirement: Font size scale
The app MUST define FONT_SIZE exactly as `xs:12, code:12, sm:14, base:16, lg:18, xl:20, 2xl:22, 3xl:26, 4xl:34` (jagentdesk theme.ts:454-464).

#### Scenario: Base font size
- **WHEN** `theme.fontSize.base` is read
- **THEN** it returns `16` (jagentdesk theme.ts:458)

### Requirement: Border radius scale
The app MUST define BORDER_RADIUS exactly as `none:0, sm:2, base:4, md:6, lg:8, xl:12, 2xl:16, full:9999` (jagentdesk theme.ts:484-493).

#### Scenario: Full radius yields a pill
- **WHEN** `theme.borderRadius.full` is applied
- **THEN** it returns `9999` (jagentdesk theme.ts:492)

### Requirement: Icon, weight, and opacity scales
The app MUST define ICON_SIZE `xs:12, sm:14, md:16, lg:20` (jagentdesk theme.ts:470-475), FONT_WEIGHT `normal:"normal", medium:"500", semibold:"600", bold:"bold"` (jagentdesk theme.ts:477-482), OPACITY `0:0, 50:0.5, 100:1` (jagentdesk theme.ts:501-505), and LINE_HEIGHT `diff:22` (jagentdesk theme.ts:466-468).

#### Scenario: Medium weight resolves
- **WHEN** `theme.fontWeight.medium` is read
- **THEN** it returns `"500"` (jagentdesk theme.ts:479)

### Requirement: Theme-independent 10-color identity palette
The app MUST provide a fixed, ordered 10-color identity palette used for project icons — `violet #7a6aa8, sky #3d7ea6, emerald #388068, orange #a4673a, pink #b05c80, indigo #6a70b8, teal #368080, red #b06260, amber #8f7838, blue #5179b0` — where order is load-bearing because `deriveIdentityColorName` indexes into the array (jagentdesk identity-colors.ts:15-41, 60-62).

#### Scenario: Identity color is derived by hash and is theme-independent
- **WHEN** a project key hashes to index 2
- **THEN** it renders `emerald` `#388068` identically in every theme, and its 10%-alpha tint suffix is `1a` (jagentdesk identity-colors.ts:31-50, 60-62)

### Requirement: Control geometry sizes
The app MUST size interactive controls from `createControlGeometry`: button heights tight `28` (xs), compact `32` (sm), field `44` (md/lg); field control heights compact `32` (sm) and field `44` (md); switch track `34x20` with thumb `16` (jagentdesk control-geometry.ts:25-33, 104-149).

#### Scenario: Small button height
- **WHEN** a `sm` button is rendered
- **THEN** its `minHeight` is `32` with `borderRadius.md` (= 6) (jagentdesk control-geometry.ts:135-139)

#### Scenario: Field md control height
- **WHEN** an `md` field control is rendered
- **THEN** its `minHeight` is `44` with `borderRadius.lg` (= 8) (jagentdesk control-geometry.ts:110-115)

### Requirement: Unistyles v3 configuration
The app MUST configure Unistyles v3 via `StyleSheet.configure` with the six themes registered, `adaptiveThemes: true`, and breakpoints `xs:0, sm:576, md:720, lg:992, xl:1200` (jagentdesk unistyles.ts:11-30).

#### Scenario: Adaptive themes on
- **WHEN** the OS switches between light and dark appearance
- **THEN** the app follows it because `adaptiveThemes` is `true` (jagentdesk unistyles.ts:28)

#### Scenario: Breakpoint md
- **WHEN** the viewport reaches width `720`
- **THEN** the `md` breakpoint activates (jagentdesk unistyles.ts:23)

### Requirement: Design principles — token-only color, reuse, list+detail shell, hierarchy, button variants
The design system MUST enforce: colors only from tokens (no literals); reuse existing UI primitives over new ones; a list+detail shell with a fixed-width sidebar of `320` (jagentdesk constants/layout `SETTINGS_DESKTOP_SIDEBAR_WIDTH`, applied at settings-screen.tsx:1667); visual hierarchy expressed by font weight rather than size; and a Button with five variants `default`, `secondary`, `outline`, plus destructive/ghost usage observed at settings-screen.tsx:506, 768, 776.

#### Scenario: New color must be a token
- **WHEN** a contributor needs a new UI color
- **THEN** they add a semantic token in `theme.ts` rather than inlining a hex at the call site (jagentdesk theme.ts:150-229)

#### Scenario: Sidebar width fixed
- **WHEN** the desktop settings shell renders its sidebar
- **THEN** the sidebar width equals `SETTINGS_DESKTOP_SIDEBAR_WIDTH` (jagentdesk settings-screen.tsx:1666-1667)
