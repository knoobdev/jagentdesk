## ADDED Requirements

### Requirement: Workspace sources and isolation
JAgentDesk MUST create a workspace from either an existing directory checkout or a newly created git worktree. A worktree workspace MUST retain its source repository, worktree root, current branch, base branch, and workspace identity so that agents, terminals, git status, and archive operations address the same workspace.

#### Scenario: Create directory-backed workspace
- **GIVEN** a client sends `workspace.create.request` with `source.kind` equal to `directory` and an absolute `source.path` (`scratchpad/reference/packages/protocol/src/messages.ts:2106-2138`)
- **WHEN** the daemon provisions the workspace
- **THEN** it records the normalized checkout path and project relationship, and returns a workspace record with a distinct `workspaceId` (`scratchpad/reference/packages/server/src/server/session/workspace-provisioning/workspace-provisioning-service.ts:185-207`)

#### Scenario: Create worktree-backed workspace
- **GIVEN** a client sends `workspace.create.request` with `source.kind` equal to `worktree` and a valid repository source (`scratchpad/reference/packages/protocol/src/messages.ts:2120-2137`)
- **WHEN** worktree creation succeeds
- **THEN** the daemon persists the created worktree path, repository root, branch, base branch, and a new workspace record (`scratchpad/reference/packages/server/src/server/session/workspace-provisioning/workspace-provisioning-service.ts:210-241`)

### Requirement: Worktree source modes
The daemon MUST support worktree creation by branching off a base branch, checking out an existing local or fetched branch, and checking out a change request using the source plan semantics from JAgentDesk. It MUST reject an invalid branch, an unknown branch, or a branch already checked out (`scratchpad/reference/packages/server/src/utils/worktree.ts:1318-1422`).

#### Scenario: Branch off
- **GIVEN** the source mode is `branch-off`, a base branch can be resolved, and the requested branch name is valid (`scratchpad/reference/packages/server/src/utils/worktree.ts:1323-1338`)
- **WHEN** the daemon creates the worktree
- **THEN** it creates a unique local branch from the resolved base using `git worktree add -b`, and stores the normalized base reference

#### Scenario: Existing branch unavailable
- **GIVEN** the source mode is `checkout-branch` and the branch is neither local nor fetchable from `origin` (`scratchpad/reference/packages/server/src/utils/worktree.ts:1340-1350`)
- **WHEN** the daemon resolves the source plan
- **THEN** it returns an unknown-branch failure and does not create a worktree

### Requirement: Deterministic worktree placement and ownership
Worktrees MUST be placed below the configured worktree root, grouped by an 8-character base-36 project hash, and addressed by a caller-selected slug. The default root MUST be `$JAGENTDESK_HOME/worktrees` in JAgentDesk, preserving JAgentDesk's layout semantics. A requested path collision MUST receive a numeric suffix rather than overwrite an existing directory (`scratchpad/reference/packages/server/src/utils/worktree.ts:817-871,1230-1255`; `scratchpad/reference/public-docs/worktrees.md:17-26`).

#### Scenario: Stable project grouping
- **GIVEN** two worktree requests use the same repository root and the same configured worktree root (`scratchpad/reference/packages/server/src/utils/worktree.ts:828-861`)
- **WHEN** the daemon computes their placement
- **THEN** both paths share the same 8-character project directory and differ only by slug or collision suffix

#### Scenario: Collision is non-destructive
- **GIVEN** the requested `<slug>` path already exists (`scratchpad/reference/packages/server/src/utils/worktree.ts:1239-1247`)
- **WHEN** the daemon allocates the worktree path
- **THEN** it tries `<slug>-1`, then increasing numeric suffixes until the selected path does not exist, without replacing the existing path

### Requirement: Git snapshot and checkout observation
The daemon MUST expose a normalized checkout snapshot containing git/non-git state, repository roots, current branch, remote URL, worktree ownership, dirty state, base reference, ahead/behind counts, remote presence, diff statistics, and forge pull-request state when available (`scratchpad/reference/packages/server/src/server/workspace-git-service.ts:71-123`). Workspace registration MUST trigger an initial refresh and subsequent snapshot notifications; explicit refresh MUST refresh structure and worktree state (`scratchpad/reference/packages/server/src/server/workspace-git-service.ts:458-477,744-755`).

#### Scenario: Non-git directory
- **GIVEN** a workspace path is not inside a git repository (`scratchpad/reference/packages/server/src/server/workspace-git-service.ts:2150-2161`)
- **WHEN** the daemon calculates its snapshot
- **THEN** it returns `git.isGit: false`, null git roots/branch/remote, and an unavailable forge snapshot rather than guessing repository metadata

#### Scenario: Checkout refresh notification
- **GIVEN** a client subscribes to checkout state for a workspace (`scratchpad/reference/packages/protocol/src/messages.ts:1680-1697`)
- **WHEN** the daemon detects a status or diff change
- **THEN** it emits `checkout_status_update` and, for a diff subscription, `checkout_diff_update` carrying the subscription identity (`scratchpad/reference/packages/protocol/src/messages.ts:4241-4271`)

### Requirement: Git operations and forge surface
The daemon MUST support the checkout status, refresh, branch validation/switch/rename, commit, merge, pull, push, stash, commit listing, per-commit file diff, forge change-request creation/merge/status, check details, and forge search requests defined by the protocol (`scratchpad/reference/packages/protocol/src/messages.ts:1680-1908,1942-1948`). Operations that mutate git state MUST remain explicit RPCs; viewing status and diff MUST be available independently of mutation.

#### Scenario: Read checkout diff
- **GIVEN** a client sends `subscribe_checkout_diff_request` with `mode` `uncommitted` or `base` (`scratchpad/reference/packages/protocol/src/messages.ts:1674-1692`)
- **WHEN** the daemon computes the result
- **THEN** it returns `subscribe_checkout_diff_response` with `files`, nullable typed `error`, and `subscriptionId`, and later streams updates with the same subscription identity (`scratchpad/reference/packages/protocol/src/messages.ts:4252-4271`)

#### Scenario: Correlated git mutation
- **GIVEN** a client sends a supported mutation such as `checkout_commit_request` with a non-empty `requestId` (`scratchpad/reference/packages/protocol/src/messages.ts:1699-1705`)
- **WHEN** the daemon completes or rejects the operation
- **THEN** it returns a response containing the same `requestId`, a boolean success result, and a typed checkout error when unsuccessful (`scratchpad/reference/packages/protocol/src/messages.ts:4273-4281`)

### Requirement: Bounded and read-only diff computation
Diff generation MUST use read-only git environment settings, cap tracked numstat output at 2 MiB, cap each textual file diff at 1 MiB, cap aggregate textual diff output at 2 MiB, and represent binary or per-file oversized content with `binary` or `too_large` placeholders. When the structured result cannot fit its configured transport budget, the daemon MUST return `diffTooLarge` rather than a partial structured result (`scratchpad/reference/packages/server/src/utils/checkout-git.ts:637-663,1939-1970,2841-2877,2939-2972,3001-3122`).

#### Scenario: Oversized file is represented
- **GIVEN** a changed file exceeds the 1 MiB per-file diff limit or is binary (`scratchpad/reference/packages/server/src/utils/checkout-git.ts:1941-1944,2006-2037`)
- **WHEN** the daemon builds the diff
- **THEN** the textual patch for that file is omitted and the structured file status is `too_large` or `binary`, with a corresponding omission marker in the plain diff (`scratchpad/reference/packages/server/src/utils/checkout-git.ts:2841-2877`)

#### Scenario: In-app file editing is unavailable
- **GIVEN** a client attempts the JAgentDesk `fs.file.write.request` operation (`scratchpad/reference/packages/protocol/src/messages.ts:2246-2254`)
- **WHEN** the request reaches JAgentDesk
- **THEN** the daemon rejects or does not route the write operation; JAgentDesk exposes file and diff viewing only, and no in-app editor write path is part of this capability

### Requirement: Safe worktree archive
Archiving MUST identify the requested workspace or all active workspace records sharing a requested worktree according to the archive scope, archive associated agents and terminals before removing records, and remove a backing directory only when it is JAgentDesk-owned and no active workspace still references it (`scratchpad/reference/packages/server/src/server/workspace-archive-service.ts:100-175,177-226`). Worktree removal MUST refuse paths outside the owned worktree root, run teardown commands, use `git worktree remove --force` with a 120000 ms timeout, retry directory removal, and attempt `git worktree prune` with a 30000 ms timeout (`scratchpad/reference/packages/server/src/utils/worktree.ts:1089-1162`).

#### Scenario: Archive one workspace with shared backing directory
- **GIVEN** a worktree directory is referenced by more than one active workspace and the archive scope is `workspace` (`scratchpad/reference/packages/server/src/server/workspace-archive-service.ts:177-226`)
- **WHEN** one workspace is archived
- **THEN** only that workspace's records are archived and the backing directory remains because another active workspace still references it

#### Scenario: Refuse unowned deletion
- **GIVEN** the requested archive path is outside the configured owned worktree root (`scratchpad/reference/packages/server/src/utils/worktree.ts:1114-1129`)
- **WHEN** deletion is requested
- **THEN** the daemon fails with a non-JAgentDesk-owned-worktree error and does not remove the directory
