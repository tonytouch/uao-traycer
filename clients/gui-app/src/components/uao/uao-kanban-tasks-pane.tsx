import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  FolderKanban,
  RefreshCw,
  Search,
  User,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type KanbanStatus,
  type KanbanTask,
} from "@/lib/uao/adapter";
import { uaoQueryOptions } from "@/lib/uao/query-options";

export interface UaoKanbanTasksPaneProps {
  readonly selectedTaskId: string | null;
  readonly selectedBoardSlug: string | undefined;
  readonly onSelectTask: (taskId: string, boardSlug: string | undefined) => void;
  readonly activeBoard: string | undefined;
}

type FilterStatus = "all" | "blocked" | "running" | "todo" | "done";

function getStatusBadgeVariant(
  status: KanbanStatus,
): "destructive" | "warning" | "success" | "info" | "muted" {
  switch (status) {
    case "blocked":
      return "destructive";
    case "running":
      return "warning";
    case "done":
      return "success";
    case "todo":
    case "ready":
    case "scheduled":
      return "info";
    default:
      return "muted";
  }
}

export function UaoKanbanTasksPane(props: UaoKanbanTasksPaneProps) {
  const { selectedTaskId, selectedBoardSlug, onSelectTask, activeBoard } =
    props;
  const [search, setSearch] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("all");
  const tasksQuery = useQuery(uaoQueryOptions.tasks(activeBoard));
  const tasks: readonly KanbanTask[] = tasksQuery.data ?? [];
  const loading = tasksQuery.isFetching;

  const query = search.trim().toLowerCase();
  const filteredTasks = tasks.filter((task) => {
    if (statusFilter !== "all" && task.status !== statusFilter) return false;
    if (query.length === 0) return true;
    const matchesTitle = task.title.toLowerCase().includes(query);
    const matchesId = task.id.toLowerCase().includes(query);
    const matchesAssignee =
      task.assignee !== null && task.assignee.toLowerCase().includes(query);
    return matchesTitle || matchesId || matchesAssignee;
  });

  function renderTasksContent(): ReactNode {
    if (loading) {
      return (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
          <AgentSpinningDots tone="muted" />
          <span className="text-ui-xs">Loading tasks...</span>
        </div>
      );
    }

    if (tasksQuery.isError) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-center">
          <AlertCircle className="size-5 text-destructive" />
          <span className="text-ui-xs font-medium text-destructive">
            {tasksQuery.error instanceof Error
              ? tasksQuery.error.message
              : "Failed to load Kanban tasks"}
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void tasksQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      );
    }

    if (filteredTasks.length === 0) {
      return (
        <div className="flex h-32 flex-col items-center justify-center text-center text-muted-foreground">
          <CheckCircle2 className="mb-1 size-5 opacity-40" />
          <span className="text-ui-xs font-medium">No tasks found</span>
          <span className="text-ui-xs text-muted-foreground/80">
            Try adjusting your search or status filter
          </span>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-1.5">
        {filteredTasks.map((task) => {
          const taskBoard = task.board_slug ?? activeBoard;
          const isSelected =
            task.id === selectedTaskId &&
            taskBoard === selectedBoardSlug;
          return (
            <button
              key={`${taskBoard ?? "board"}-${task.id}`}
              type="button"
              onClick={() => onSelectTask(task.id, taskBoard)}
              aria-pressed={isSelected}
              className={cn(
                "flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-all",
                isSelected
                  ? "border-primary/50 bg-primary/10 shadow-xs"
                  : "border-border/40 bg-card hover:border-border hover:bg-foreground/5",
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-ui-xs font-semibold text-muted-foreground">
                  {task.id}
                </span>
                <div className="flex items-center gap-1">
                  {task.priority !== null && (
                    <span className="font-mono text-ui-xs text-muted-foreground">
                      P{task.priority}
                    </span>
                  )}
                  <Badge variant={getStatusBadgeVariant(task.status)} size="xs">
                    {task.status}
                  </Badge>
                </div>
              </div>

              <span className="line-clamp-2 text-ui-xs font-medium text-foreground">
                {task.title}
              </span>

              <div className="mt-0.5 flex items-center justify-between text-ui-xs text-muted-foreground">
                <span className="flex max-w-35 items-center gap-1 truncate">
                  <User className="size-3 shrink-0" />
                  <span className="truncate">
                    {task.assignee ?? "unassigned"}
                  </span>
                </span>
                {task.created_at > 0 && (
                  <span className="font-mono text-micro opacity-70">
                    {new Date(task.created_at * 1000).toLocaleDateString([], {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[85vw] shrink-0 flex-col border-r border-border/40 bg-card/40 backdrop-blur-xs md:w-1/4 md:max-w-xs">
      {/* Pane Header */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <FolderKanban className="size-4 text-primary" />
          <span className="text-ui-sm font-semibold tracking-tight text-foreground">
            Kanban Tasks
          </span>
          <Badge variant="muted" size="xs">
            {tasks.length}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => void tasksQuery.refetch()}
          disabled={tasksQuery.isFetching}
          aria-label="Refresh tasks"
        >
          {loading ? (
            <AgentSpinningDots tone="muted" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col gap-2 border-b border-border/40 p-2.5">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter tasks..."
            aria-label="Filter tasks"
            className="h-7 w-full rounded-md border border-border/60 bg-background/80 pr-2 pl-8 font-mono text-ui-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-hidden"
          />
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {(["all", "blocked", "running", "todo", "done"] as const).map(
            (tab) => {
              const active = statusFilter === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusFilter(tab)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-sm px-2 py-0.5 text-ui-xs font-medium capitalize transition-colors",
                    active
                      ? "bg-foreground/10 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                  )}
                >
                  {tab}
                </button>
              );
            },
          )}
        </div>
      </div>

      {/* Tasks List */}
      <div className="flex-1 overflow-y-auto p-2">{renderTasksContent()}</div>
    </aside>
  );
}
