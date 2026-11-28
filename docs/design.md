# Design

Tokens — every color, font size, weight, spacing step, radius, icon size — live in `packages/app/src/styles/theme.ts`. Gumloop is the default theme. Tokens that differ between the Gumloop and classic shells live on `theme.chrome`; [themes.md](themes.md) owns the themes and the shell.

---

## 1. Character

JAgentDesk is minimal, spacious, quiet, confident. Whitespace is deliberate. Nothing crowds, nothing decorates, nothing apologizes. A row, a label, a control. That is the bar.

The app is calm so the user's work is not. Every visual decision serves either _act on this_ or _understand this_ — never _look at this_.

Consistency comes from component reuse, not from hand-matching styles across surfaces. A row in the projects list, a row in settings, and a row in a modal are the same component, not three implementations that happen to look alike. When two surfaces do the same semantic thing in two different ways, one of them is wrong.

---

## 2. Component reuse

A semantic element used in three or more places is a primitive. One of a kind is a screen.

Primitives live in `packages/app/src/components/ui/` and `packages/app/src/components/headers/`. Card and row layout live in `packages/app/src/styles/settings.ts`. Section structure lives in `packages/app/src/screens/settings/settings-section.tsx`. Sidebar navigation rows are `<GumloopRow>` (`packages/app/src/components/gumloop-shell/row.tsx`). Full-screen pages (History, Schedules, Bots, Market, Settings on the Gumloop shell) use `<PageHeader>` (`packages/app/src/components/headers/page-header.tsx`).

A pressable styled to look like a button is wrong; the button is `<Button>` (`packages/app/src/components/ui/button.tsx`). A bare `<Text>` styled to look like a section header is wrong; the section header is `<SettingsSection>` (`packages/app/src/screens/settings/settings-section.tsx`). A custom `Modal` for a confirmation is wrong; the confirmation is `confirmDialog` (`packages/app/src/utils/confirm-dialog.ts`). A hand-rolled overflow menu is wrong; the menu is `<DropdownMenu>` (`packages/app/src/components/ui/dropdown-menu.tsx`). A hand-rolled status pill is wrong; the pill is `<StatusBadge>` (`packages/app/src/components/ui/status-badge.tsx`).

Before adding a new component, read `components/ui/`. The primitive usually exists.

---

## 3. Hierarchy

Hierarchy is conveyed through weight and color, not size. Most labels, titles, and hints across the app are `fontSize.base` or `fontSize.xs`. The distinction between a row's primary line and its secondary line is `foreground` versus `foregroundMuted`.

Weight has three tiers, applied by role. Where the two shells disagree, the weight is a `theme.chrome` token; read the token, never hardcode the number.

- **Screen titles** — the title at the top of a screen — use `<ScreenTitle>` (`packages/app/src/components/headers/screen-title.tsx`), which reads `chrome.titleWeightCompact` and `chrome.titleWeight`. Classic themes render `400` on compact and `300` on desktop; Gumloop renders `600` on both. The workspace screen header follows the same tokens (`packages/app/src/screens/workspace/workspace-screen.tsx`).
- **Structural labels** use `fontWeight.medium`. This applies to section labels above a stack of rows (`sectionTitle` in `packages/app/src/components/agent-list.tsx`, `packages/app/src/components/keyboard-shortcuts-dialog.tsx`), form field labels above an input inside a modal (`packages/app/src/components/add-host-modal.tsx`, `packages/app/src/components/pair-link-modal.tsx`), the title at the top of a modal/sheet/dialog (`packages/app/src/components/adaptive-modal-sheet.tsx`, `packages/app/src/components/ui/combobox.tsx`, `packages/app/src/components/welcome-screen.tsx`), action button labels in tight components such as the sidebar callout actions (`packages/app/src/components/sidebar-callout.tsx`), and inline data emphasis on dense metadata rows (`packages/app/src/components/file-explorer-pane.tsx`). Settings section titles read `chrome.sectionTitleWeight`.
- **Content** uses `fontWeight.normal`. This applies to sidebar list-item titles (`packages/app/src/components/sidebar-workspace-list.tsx`, `packages/app/src/components/agent-list.tsx`), `<StatusBadge>` text (`packages/app/src/components/ui/status-badge.tsx`), and `<SidebarCallout>` titles (`packages/app/src/components/sidebar-callout.tsx`). Settings row titles read `chrome.rowTitleWeight` and `<Button>` text reads `chrome.buttonTextWeight`: `normal` on classic themes, `500` on Gumloop.

The rule, condensed: text that _names_ a surface or a group is `medium`. Text that lives _inside_ a surface or a group is `normal`, or the shell's content token. Top-of-screen titles are `<ScreenTitle>`.

Foreground is for the thing being acted on: row titles, section headings, the selected sidebar item. `foregroundMuted` is for context: hints, descriptions, secondary metadata, idle sidebar items, placeholders, status text.

`foregroundExtraMuted` is reserved for passive chrome that must sit behind muted text, such as an always-visible window control. Use the solid token instead of lowering SVG opacity; per-path opacity makes overlapping icon strokes render unevenly. Interactive hover and pressed states return to `foreground`.

The primary CTA is one per surface. A `<Button variant="default">` filled with `chrome.createBackground` — `accent` on classic themes, `primary` (near-black in light Gumloop) on Gumloop — appears at most once on a page. Most pages have zero — settings is mostly toggles and text, the workspace pane is mostly content, the chat composer is the input itself.

Destructive is a color, not a click. Restart-daemon and remove-host are `<Button variant="outline">` in the row trailing slot; the destructive surface only appears inside the `confirmDialog` (`packages/app/src/screens/settings/host-page.tsx`). Workspace archive opens a confirm dialog before any red appears (`packages/app/src/components/sidebar-workspace-list.tsx`). Red appears after the user has indicated intent.

---

## 4. Buttons

The button is `<Button>` (`packages/app/src/components/ui/button.tsx`). It has five variants. Each has one job.

`default` is the one primary action on a surface — filled with `chrome.createBackground`. At most one per page. The primary slot inside an `<AdaptiveModalSheet>` and the highlighted action on the welcome screen are the canonical uses.

`secondary` is the paired action when two actions carry equal weight — filled with `surface3`. The component default is `secondary`, which matches its frequency in the codebase.

`outline` is the low-frequency action that lives on a row — `chrome.outlineBackground` with `chrome.outlineBorder` (transparent with `borderAccent` on classic themes, `surface1` with `border` on Gumloop). Restart, Remove, Update on host detail (`packages/app/src/screens/settings/host-page.tsx`).

`ghost` is structural and non-committal — no border, no fill. Back arrows, header toggles, "Load more" footers (`packages/app/src/screens/sessions-screen.tsx`), more-affordances. Ghost is used when the affordance is part of the chrome, not a decision.

`destructive` is filled with `destructive`. It only appears inside a confirm. The button on the page is `outline`; the destructive button is the confirm button inside the dialog.

Sizes: `xs` for ultra-tight inline triggers. `sm` for any button sitting in a row. `md` is the page default. `lg` is reserved for large standalone CTAs.

Sizes are a shared contract across control kinds, defined once in `packages/app/src/components/ui/control-geometry.ts`: `xs` = 28px tall with `fontSize.xs` labels, `sm` = 32px with `fontSize.sm`, `md`/`lg` = 44px with `fontSize.sm`. On Gumloop, `<Button>` raises `sm` to 34px and uses 16px labels. `<SegmentedControl>` (`packages/app/src/components/ui/segmented-control.tsx`) takes the same `xs`/`sm`/`md` sizes — a segmented control next to a `<Button>` of the same size always matches in height, label size, and horizontal padding. Thin chrome such as the file toolbar uses `xs`; settings rows use `sm`. Never shrink a control's font or padding locally to fit a context — if the context needs a smaller control, the size tier is missing or the wrong one is in use.

A `<Pressable>` wrapping a `<Text>` is a sixth variant. It is wrong. `<Button>` accepts `style`, `textStyle`, `leftIcon`, `disabled`, `size`, and `variant`.

---

## 5. Borders

Borders group, separate, or rarely emphasize.

A logical block of related rows lives inside a card — one border around the whole group. The card primitive is `settingsStyles.card`, which reads `chrome.cardBackground`, `chrome.cardBorder`, and `chrome.cardRadius`. The border defines what belongs together.

Rows after the first inside a card carry `settingsStyles.rowBorder` — a single top border. The first row never has one. Rows do not need their own background to feel separated.

A list that is itself the page content — sidebar items in `sidebar-workspace-list.tsx`, the sidebar navigation, the agent list (`packages/app/src/components/agent-list.tsx`) — uses spacing and surface, not borders, to separate items. Rows-in-a-card is an interior pattern; lists-as-pages are not.

Pane chrome — the workspace pane header, the file-explorer header, the diff pane header — uses a single bottom border to separate the header from the content (`packages/app/src/git/diff-pane.tsx`). One border, no shadow.

`borderAccent` is reserved for the outline button. Inputs use `border`. Single-thing borders are wrong; a single bordered element is either a card with one row (use the card) or it does not need a border.

---

## 6. Pickers

Five primitives. The pick is determined by option count, the need to search, and how the picker is anchored.

`<DropdownMenu>` is for a small fixed set anchored to a trigger. Theme picker, kebab menus on workspace and project rows (`packages/app/src/components/sidebar-workspace-list.tsx`), row "more" menus. [menus.md](menus.md) owns the menu engine. Items can be async (`status: "pending"`) and can include destructive entries. Under ~10 options where the user knows what they're looking for.

`<Combobox>` is for a large or searchable list. Host switcher in the sidebar header (`<HostPicker>`), model selector in the composer, branch switcher in the workspace header (`packages/app/src/components/branch-switcher.tsx`). The user types to find the option, or the list is long enough to scroll.

`<ContextMenu>` is for right-click and long-press on a target. The row is the trigger; there is no visible affordance. Used for incidental actions on workspace rows in the sidebar (`packages/app/src/components/sidebar-workspace-list.tsx`).

`<AdaptiveModalSheet>` is for a focused task. Multi-field forms (`packages/app/src/components/add-host-modal.tsx`, `packages/app/src/components/pair-link-modal.tsx`), confirmations with detail, anything that earns a backdrop. Bottom sheet on compact, centered card on desktop. Raw `Modal` is wrong for any of these.

`<AdaptiveModalSheet>` owns the presentation. Its content inset — the gutter that puts sheet content on the same rails as the sheet header — and compact bottom safe-area padding are the sheet's, not the caller's. A caller declares layout intent through `contentStyle` and never branches on form factor to add its own margins. If a sheet's first snap point is shorter than its header, content, and safe-area clearance, raise that snap point rather than moving the sheet container.

`confirmDialog` is for destructive yes/no and imperative confirmation. Promise-based: `await confirmDialog({ destructive: true, ... })`. Anything where a wrong click loses work.

Three themes is `DropdownMenu`. Thirty hosts is `Combobox`. A label and a value is `AdaptiveModalSheet`. "Are you sure?" is `confirmDialog`.

---

## 7. Density and rhythm

Settings detail pages, the projects detail page, and any list+detail content sit inside a centered, max-width 720 column (`packages/app/src/screens/settings-screen.tsx`, `packages/app/src/screens/projects-screen.tsx`). On the Gumloop desktop shell, Settings content instead aligns to the page header's 82px left inset with a wider cap. Lines stay readable, the eye does not have to track wide horizontal distances. Form modals carry their own narrower content frame (`packages/app/src/components/add-host-modal.tsx`).

Workspace and chat surfaces use the full width — these are working surfaces, not reading surfaces. The chat and composer cap their width at the theme's `contentMaxWidth` (the Appearance setting; default `DEFAULT_CONTENT_MAX_WIDTH`, re-exported as `MAX_CONTENT_WIDTH` from `packages/app/src/constants/layout.ts`) to keep lines readable while letting the workspace pane fill the rest.

Sections sit apart. `<SettingsSection>` owns its own bottom margin; the next thing is wrapped in another `<SettingsSection>`. The agent-list `sectionHeading` carries the same `marginTop`/`marginBottom` rhythm (`packages/app/src/components/agent-list.tsx`). Adding `marginBottom` to a section is wrong.

Cards inside a section sit closer than sections. Rows inside a card touch — only the divider separates them. The rhythm is page → spacious; section → spacious; card → tight.

Rows have generous vertical padding: roughly 16px of content plus 16px of vertical padding for settings rows, 8–12px for sidebar list items where many rows must fit. Sidebar navigation rows are 34px on desktop and 44px on compact for touch. Compressing rows below the established density to fit more on the screen is wrong. Too many rows means more cards or more sections, not smaller rows.

The whitespace is the design.

---

## 8. Alignment

Things align to their glyphs, not to their boxes. A row's leading icon, its title, and the label of the button in its trailing slot sit on the same rails — the ink lines up, not the padding, not the touch target, not the hover background.

Pick the rails from the content, then hold them. A settings card establishes a leading rail at the icon's left edge and a trailing rail at the last glyph's right edge; every row in that card uses the same two. A row whose icon is absent still starts its title on the leading rail. Indentation is a new rail, not an arbitrary offset.

The pressable is bigger than the glyph, and that is fine. Hit areas grow outward from the aligned content — they never move it. A button that looks two pixels off because its padding is asymmetric is misaligned even though its box is correct.

Optical alignment beats arithmetic when a glyph disagrees with its bounding box. Icons with visual weight on one side, chevrons, and single-character labels usually need a small nudge to look centered. Trust the eye, then leave a comment saying the offset is optical.

One row off the rail makes the whole card look unconsidered.

---

## 9. Responsiveness

Compact-first. The small case is designed; the large case adds chrome around it.

Compact is the `xs`/`sm` Unistyles breakpoint (below 600px), read with `useIsCompactFormFactor()`.

The list+detail pattern is canonical and reused across surfaces. The settings shell (`packages/app/src/screens/settings-screen.tsx`) and the projects screen (`packages/app/src/screens/projects-screen.tsx`) implement it:

- On compact: full-screen list with `<BackHeader>` at the top. Tapping a row pushes a full-screen detail with its own `<BackHeader>` that returns to the list.
- On desktop with a classic theme: a 320px sidebar on the left holds the list with `surfaceSidebar` background. The content pane on the right holds the selected detail with `<ScreenHeader>`, `<HeaderIconBadge>`, and `<ScreenTitle>`.
- On desktop with Gumloop: the list portals into the app sidebar as a drill-in panel, and the detail fills the content area under a `<PageHeader>`. See [themes.md](themes.md#desktop).

The branching is one `useIsCompactFormFactor()` check at the top of the screen component. The list and the detail are the same components in every layout; only the framing changes.

The workspace screen (`packages/app/src/screens/workspace/workspace-screen.tsx`) follows a different but parallel rule: tabs collapse on compact, panes split on desktop. The app sidebar is pinned on desktop and becomes a drawer on compact ([mobile-panels.md](mobile-panels.md)).

On a narrow desktop route, app navigation yields to the rendered content topology when the remaining width cannot preserve its center target: Settings keeps its 320px list + 400px detail split (`SETTINGS_DESKTOP_SPLIT_MIN_WIDTH` in `packages/app/src/constants/layout.ts`), and a workspace Explorer keeps its current visible width plus a 400px center pane. That is a topology decision at the app container, not a second compact breakpoint. Temporary width clamps are render-only; widening restores the user's saved sidebar widths.

Electron window controls are top-corner obstructions, not a compact-layout condition. Rendered surfaces declare which top corners they physically occupy (`WindowChromeRegion corners=…`); only those corners receive clearance. Full-window overlays redeclare both corners. A focused split pane owns both corners; if focus restoration temporarily exposes the full split tree, the split boundary reserves one top strip instead of assigning a control rectangle to an arbitrarily narrow leaf.

`WindowLayoutSurface` owns the horizontal safe-area insets, and on wide web layouts it also owns the top inset: it pads the status bar of an iOS Home Screen web app once and gives its content a top inset of 0. Native window chrome keeps its own top band. Content inside the surface that draws against the window instead of the padded content reads the window's insets; see Gotcha 7 in `docs/floating-panels.md`.

A new list+detail feature copies the settings shell. A new workspace-shaped feature copies the workspace shell. Inventing a third shape happens in design review, not in a PR.

---

## 10. Copy and voice

Sentence case. "Pair a device", "Danger zone", "Restart daemon", "Inject JAgentDesk tools", "No sessions yet", "Load more". Proper nouns retain casing — JAgentDesk, Beta, Stable, Local. Title case is wrong.

No trailing periods on row titles, labels, or buttons. No trailing period on a single-clause hint: "What happens when you press Enter while the agent is running". Periods exist inside multi-sentence prose: "Restarts the daemon process. The app will reconnect automatically."

Empty-state strings are short noun phrases or short sentences: "No projects yet", "Select a project", "No sessions yet" (`packages/app/src/screens/sessions-screen.tsx`), "Host not found".

Buttons are imperative: Save, Cancel, Restart, Remove, Update, Install update, Add host, Load more. In-flight labels are present-participle with a literal three-dot ellipsis: "Saving...", "Restarting...", "Removing...", "Loading...".

Error copy is direct. "Unable to remove host" (`packages/app/src/screens/settings/host-page.tsx`), not "Sorry, we couldn't remove the host." Recovery instructions are concrete: "Wait for it to come online before restarting." Errors describe state; they do not editorialize.

Terminology:

- Workspace, never "checkout".
- Host, except where the user-facing concept is the daemon process itself ("Restart daemon").
- Project, not "repo" or "repository".
- Provider, not "model provider".
- Session and agent are distinct: a session is a historical entry in `sessions-screen.tsx` (labelled History in the sidebar); an agent is a live entity in the workspace.

[glossary.md](glossary.md) is the authority on terms.

---

## 11. States

Loading is inline by default. `<LoadingSpinner size={14} color={foregroundMuted} />` sits next to the thing it relates to (`packages/app/src/screens/settings/providers-section.tsx`). Page-level loading is a centered `<LoadingSpinner size="large">` (`packages/app/src/screens/sessions-screen.tsx`). Card-level loading is a single short line, not a spinner. In-row dropdown items use `<DropdownMenuItem status="pending" pendingLabel="Removing...">`; the menu item handles its own pending state.

Empty states are short noun phrases. Centered, muted, one or two lines. A single ghost button next to the empty noun is the maximum elaboration. Illustrations and CTAs disguised as empty states are wrong.

Inline errors are a single sentence in `statusDanger` `xs` (`settingsStyles.rowError`), sitting under the field or inside the card it relates to. Older surfaces and `<Field>` still use `palette.red[300]`.

Page-level alerts — informational notices, success confirmations, warnings, or recoverable errors that need a small visible block on the page — use `<Alert>` (`packages/app/src/components/ui/alert.tsx`). Variants: `default`, `info`, `success`, `warning`, `error`. The chrome is quiet by design: a 1px tinted border, transparent background, a small variant-tinted icon, the title in the variant accent, the description in `foregroundMuted`. Actions go in the `children` slot as `<Button variant="outline" size="sm">` — recovery actions are low-frequency and outline keeps them quiet alongside the alert's accent (`packages/app/src/screens/project-settings-screen.tsx`). One `<Alert>` at a time per region.

Sidebar callouts — cross-cutting alerts that apply across the whole app, like worktree setup and Rosetta runtime warnings — register through `useSidebarCallouts()` and render through `<SidebarCalloutSlot>` in the classic left sidebar (`packages/app/src/components/left-sidebar.tsx`) via `<SidebarCallout>` (`packages/app/src/components/sidebar-callout.tsx`). The Gumloop sidebar does not mount the slot. The chrome (top-border-only, full-width action buttons) is tuned for a sidebar column. Canonical sources: `packages/app/src/components/worktree-setup-callout-source.tsx` and `packages/app/src/desktop/rosetta-callout-source.tsx`. Never import `<SidebarCallout>` into a page — that's what `<Alert>` is for.

Imperative errors are `Alert.alert("Error", "Unable to ...")` (the React Native `Alert` API, not this component) for failures that interrupt the flow and have no place on the page.

Disabled state is `opacity: theme.opacity[50]` on the outer pressable. Color changes for disabled state are wrong; a disabled button is the same button, dimmer.

Partial failure (a list mostly fine but one source errored) is a bordered banner above the list, listing each failure in red `xs` (`packages/app/src/screens/projects-screen.tsx`). The list still renders.

State surfaces at the smallest scope it affects. Field error stays under the field; page error is a banner; flow-stopping error is an `Alert`.

Changing state must not move the layout. A row that grows when its badge arrives, a card that reflows when a count resolves, a list that jumps as data streams in — all wrong. Reserve the space the loaded state will need, so the skeleton, the spinner, and the content occupy the same box. A surface that shifts under the user stops feeling calm.

---

## 12. List rows

The row anatomy is a content column with an optional trailing slot. Inside a card the row is `settingsStyles.row`. Inside a sidebar list the row carries its own padding and `borderRadius.lg` per item (`workspaceRow` in `packages/app/src/components/sidebar-workspace-list.tsx`).

Rows that drill into a detail lead with a chevron in the trailing slot (`ChevronRight`, `iconSize.sm`, `foregroundMuted`). The whole row is the `<Pressable>`. Pair-device row (`packages/app/src/screens/settings/host-page.tsx`), provider row (`packages/app/src/screens/settings/providers-section.tsx`), project row in the projects list. Chevron means navigation.

Kebab menus (`<DropdownMenu>` with `<MoreVertical size={14} />` trigger) are for actions on the row, not navigation. Trigger style: `padding: 2`, `borderRadius: 4`, hover background `surface2`. Menu position: `align="end"`. Items use `<DropdownMenuItem leading={<Icon size={14} color={foregroundMuted} />} ...>`. Visibility is `isHovered || isTouchPlatform` — hover-revealed on web, always visible on native (`packages/app/src/components/sidebar-workspace-list.tsx`). [hover.md](hover.md) owns the hover pattern.

A row may carry both a chevron and a kebab when both navigation and row-level actions apply. Chevron sits at the end; kebab sits before it.

Switches and segmented controls also sit in the trailing slot. A row that both navigates and toggles is a `<Pressable>` with a `<Switch>` in the trailing slot — the switch calls `event.stopPropagation()` so the row press does not fire (`packages/app/src/screens/settings/providers-section.tsx`). Sidebar items that hold a status dot, a count, and a kebab follow the same rule (`packages/app/src/components/sidebar-workspace-list.tsx`).

Selected state on sidebar rows uses `chrome.selectedRow` (`<GumloopRow>`, `sidebarRowSelected` in `sidebar-workspace-list.tsx`); hover uses `surfaceSidebarHover`. Selected state on rows in the agent list uses `surface2` (`rowSelected` in `packages/app/src/components/agent-list.tsx`).

---

## 13. Status pills and badges

The `<StatusBadge>` primitive (`packages/app/src/components/ui/status-badge.tsx`) is canonical and owns the colors. Variants: `success`, `error`, `muted`. On Gumloop it draws `statusSuccess` / `statusDanger` text on `statusSuccessBackground` / `statusDangerBackground` with a 4px radius; classic themes use a bordered full-radius pill.

Status dots — the small filled circles next to a host or agent name — are `borderRadius.full` filled with the status color (`statusSuccess`, `statusWarning`, `statusDanger`, or `foregroundMuted`). They sit in the trailing slot of a sidebar row or as a leading marker on a status pill.

Identity badges — the project icon and the sidebar host badge — do not use the theme palette. They draw from the fixed ten-color identity table in `packages/app/src/styles/identity-colors.ts`, whose hexes are held to one contrast band so a color identifies rather than ranks. Identity color is a fill-only contract: project icons use it as a fill with a white letter, while host badges use it on their icon and retain the normal muted text color. The table is theme-independent by design; do not fork it per theme, and do not add hexes to it without recomputing the band.

Bespoke pills in `host-page.tsx`, `agent-list.tsx`, and `sidebar-workspace-list.tsx` are drift to be removed. New code uses `<StatusBadge>`.

---

## 14. Forbidden

- `fontWeight.medium` on row titles, body text, button labels, badge text, or `<SidebarCallout>` titles. Medium is reserved for the structural-label tier described in §3 — section labels, modal/sheet titles, dense metadata emphasis, and tight action labels. Anything else is `normal` or the shell's `chrome` weight token. `<ScreenTitle>` weight comes from `chrome` and is never overridden.
- `<Pressable>` wrapping `<Text>` to make a button. `<Button>` exists.
- Bare `<Text>` for a section header inside settings. `<SettingsSection>` exists.
- A "Settings" CTA on a detail page. Detail pages are settings; settings is reached from the sidebar, the host entry, or a row's kebab menu.
- The word "checkout" in UI strings or identifiers. The term is "workspace".
- New color tokens or hardcoded hex outside the palette. The identity color table is the documented exception (§13), not a license.
- Branching on the theme inside `StyleSheet.create`. Read a `chrome` token; see [unistyles.md](unistyles.md#never-branch-on-theme-values-inside-stylesheetcreate-web).
- Placeholder text dimmed beyond `foregroundMuted`. No extra opacity, no italics, no ghost-text.
- Hover state on a `Pressable` that contains other pressables, or hover-only controls without a native path. Follow [hover.md](hover.md): track hover on a plain `View`, and show controls with `isHovered || isCompact || isNative`.
- Raw DOM APIs without an `isWeb` guard.
- Spacing values outside the scale. `padding: 20` and `gap: 10` are wrong.
- Color changes for disabled state. Opacity only.
- Destructive actions without `confirmDialog`. Restart, remove, and future destructive actions are confirmed. Archive workspace is confirmed only when its worktree backing reports uncommitted changes or unpushed commits; otherwise it archives immediately.
- Bespoke status pills. `<StatusBadge>` is the pill primitive.
- Raw `Modal` for a focused task. `<AdaptiveModalSheet>` is the modal primitive.
- Importing `ActivityIndicator` directly. `<LoadingSpinner>` is the loading primitive.

---

## 15. Canonical surfaces by pattern

| Pattern                                             | Reference                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App sidebar and drawer                              | `packages/app/src/components/gumloop-shell/sidebar.tsx`, `packages/app/src/components/gumloop-shell/drawer.tsx`; classic shell: `packages/app/src/components/left-sidebar.tsx` |
| Sidebar navigation row                              | `packages/app/src/components/gumloop-shell/row.tsx`                                                                                                                            |
| Full-screen page header                             | `packages/app/src/components/headers/page-header.tsx`                                                                                                                          |
| List+detail (compact stack, desktop sidebar+pane)   | `packages/app/src/screens/settings-screen.tsx`, `packages/app/src/screens/projects-screen.tsx`                                                                                 |
| Detail card+row                                     | `packages/app/src/screens/settings/host-page.tsx`, `packages/app/src/screens/settings/providers-section.tsx`                                                                   |
| Section grouping inside a card list                 | `packages/app/src/screens/settings/settings-section.tsx`                                                                                                                       |
| Form modal (label + input fields, primary + cancel) | `packages/app/src/components/add-host-modal.tsx`, `packages/app/src/components/pair-link-modal.tsx`                                                                            |
| Destructive confirmation                            | `confirmDialog` invoked from `packages/app/src/screens/settings/host-page.tsx`                                                                                                 |
| Centered hero / first-run                           | `packages/app/src/components/welcome-screen.tsx`                                                                                                                               |
| Sidebar workspace list                              | `packages/app/src/components/sidebar-workspace-list.tsx`                                                                                                                       |
| Live list of items with sections (agents)           | `packages/app/src/components/agent-list.tsx`                                                                                                                                   |
| Historical list (sessions)                          | `packages/app/src/screens/sessions-screen.tsx`                                                                                                                                 |
| Workspace pane (multi-tab, split)                   | `packages/app/src/screens/workspace/workspace-screen.tsx`                                                                                                                      |
| Composer / message input                            | `packages/app/src/composer/index.tsx`, `packages/app/src/composer/input/input.tsx`, gradient frame in `packages/app/src/components/gumloop-shell/composer-frame.tsx`           |
| Pane chrome with single bottom border               | `packages/app/src/git/diff-pane.tsx`, `packages/app/src/components/file-explorer-pane.tsx`, `packages/app/src/components/terminal-pane.tsx`                                    |
| Page-level alert (info / success / warning / error) | `packages/app/src/components/ui/alert.tsx`, `packages/app/src/screens/project-settings-screen.tsx`                                                                             |
| Sidebar callout (cross-cutting alert)               | `packages/app/src/components/sidebar-callout.tsx`, `packages/app/src/contexts/sidebar-callout-context.tsx`, `packages/app/src/components/worktree-setup-callout-source.tsx`    |
| Searchable picker                                   | `packages/app/src/components/ui/combobox.tsx`, `packages/app/src/components/branch-switcher.tsx`                                                                               |
| Trigger-anchored menu                               | `packages/app/src/components/ui/dropdown-menu.tsx` (used in `sidebar-workspace-list.tsx`, theme picker)                                                                        |
| Right-click / long-press menu                       | `packages/app/src/components/ui/context-menu.tsx` (used in `sidebar-workspace-list.tsx`)                                                                                       |
| Headers (back, screen, menu, compact)               | `packages/app/src/components/headers/back-header.tsx`, `screen-header.tsx`, `menu-header.tsx`; Gumloop compact: `packages/app/src/components/gumloop-shell/compact-header.tsx` |
