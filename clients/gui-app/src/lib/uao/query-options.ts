import { queryOptions, skipToken } from "@tanstack/react-query";
import {
  fetchKanbanBoards,
  fetchKanbanTask,
  fetchKanbanTasks,
} from "@/lib/uao/adapter";
import {
  fetchWorkspaceRepos,
  fetchWorkspaceStatus,
  fetchWorkspaceTerminals,
  fetchWorkspaceWorktrees,
  readWorkspaceTerminalScreen,
} from "@/lib/uao/workspaces-adapter";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";

export interface UaoDesktopConfig {
  /** True when the desktop is paired with a server whose Workspace it can drive. */
  readonly workspacesServer: boolean;
}

export const uaoQueryOptions = {
  config: () =>
    queryOptions({
      queryKey: uaoQueryKeys.config(),
      queryFn: async ({ signal }): Promise<UaoDesktopConfig> => {
        const response = await fetch("/desktop/uao-config.json", {
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          cache: "no-store",
        });
        if (!response.ok) return { workspacesServer: false };
        const body = (await response.json()) as { workspacesServer?: unknown };
        return { workspacesServer: body.workspacesServer === true };
      },
      retry: false,
      staleTime: Infinity,
    }),
  builtUi: () =>
    queryOptions({
      queryKey: uaoQueryKeys.builtUi(),
      queryFn: async ({ signal }) => {
        const response = await fetch("/uao-api/", {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          headers: { Accept: "text/html" },
          cache: "no-store",
        });
        if (!response.ok)
          throw new Error(`UAO UI returned HTTP ${response.status}`);
        const html = await response.text();
        if (
          !response.headers.get("content-type")?.includes("text/html") ||
          !html.includes('id="root"') ||
          !html.includes("/assets/")
        ) {
          throw new Error(
            "UAO backend is reachable but its built UI is missing.",
          );
        }
        return true;
      },
      retry: false,
      staleTime: 30000,
    }),
  boards: () =>
    queryOptions({
      queryKey: uaoQueryKeys.boards(),
      queryFn: ({ signal }) => fetchKanbanBoards(signal),
    }),
  tasks: (board: string | undefined) =>
    queryOptions({
      queryKey: uaoQueryKeys.tasks(board),
      queryFn: ({ signal }) =>
        fetchKanbanTasks(
          board === undefined
            ? undefined
            : { board, status: undefined, assignee: undefined },
          signal,
        ),
    }),
  task: (board: string | undefined, taskId: string | null) =>
    queryOptions({
      queryKey: uaoQueryKeys.task(board, taskId),
      queryFn:
        taskId === null
          ? skipToken
          : ({ signal }) => fetchKanbanTask(taskId, board, signal),
    }),
  workspaceStatus: () =>
    queryOptions({
      queryKey: uaoQueryKeys.workspaceStatus(),
      queryFn: ({ signal }) => fetchWorkspaceStatus(signal),
      refetchInterval: 5000,
      refetchIntervalInBackground: false,
      staleTime: 2000,
    }),
  workspaceRepos: (enabled: boolean) =>
    queryOptions({
      queryKey: uaoQueryKeys.workspaceRepos(),
      queryFn: enabled
        ? ({ signal }) => fetchWorkspaceRepos(signal)
        : skipToken,
      staleTime: 10000,
    }),
  workspaceWorktrees: (enabled: boolean) =>
    queryOptions({
      queryKey: uaoQueryKeys.workspaceWorktrees(),
      queryFn: enabled
        ? ({ signal }) => fetchWorkspaceWorktrees(signal)
        : skipToken,
      refetchInterval: enabled ? 4000 : false,
      refetchIntervalInBackground: false,
      staleTime: 2000,
    }),
  workspaceTerminals: (worktreeId: string | null) =>
    queryOptions({
      queryKey: uaoQueryKeys.workspaceTerminals(worktreeId),
      queryFn:
        worktreeId === null
          ? skipToken
          : ({ signal }) =>
              fetchWorkspaceTerminals(
                worktreeId.startsWith("id:") ? worktreeId : `id:${worktreeId}`,
                signal,
              ),
      refetchInterval: worktreeId !== null ? 3000 : false,
      refetchIntervalInBackground: false,
      staleTime: 1500,
    }),
  workspaceTerminalScreen: (
    terminalHandle: string | null,
    enabled: boolean,
  ) =>
    queryOptions({
      queryKey: uaoQueryKeys.workspaceTerminalScreen(terminalHandle),
      queryFn:
        terminalHandle === null || !enabled
          ? skipToken
          : ({ signal }) =>
              readWorkspaceTerminalScreen(terminalHandle, 300, signal),
      refetchInterval: terminalHandle !== null && enabled ? 2000 : false,
      refetchIntervalInBackground: false,
      staleTime: 1000,
    }),
};
