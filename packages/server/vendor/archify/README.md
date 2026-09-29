# Vendored archify (JAgentDesk)

Renders Team-mode diagrams for `forum.set_diagram` with `format: "archify"`
(spec `23-team-arch-diagrams`, ADR-0021). Called only through
`src/server/agent-forum/archify-renderer.ts`, which runs one renderer script per
render as a child process of the daemon's own runtime.

## Pinned upstream

| Field | Value |
|---|---|
| Project | archify, https://github.com/tt-a1i/archify (MIT, see `LICENSE`) |
| Version | 3.0.1 |
| Upstream tag | `v3.0.1` |
| Upstream commit | `2ab3cae7ac2c2a55d7386ca789d03c4fcd31816c` |
| Source directory | `archify/` of that commit |

Upgrading is a reviewed change: re-copy the files listed below from a new tag,
re-apply the patches, update this table and run
`npx vitest run src/server/agent-forum` in `packages/server`.

## What is included

Only what rendering and validation need, copied byte-for-byte unless listed
under "Patches":

- `renderers/**`: the five renderers (`render-<type>.mjs`) and the shared
  modules they import, including the prebuilt schema validators
  (`renderers/shared/generated-validators.mjs`).
- `assets/template.html`: the built viewer (SVG host, viewer JS/CSS,
  embedded JetBrains Mono subsets). `assets/JetBrainsMono-OFL.txt`: font license.
- `schemas/*.schema.json`: the JSON Schemas the validators were generated from
  (reference for agents and reviewers; not read at runtime).
- `LICENSE` (upstream MIT, unchanged) and `THIRD_PARTY_NOTICES.md` (adjusted).

Not included: the `archify` CLI (`bin/`), which adds delivery, preview server,
brand capture and the update check; `scripts/` (including `check-update.mjs`);
the viewer sources (`template.html` is their generated artifact); examples,
references, tests and the brand-mark catalog.

## Patches

1. **Brand marks removed.** `renderers/shared/generated-brand-marks.mjs` (logo
   path data from Simple Icons and the OpenAI mark, several under their own
   licenses) is deleted. `renderers/shared/brand-marks.mjs` is replaced by a
   JAgentDesk stub with the same exports: no mark is ever rendered, and a
   diagram with a `brand` field is rejected with a `brand/unsupported`
   diagnostic. The stub has no HTTP/DNS code, so upstream's site-icon capture
   cannot run.
2. **No update check.** The only update check upstream lives in the CLI and
   `scripts/check-update.mjs`, neither of which is vendored; the daemon also
   sets `ARCHIFY_UPDATE_CHECK_DISABLED=1` for every render.

## Runtime contract

- Environment per render: `ARCHIFY_DIAGNOSTIC_FORMAT=json`,
  `ARCHIFY_UPDATE_CHECK_DISABLED=1`; `ARCHIFY_REPO_ROOT` and
  `ARCHIFY_QUALITY_PROFILE` are removed, so repository evidence (which would
  run `git`) always fails validation instead of reading host files.
- `meta.output` is overwritten by the daemon; the output path is a temporary
  directory, then the HTML is stored at
  `$JAGENTDESK_HOME/forums/<topicId>/diagrams/<diagramId>.html`.
- Packaging: `npm run build:lib` copies this directory to
  `dist/server/vendor/archify`; the desktop app unpacks it from `app.asar`
  (`packages/desktop/electron-builder.yml`, `asarUnpack`).
