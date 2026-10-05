export const uaoQueryKeys = {
  office: () => ["uao", "office"] as const,
  officeAction: () => ["uao", "office", "action"] as const,
  config: () => ["uao", "config"] as const,
  builtUi: () => ["uao", "built-ui"] as const,
  boards: () => ["uao", "boards"] as const,
  tasks: (board: string | undefined) => ["uao", "tasks", board] as const,
  task: (board: string | undefined, taskId: string | null) =>
    ["uao", "task", board, taskId] as const,
  orcaStatus: () => ["uao", "orca", "status"] as const,
  orcaRepos: () => ["uao", "orca", "repos"] as const,
  orcaWorktrees: () => ["uao", "orca", "worktrees"] as const,
  orcaTerminals: (worktreeId: string | null) =>
    ["uao", "orca", "terminals", worktreeId] as const,
  orcaTerminalScreen: (terminalHandle: string | null) =>
    ["uao", "orca", "screen", terminalHandle] as const,
  orcaTerminalSendMutation: () =>
    ["uao", "orca", "terminal", "send"] as const,
  orcaTerminalCreateMutation: () =>
    ["uao", "orca", "terminal", "create"] as const,
  orcaOpenMutation: () =>
    ["uao", "orca", "open"] as const,
};
