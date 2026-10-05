export const uaoQueryKeys = {
  workspace: () => ["uao", "workspace"] as const,
  office: () => ["uao", "office"] as const,
  officeAction: () => ["uao", "office", "action"] as const,
  config: () => ["uao", "config"] as const,
  builtUi: () => ["uao", "built-ui"] as const,
  boards: () => ["uao", "boards"] as const,
  tasks: (board: string | undefined) => ["uao", "tasks", board] as const,
  task: (board: string | undefined, taskId: string | null) =>
    ["uao", "task", board, taskId] as const,
  workspaceStatus: () => [...uaoQueryKeys.workspace(), "status"] as const,
  workspaceRepos: () => [...uaoQueryKeys.workspace(), "repos"] as const,
  workspaceWorktrees: () => [...uaoQueryKeys.workspace(), "worktrees"] as const,
  workspaceTerminals: (worktreeId: string | null) =>
    [...uaoQueryKeys.workspace(), "terminals", worktreeId] as const,
  workspaceTerminalScreen: (terminalHandle: string | null) =>
    [...uaoQueryKeys.workspace(), "screen", terminalHandle] as const,
  workspaceTerminalSendMutation: () =>
    [...uaoQueryKeys.workspace(), "terminal", "send"] as const,
  workspaceTerminalCreateMutation: () =>
    [...uaoQueryKeys.workspace(), "terminal", "create"] as const,
  workspaceOpenMutation: () =>
    [...uaoQueryKeys.workspace(), "open"] as const,
};
