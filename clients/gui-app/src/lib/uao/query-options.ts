import { queryOptions, skipToken } from "@tanstack/react-query";
import {
  fetchKanbanBoards,
  fetchKanbanTask,
  fetchKanbanTasks,
} from "@/lib/uao/adapter";
import {
  fetchOrcaRepos,
  fetchOrcaStatus,
  fetchOrcaTerminals,
  fetchOrcaWorktrees,
  readOrcaTerminalScreen,
} from "@/lib/uao/orca-adapter";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";

export const uaoQueryOptions = {
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
  orcaStatus: () =>
    queryOptions({
      queryKey: uaoQueryKeys.orcaStatus(),
      queryFn: ({ signal }) => fetchOrcaStatus(signal),
      refetchInterval: 5000,
      refetchIntervalInBackground: false,
      staleTime: 2000,
    }),
  orcaRepos: (enabled: boolean) =>
    queryOptions({
      queryKey: uaoQueryKeys.orcaRepos(),
      queryFn: enabled
        ? ({ signal }) => fetchOrcaRepos(signal)
        : skipToken,
      staleTime: 10000,
    }),
  orcaWorktrees: (enabled: boolean) =>
    queryOptions({
      queryKey: uaoQueryKeys.orcaWorktrees(),
      queryFn: enabled
        ? ({ signal }) => fetchOrcaWorktrees(signal)
        : skipToken,
      refetchInterval: enabled ? 4000 : false,
      refetchIntervalInBackground: false,
      staleTime: 2000,
    }),
  orcaTerminals: (worktreeId: string | null) =>
    queryOptions({
      queryKey: uaoQueryKeys.orcaTerminals(worktreeId),
      queryFn:
        worktreeId === null
          ? skipToken
          : ({ signal }) =>
              fetchOrcaTerminals(
                worktreeId.startsWith("id:") ? worktreeId : `id:${worktreeId}`,
                signal,
              ),
      refetchInterval: worktreeId !== null ? 3000 : false,
      refetchIntervalInBackground: false,
      staleTime: 1500,
    }),
  orcaTerminalScreen: (
    terminalHandle: string | null,
    enabled: boolean,
  ) =>
    queryOptions({
      queryKey: uaoQueryKeys.orcaTerminalScreen(terminalHandle),
      queryFn:
        terminalHandle === null || !enabled
          ? skipToken
          : ({ signal }) =>
              readOrcaTerminalScreen(terminalHandle, 300, signal),
      refetchInterval: terminalHandle !== null && enabled ? 2000 : false,
      refetchIntervalInBackground: false,
      staleTime: 1000,
    }),
};
