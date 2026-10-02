import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  CheckCircle2,
  Radio,
  RefreshCw,
  Server,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KanbanBoard } from "@/lib/uao/adapter";
import { uaoQueryOptions } from "@/lib/uao/query-options";
import { UaoChatPane } from "./uao-chat-pane";
import { UaoKanbanTasksPane } from "./uao-kanban-tasks-pane";
import { UaoTaskDetailPane } from "./uao-task-detail-pane";

function getConnectionDotClass(
  checking: boolean,
  connected: boolean | null,
): string {
  if (checking) return "bg-warning";
  if (connected === true) return "bg-success";
  return "bg-destructive";
}

function getConnectionStatusText(
  checking: boolean,
  connected: boolean | null,
): string {
  if (checking) return "Connecting...";
  if (connected === true) return "127.0.0.1:5050 connected";
  return "127.0.0.1:5050 unreachable";
}

export function UaoStandaloneScreen() {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedBoardSlug, setSelectedBoardSlug] = useState<
    string | undefined
  >(undefined);
  const [activeBoardSelection, setActiveBoardSelection] = useState<
    string | null
  >(null);
  const boardsQuery = useQuery(uaoQueryOptions.boards());
  const boards: readonly KanbanBoard[] = boardsQuery.data ?? [];
  const activeBoard = activeBoardSelection ?? boards.at(0)?.slug;
  const checking = boardsQuery.isPending;
  let connected: boolean | null = null;
  if (boardsQuery.isSuccess) {
    connected = true;
  } else if (boardsQuery.isError) {
    connected = false;
  }

  const handleSelectTask = useCallback(
    (taskId: string, boardSlug: string | undefined) => {
      setSelectedTaskId(taskId);
      setSelectedBoardSlug(boardSlug ?? activeBoard);
    },
    [activeBoard],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedBoardSlug(undefined);
  }, []);

  return (
    <div className="flex h-safe-dvh w-full flex-col overflow-hidden bg-background text-foreground antialiased select-none">
      {/* Top Application Header */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/40 bg-card/60 px-4 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded-lg border border-primary/40 bg-primary/10">
              <Boxes className="size-3.5 text-primary" />
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-heading text-ui-sm font-bold tracking-tight text-foreground">
                UAO
              </span>
              <span className="font-mono text-micro text-muted-foreground">
                Traycer Preview
              </span>
            </div>
          </div>

          <div className="h-4 w-px bg-border/60" />

          {/* Backend Connection Badge */}
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2 rounded-full",
                getConnectionDotClass(checking, connected),
              )}
            />
            <span className="font-mono text-micro text-muted-foreground">
              {getConnectionStatusText(checking, connected)}
            </span>
          </div>

          {/* Native select keeps boards compact in the app header. */}
          {boards.length > 1 && (
            <>
              <div className="h-4 w-px bg-border/60" />
              <div className="flex min-w-0 items-center gap-1.5">
                <label className="sr-only" htmlFor="uao-board-select">
                  Select board
                </label>
                <select
                  id="uao-board-select"
                  aria-label="Select board"
                  className="w-full max-w-40 rounded-md border border-border/60 bg-card px-2 py-1 text-ui-xs text-foreground"
                  value={activeBoard ?? ""}
                  onChange={(event) =>
                    setActiveBoardSelection(event.currentTarget.value)
                  }
                >
                  {boards.map((board) => (
                    <option key={board.slug} value={board.slug}>
                      {board.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void boardsQuery.refetch()}
            disabled={boardsQuery.isFetching}
            aria-label="Refresh connection status"
          >
            {boardsQuery.isFetching ? (
              <AgentSpinningDots tone="muted" />
            ) : (
              <RefreshCw className="size-3 text-muted-foreground" />
            )}
            <span className="text-micro text-muted-foreground">Sync</span>
          </Button>

          <Badge variant="outline" size="xs">
            <Radio className="size-2.5 text-primary" />
            Standalone
          </Badge>
        </div>
      </header>

      {/* Standalone Preview Notice Banner */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-primary/5 px-4 py-1 text-micro text-foreground/80">
        <div className="flex items-center gap-2">
          <Server className="size-3 text-primary" />
          <span>
            <b>Standalone Preview</b> — Direct proxy to UAO Hermes backend. Local
            CLI turns are fresh (non-resumable) and in-memory only.
          </span>
        </div>
        {connected === true && (
          <span className="flex items-center gap-1 text-success">
            <CheckCircle2 className="size-3" />
            Backend live
          </span>
        )}
      </div>

      {/* Three-Pane Work Area */}
      <main
        aria-label="Task, chat, and detail panes. Scroll horizontally on narrow screens."
        className="flex min-h-0 flex-1 flex-row overflow-x-auto overflow-y-hidden md:overflow-hidden"
      >
        {/* Left Pane: Kanban Tasks */}
        <UaoKanbanTasksPane
          selectedTaskId={selectedTaskId}
          selectedBoardSlug={selectedBoardSlug}
          onSelectTask={handleSelectTask}
          activeBoard={activeBoard}
        />

        {/* Center Pane: Streaming Chat */}
        <UaoChatPane />

        {/* Right Pane: Selected Task Detail */}
        <UaoTaskDetailPane
          taskId={selectedTaskId}
          boardSlug={selectedBoardSlug}
          onClose={handleCloseDetail}
        />
      </main>
    </div>
  );
}
