export const uaoQueryKeys = {
  builtUi: () => ["uao", "built-ui"] as const,
  boards: () => ["uao", "boards"] as const,
  tasks: (board: string | undefined) => ["uao", "tasks", board] as const,
  task: (board: string | undefined, taskId: string | null) =>
    ["uao", "task", board, taskId] as const,
};
