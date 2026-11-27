// JAgentDesk-only bots strings for the panels surfaces (spec 37), under `bots.jad.panels`.
export const botsJadPanelsStrings = {
  // Spec 37.4.2 "Workspace của worker trên điện thoại": the header button and its sheet.
  workspaceAgents: {
    button: "Workspace agents",
    title: "Workspace agents",
    subtitle: "Human → Supervisor → Lead → Peer",
  },
  chats: {
    // Spec 37.4.6: Orca's kinds plus GitLab and Telegram, and its empty line with JAgentDesk's sources.
    kindGitlab: "GitLab thread",
    kindTelegram: "Telegram chat",
    empty:
      "Side chats, Slack, GitHub, GitLab and Telegram threads and automation runs show up here, each with the workers it starts.",
  },
  connectors: {
    // Spec 37.4.7: Orca's GitHub line with "/{{folder}}" for "@mentioning it"; GitLab and Telegram are JAgentDesk's.
    githubLine:
      "Hand the bot work with /{{folder}} in a comment, and start automations on GitHub events.",
    gitlabLine:
      "Hand the bot work with /{{folder}} in a comment, and start automations on GitLab events.",
    telegramLine: "Chat with the bot from Telegram direct messages and groups.",
    emptyNote: "Let people reach {{name}} in Slack, GitHub, GitLab and Telegram.",
    updateHost: "Update the host to connect GitHub, GitLab and Telegram.",
    connected: "Connected",
    waiting: "Waiting for the first delivery",
    manual: "Make the hook by hand",
    rotateSecret: "Rotate secret",
    remove: "Remove",
    add: "Add",
    close: "Close",
    copySecret: "Copy secret",
    copied: "Copied",
    secretOnce: "The secret shows only here. Once you close this, it can't be read again.",
    payloadUrl: "Payload URL",
    contentType: "Content type",
    secret: "Secret",
    secretToken: "Secret token",
    events: "Events",
    openSettings: "Open hook settings",
    manualTitle: "Make the hook by hand",
    whoCanAsk: "Who can ask",
    removePerson: "Remove {{name}}",
    relayOffline: "Enable Relay in host Connections to use {{name}}",
    github: {
      signIn: "Sign in to GitHub with gh on {{host}} first.",
      target: "Repository or organization",
      targetPlaceholder: "owner/repo or org:name",
      addUser: "Add GitHub user",
      userPlaceholder: "GitHub login",
    },
    gitlab: {
      signIn: "Sign in to GitLab with glab on {{host}} first.",
      host: "GitLab host",
      target: "Project or group",
      targetPlaceholder: "group/project or group",
      addUser: "Add GitLab user",
      userPlaceholder: "GitLab username",
    },
    telegram: {
      steps: "Open @BotFather in Telegram, send /newbot, then paste the token it gives you.",
      token: "Bot token",
      connect: "Connect",
      connected: "Connected · @{{username}}",
      groupsHint:
        "To use it in groups, add @{{username}} to the group. It answers when mentioned or replied to.",
      linkAccount: "Link my Telegram account",
      openInTelegram: "Open in Telegram",
      sendCode: "Or send this code to @{{username}}:",
      copyCode: "Copy code",
      expiresAt: "Expires at {{time}}",
      linked: "Linked · {{name}}",
      allowed: "Allowed Telegram users",
      noUsers: "No allowed users",
      disconnect: "Disconnect",
    },
  },
  notes: {
    // Spec 37.2.6: the result lines of a Look around / Tidy memory run.
    lookedAround_one: "Looked around · {{count}} suggestion",
    lookedAround_other: "Looked around · {{count}} suggestions",
    tidied_one: "Tidied memory · {{count}} change",
    tidied_other: "Tidied memory · {{count}} changes",
    lookFailed: "Look around failed",
    tidyFailed: "Tidy memory failed",
  },
  approval: {
    // Orca `components.native-chat.approval.*` and `workerDock.notNow`.
    worker: "Worker · {{name}}",
    openWorker: "Open worker",
    notNow: "Not now",
    // The bot's own cards (spec 37.3.2-37.3.3). Orca's card for a start is the command it ran,
    // naming the item, the project (`--repo`), a new worktree and the task (`--spec`).
    workerStart: {
      title: "Start a worker for {{item}}?",
      description:
        "{{bot}} starts a worker in a new worktree of {{project}} ({{path}}). The worker reports back when it is done.",
      task: "Task",
    },
    handoff: {
      title: {
        handoff: "Hand this to {{to}}?",
        question: "Ask {{to}}?",
        status: "Send {{to}} a status?",
      },
      description: "{{bot}} sends {{to}} this message.",
      message: "Message",
    },
  },
} as const;
