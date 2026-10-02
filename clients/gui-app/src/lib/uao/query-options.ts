import { queryOptions, skipToken } from "@tanstack/react-query";
import {
  fetchKanbanBoards,
  fetchKanbanTask,
  fetchKanbanTasks,
} from "@/lib/uao/adapter";
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
};
