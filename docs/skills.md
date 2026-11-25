# Skills

Skills are standard Agent Skills folders (`<name>/SKILL.md` with `name` and `description` front
matter). JAgentDesk does not inject skill text into prompts: it installs skills where each
provider CLI already looks and asks the provider to load them.

Code: `packages/protocol/src/native-skills.ts` (schemas, invocation), the `skills` built-in
feature in `plugins/skills/` (daemon service, RPCs, tools, screen, composer control; file names
below without a path are in `plugins/skills/server/`), and the
provider directory table `packages/server/src/server/agent/native-skill-paths.ts`, which stays in
core because Spec mode installs its commands there too. Turn the feature off per host in Settings → host → Plugins.

## Where skills live

The daemon scans these directories, globally (below `~`) and per project (below the project root),
and reports which providers can see each skill (`SKILL_DIR_SPECS` in `native-skill-paths.ts`).

| Directory (global / project)                   | Read by                                         |
| ---------------------------------------------- | ----------------------------------------------- |
| `.agents/skills`                               | Codex, OpenCode, Cursor, Copilot, Pi, OMP, Kimi |
| `.claude/skills`                               | Claude, OpenCode, Cursor, Kimi, OMP             |
| `.gemini/config/skills` (global only)          | Antigravity                                     |
| `.kiro/skills`                                 | Kiro                                            |
| `.codex/skills`                                | Codex                                           |
| `.config/opencode/skills` / `.opencode/skills` | OpenCode                                        |
| `.copilot/skills` / `.github/skills`           | Copilot                                         |
| `.cursor/skills`                               | Cursor                                          |
| `.pi/agent/skills` / `.pi/skills`              | Pi                                              |
| `.omp/agent/skills` / `.omp/skills`            | Oh My Pi                                        |
| `.kimi/skills`                                 | Kimi                                            |

Copies found through different directories are deduplicated by real path. Copies of the same
skill name with separate files are grouped into one family; `contentHash` decides whether the
copies differ.

## Install and uninstall

An install writes one real copy to `.agents/skills/<name>` and symlinks it into
`.claude/skills` and `.kiro/skills`. Global installs also link into
`~/.gemini/config/skills` for Antigravity. New provider paths use optional catalog fields so
older clients can still read installed skills. Every path written is recorded in
`$JAGENTDESK_HOME/skills/lock.json`; uninstall removes exactly those paths. A skill directory that
JAgentDesk did not write is never overwritten. Disabling a skill JAgentDesk does not own moves it
aside and can be undone.

Older JSON skills are migrated to owned SKILL.md folders on first start (`migration.ts`).

## Sources

The marketplace is built from `$JAGENTDESK_HOME/skills/sources.json`. When the file is missing,
the bundled JAgentDesk orchestration skills and official `anthropics/skills` and `openai/skills`
repositories are offered. The bundled source is local to the packaged daemon; browsing it does
not install anything. Install or remove it through the same native skills actions as other
sources. A source is one of:

- `github` — `owner/repo`, optionally a branch and sub-folder (`/tree/<ref>/<path>` links work);
- `npm` — a package that contains skill folders;
- `index` — an `https://` URL returning a JSON skill index;
- `local` — a folder on the daemon host.

Listing reads only the Git tree and each skill's front matter (`remote-listing.ts`,
`github-tree.ts`); installing downloads only the chosen skill's files. Each source is cached and
refreshed in the background, and sources are fetched in parallel. Claude and Codex plugin
marketplaces already added on the host are listed through the provider CLI
(`provider-marketplace.ts`).

### Directories

An `index` source whose host has an adapter is a searchable directory; today that is
`https://skillsmp.com` (`directory-hosts.ts`, `directory-sources.ts`). A directory is never listed:
a merged browse skips it, and `skills.sources.browse { sourceId, query, page }` sends one
`/api/v1/skills/search` request per page (20 results, cached 10 minutes). Results are
`metadataOnly` items whose source is the skill's GitHub folder (`{ kind: "url" }`), so opening one
lists that folder and installing it uses the GitHub path above. An optional API key
(`skills.sources.set_api_key`) is stored in `$JAGENTDESK_HOME/skills/credentials.json` (mode 0600)
and only sent to the directory; apps see `hasApiKey` and the daily quota from the
`X-RateLimit-Daily-*` headers. An https URL that returns HTML without an adapter is rejected.

## Invocation

A send that carries `skillIds` is rewritten for the agent's provider (`buildSkillInvocationLine`):

| Provider                      | First skill   | Other skills                                                              |
| ----------------------------- | ------------- | ------------------------------------------------------------------------- |
| Claude, Cursor, Copilot, Kiro | `/name`       | "Before you answer, load these skills: …" (Claude: "with the Skill tool") |
| Codex                         | `$name`       | `$other` on the same line                                                 |
| Pi, Oh My Pi, Kimi            | `/skill:name` | "Before you answer, load these skills: …"                                 |
| OpenCode, generic ACP         | —             | one sentence for all skills: "Before you answer, load these skills: …"    |

Only the first skill can be a leading command: Claude treats a second `/cmd` as arguments. The
same rewrite applies to `send_agent_prompt` and `jagentdesk agent send --skill`.

## Training

Approving a lesson writes it into a lessons section of the skill's `SKILL.md`. Training a skill
JAgentDesk does not own first forks it into an owned copy.
