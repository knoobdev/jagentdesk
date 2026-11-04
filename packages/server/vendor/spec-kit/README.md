# Vendored GitHub Spec Kit (JAgentDesk)

Spec mode (spec `28-spec-mode`, ADR-0030) writes these files into a workspace the
same way `specify init` does. The TypeScript port of `process_template` and of the
`specify init` file layout lives in `src/server/spec-mode/speckit/`. Nothing here is
executed by the daemon; the agent runs the scripts inside the user's workspace.

## Pinned upstream

| Field | Value |
|---|---|
| Project | Spec Kit, https://github.com/github/spec-kit (MIT, see `LICENSE`) |
| Version | 1.3.0 (`specify-cli==1.3.0` on PyPI) |
| Upstream tag | `v1.3.0` |
| Upstream commit | `34a0d388eac671d656eb05b125ad3ed6056168ed` |
| Source | `specify_cli/core_pack/` of the 1.3.0 wheel (identical to the tag's `templates/`, `scripts/`, `workflows/speckit/`) |

Upgrading is a reviewed change: re-copy the files listed below from the new wheel,
update this table and `SPECKIT_VERSION` / the file orders in
`src/server/spec-mode/speckit/vendor.ts`, regenerate the fixtures with
`scripts/capture-speckit-fixtures.mjs` and run
`npx vitest run src/server/spec-mode` in `packages/server`.

## What is included

Copied byte-for-byte, no patches:

- `templates/commands/*.md`: the nine core command templates.
- `templates/{checklist,constitution,plan,spec,tasks}-template.md`: page templates.
- `scripts/bash/*.sh` and `scripts/powershell/*.ps1`: helper scripts (`sh` and `ps` variants).
- `workflows/speckit/workflow.yml`: copied into `.specify/workflows/` like `specify init` does.
- `LICENSE`: upstream MIT license, unchanged.

Not included: the `specify` CLI, the `py` script variant, extensions (`git`,
`agent-context`, …), presets, bundles and the `vscode-settings.json` template
(`specify init` does not copy it into `.specify/` either).
