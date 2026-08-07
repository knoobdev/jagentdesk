## ADDED Requirements

### Requirement: CLI exposes the agent and daemon command surface
The CLI MUST expose top-level agent operations including `ls`, `run`, `import`, `attach`, `logs`, `stop`, `delete`, `send`, `inspect`, `wait`, and `archive`, plus daemon onboarding/start/status/restart and the advanced `agent` and `daemon` command groups (`scratchpad/reference/packages/cli/src/cli.ts:49-61,63-127,163-168`).

#### Scenario: Agent run is available in structured output mode
- **GIVEN** the user invokes the CLI with the run command and daemon-host options
- **WHEN** the command parser builds the CLI
- **THEN** the run command is registered through `withOutput` and accepts the global JSON output options (`scratchpad/reference/packages/cli/src/cli.ts:52-68`)

### Requirement: CLI exposes automation, speech, workspace, and permission commands
The CLI MUST register chat, terminal, script, loop, schedule, heartbeat, permit, provider, speech, workspace, and hidden legacy worktree command groups (`scratchpad/reference/packages/cli/src/cli.ts:170-199`).

#### Scenario: Automation commands are discoverable
- **GIVEN** the user requests CLI help
- **WHEN** command registration completes
- **THEN** `loop`, `schedule`, and `heartbeat` are present as command groups and the hidden legacy worktree group is not part of the public surface (`scratchpad/reference/packages/cli/src/cli.ts:179-199`)

### Requirement: CLI provides table, JSON, YAML, quiet, header, and color controls
The CLI MUST accept `table`, `json`, and `yaml` output formats, map `--json` to JSON, support quiet/no-headers/no-color flags, write successful output to stdout, and render command errors to stderr with exit code 1 (`scratchpad/reference/packages/cli/src/cli.ts:52-61`; `scratchpad/reference/packages/cli/src/output/with-output.ts:20-33,50-55,77-99`).

#### Scenario: Unsupported output format fails
- **GIVEN** the user passes an output format other than `table`, `json`, or `yaml`
- **WHEN** the command wrapper normalizes the format
- **THEN** it raises `INVALID_FORMAT` and reports the supported formats (`scratchpad/reference/packages/cli/src/output/with-output.ts:20-33`)

#### Scenario: Command error uses stderr
- **GIVEN** a wrapped command handler throws
- **WHEN** `withOutput` handles the error
- **THEN** it renders the error to stderr and calls `process.exit(1)` (`scratchpad/reference/packages/cli/src/output/with-output.ts:87-99`)

### Requirement: CLI resolves workspace context safely
The CLI MUST classify invocations using the current working directory, recognize an open-project invocation separately, and treat a candidate path as in-scope only when it is the base directory or a descendant after separator normalization (`scratchpad/reference/packages/cli/src/run.ts:10-35`; `scratchpad/reference/packages/cli/src/utils/paths.ts:5-25`).

#### Scenario: Descendant workspace is accepted
- **GIVEN** base path `/work/repo` and candidate `/work/repo/src`
- **WHEN** the CLI checks the candidate
- **THEN** it returns true (`scratchpad/reference/packages/cli/src/utils/paths.ts:12-25`)

#### Scenario: Sibling path is rejected
- **GIVEN** base path `/work/repo` and candidate `/work/repository`
- **WHEN** the CLI checks the candidate
- **THEN** it returns false because the candidate does not start with the base plus `/` (`scratchpad/reference/packages/cli/src/utils/paths.ts:23-25`)

### Requirement: JAgentDesk CLI uses Tailscale hosts and has no relay control path
JAgentDesk MUST retain daemon-host targeting and pairing commands, but MUST remove JAgentDesk's `--relay` and `--no-relay` controls and MUST direct remote operations to the paired daemon's Tailscale endpoint; application pairing and connection signing remain mandatory before control operations. The removed flags are visible in JAgentDesk's daemon restart surface (`scratchpad/reference/packages/cli/src/cli.ts:129-149`; `scratchpad/reference/packages/cli/src/commands/daemon/index.ts:34-53`).

#### Scenario: Relay flags are rejected
- **GIVEN** a user invokes a JAgentDesk daemon restart with `--relay` or `--no-relay`
- **WHEN** the CLI parses arguments
- **THEN** parsing fails because neither option is registered, and no relay connection is attempted

#### Scenario: Remote control requires the paired Tailscale target
- **GIVEN** a remote daemon host is specified but the device has not completed application pairing/signing
- **WHEN** the CLI sends a control RPC
- **THEN** the operation is rejected before daemon control is granted

