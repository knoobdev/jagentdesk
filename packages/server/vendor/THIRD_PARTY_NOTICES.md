# Third-party software bundled with the JAgentDesk daemon

Copied into `dist/server/vendor/` by `npm run build:lib`. Each directory keeps the
upstream license file unchanged.

| Directory | Project | Version | License |
|---|---|---|---|
| `archify-3.2.0/` | archify, https://github.com/tt-a1i/archify | 3.2.0 | MIT (`archify-3.2.0/LICENSE`, notices in `archify-3.2.0/THIRD_PARTY_NOTICES.md`) |
| `spec-kit/` | GitHub Spec Kit, https://github.com/github/spec-kit | 1.3.0 | MIT, Copyright GitHub, Inc. (`spec-kit/LICENSE`) |
| `figma-link-plugin/` | JAgentDesk Figma Link plugin, renamed from @gethopp/figma-mcp-forge's plugin, https://github.com/gethopp/figma-mcp-forge | 1.0.0 | MIT, Copyright (c) 2026 GETHOPP LTD (`figma-link-plugin/LICENSE.md`, notices in `figma-link-plugin/THIRD_PARTY_NOTICES.md`) |

Bots local workflow adaptations derive from Orca `dfdb4fda` (MIT, Copyright (c) 2026 Lovecast Inc.); see `orca-bots/LICENSE`. No Orca cloud connector or orchestration runtime is bundled.
