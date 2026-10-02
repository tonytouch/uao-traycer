import { queryOptions, skipToken } from "@tanstack/react-query";
import {
  fetchKanbanBoards,
  fetchKanbanTask,
  fetchKanbanTasks,
} from "@/lib/uao/adapter";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";

export const uaoQueryOptions = {
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
