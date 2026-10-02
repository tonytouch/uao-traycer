import { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Boxes, CheckCircle2, Radio, RefreshCw, Server } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import type { KanbanBoard } from "@/lib/uao/adapter";
import { uaoQueryOptions } from "@/lib/uao/query-options";
import { UaoChatPane } from "./uao-chat-pane";
import { UaoEmbeddedPane } from "./uao-embedded-pane";
import { UaoKanbanTasksPane } from "./uao-kanban-tasks-pane";
import {
  DEFAULT_PANE_ID,
  NAV_GROUPS,
  findNavPane,
  normalizeNavId,
  WORKSPACE_PANE_ID,
} from "./uao-nav-registry";
import { UaoSidebar } from "./uao-sidebar";
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

interface UaoTasksWorkspaceProps {
  readonly boards: readonly KanbanBoard[];
  readonly activeBoard: string | undefined;
  readonly onSelectBoard: (boardSlug: string) => void;
}

function UaoTasksWorkspace({
  boards,
  activeBoard,
  onSelectBoard,
}: UaoTasksWorkspaceProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedBoardSlug, setSelectedBoardSlug] = useState<
    string | undefined
  >(undefined);

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
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Workspace Sub-header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/30 bg-card/40 px-4 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-heading text-ui-xs font-semibold text-foreground">
            Workspace Boards:
          </span>
          {boards.length > 0 ? (
            <div className="flex items-center gap-1.5">
              <label className="sr-only" htmlFor="uao-board-select">
                Select board
              </label>
              <select
                id="uao-board-select"
                aria-label="Select board"
                className="rounded-md border border-border/60 bg-card px-2 py-0.5 text-ui-xs text-foreground"
                value={activeBoard ?? ""}
                onChange={(event) => onSelectBoard(event.currentTarget.value)}
              >
                {boards.map((board) => (
                  <option key={board.slug} value={board.slug}>
                    {board.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span className="font-mono text-micro text-muted-foreground">
              Default Board
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="xs">
            3-Pane Workspace
          </Badge>
        </div>
      </div>

      {/* Standalone Preview Notice Banner */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/20 bg-primary/5 px-4 py-1 text-micro text-foreground/80">
        <div className="flex items-center gap-2">
          <Server className="size-3 text-primary" />
          <span>
            <b>Standalone Preview</b> — Direct proxy to UAO Hermes backend.
            Local CLI turns are fresh (non-resumable) and in-memory only.
          </span>
        </div>
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

function UaoStandaloneScreenInner() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activePaneId, setActivePaneId] = useState<string>(() => {
    if (typeof window !== "undefined" && window.location.hash) {
      return normalizeNavId(window.location.hash);
    }
    return DEFAULT_PANE_ID;
  });

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

  // Active pane metadata
  const activePane = useMemo(() => findNavPane(activePaneId), [activePaneId]);

  // Sync state to URL hash
  const handleSelectPane = useCallback((paneId: string) => {
    setActivePaneId(paneId);
    if (typeof window !== "undefined") {
      window.location.hash = `/${paneId}`;
    }
  }, []);

  const handleChildNavigate = useCallback((paneId: string) => {
    setActivePaneId(paneId);
    window.history.replaceState(null, "", `#/${paneId}`);
  }, []);

  // Listen to browser / Electron back/forward navigation
  useEffect(() => {
    const handleHashChange = () => {
      const target = normalizeNavId(window.location.hash);
      setActivePaneId((prev) => (prev !== target ? target : prev));
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
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
                Traycer Desktop
              </span>
            </div>
          </div>

          <div className="h-4 w-px bg-border/60" />

          {/* Active Navigation Title */}
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-micro text-muted-foreground uppercase">
              {NAV_GROUPS.find((group) => group.id === activePane?.group)
                ?.label ?? "Feature"}
              :
            </span>
            <span className="font-heading text-ui-xs font-semibold text-foreground">
              {activePane?.label ?? activePaneId}
            </span>
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
        </div>

        <div className="flex items-center gap-2">
          {connected === true && (
            <span className="hidden items-center gap-1 font-mono text-micro text-success sm:flex">
              <CheckCircle2 className="size-3" />
              127.0.0.1:5050 live
            </span>
          )}

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
            Local UAO
          </Badge>
        </div>
      </header>

      {/* Main Container with Sidebar + Content */}
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        {/* Traycer-style Searchable Collapsible Sidebar */}
        <UaoSidebar
          activePaneId={activePaneId}
          onSelectPane={handleSelectPane}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
        />

        {/* Content Area */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {activePaneId === "pwa-hitl" && (
            <div
              role="note"
              className="shrink-0 border-b border-border bg-card px-4 py-2 text-ui-xs text-muted-foreground"
            >
              Mobile push subscriptions use UAO’s browser/PWA; desktop push is
              not connected yet.{" "}
              <a
                className="text-primary underline"
                href="http://127.0.0.1:5050/#/pwa-hitl"
              >
                Open UAO in your browser
              </a>
            </div>
          )}
          <div
            hidden={activePaneId !== WORKSPACE_PANE_ID}
            className="h-full min-h-0"
          >
            <UaoTasksWorkspace
              boards={boards}
              activeBoard={activeBoard}
              onSelectBoard={setActiveBoardSelection}
            />
          </div>
          <div
            hidden={activePaneId === WORKSPACE_PANE_ID}
            className="h-full min-h-0"
          >
            <UaoEmbeddedPane
              activePaneId={activePaneId}
              onChildNavigate={handleChildNavigate}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function UaoStandaloneScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <UaoStandaloneScreenInner />
    </QueryClientProvider>
  );
}
