import { useCallback, useEffect, useMemo, useState } from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Boxes,
  CheckCircle2,
  FileText,
  Radio,
  RefreshCw,
  Sliders,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { queryClient } from "@/lib/query-client";
import { ThemeProvider } from "@/providers/theme-provider";
import { cn } from "@/lib/utils";
import type { KanbanBoard } from "@/lib/uao/adapter";
import { discardDrafts } from "@/lib/uao/draft-persistence";
import { uaoQueryOptions } from "@/lib/uao/query-options";
import { UaoEmbeddedPane } from "./uao-embedded-pane";
import { UaoKanbanTasksPane } from "./uao-kanban-tasks-pane";
import { UaoOrcaWorkspacesPane } from "./uao-orca-workspaces-pane";
import { UaoPaneBoundary } from "./uao-pane-boundary";
import { UaoOfficePane } from "./uao-office-pane";
import {
  DEFAULT_PANE_ID,
  findNavPane,
  isFeatureOwner,
  isNativeUaoPane,
  NAV_GROUPS,
  normalizeNavId,
  ORCA_PANE_ID,
  OFFICE_PANE_ID,
  WORKSPACE_PANE_ID,
} from "./uao-nav-registry";
import { UaoSidebar } from "./uao-sidebar";
import { UaoTaskDetailPane } from "./uao-task-detail-pane";
import { UaoWorktabsBar } from "./uao-worktabs-bar";
import {
  closeWorktab,
  DEFAULT_2PANE_SIZES,
  DEFAULT_3PANE_SIZES,
  MIN_PANE_FRACTION,
  openWorktab,
  sanitizePersistedWorktabs,
  sanitizeWorkspaceLayout,
  selectWorktab,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  updateWorktabRoute,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  WORKTABS_STORAGE_KEY,
  type PersistedWorktabsState,
  type WorkspaceLayoutPreferences,
} from "./uao-worktabs-state";
import { WorkspaceResizeDivider } from "./uao-workspace-divider";
import { UaoActivitySource } from "@/lib/uao/activity-source";

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
  readonly onNavigateAway: (paneId: string) => void;
}

function UaoTasksWorkspace({
  boards,
  activeBoard,
  onSelectBoard,
  onNavigateAway,
}: UaoTasksWorkspaceProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedBoardSlug, setSelectedBoardSlug] = useState<
    string | undefined
  >(undefined);
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  const [layoutPrefs, setLayoutPrefs] = useState<WorkspaceLayoutPreferences>(
    () => {
      if (typeof window !== "undefined") {
        try {
          const raw = localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
          if (raw) return sanitizeWorkspaceLayout(JSON.parse(raw));
        } catch {
          // ignore parsing error
        }
      }
      return {
        sizes3: DEFAULT_3PANE_SIZES,
        sizes2: DEFAULT_2PANE_SIZES,
      };
    },
  );

  const persistLayout = useCallback((prefs: WorkspaceLayoutPreferences) => {
    setLayoutPrefs(prefs);
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(
          WORKSPACE_LAYOUT_STORAGE_KEY,
          JSON.stringify(prefs),
        );
      } catch {
        // ignore storage error
      }
    }
  }, []);

  const handleSelectTask = useCallback(
    (taskId: string, boardSlug: string | undefined) => {
      setSelectedTaskId(taskId);
      setSelectedBoardSlug(boardSlug ?? activeBoard);
      setIsDetailOpen(true);
    },
    [activeBoard],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedTaskId(null);
    setSelectedBoardSlug(undefined);
    setIsDetailOpen(false);
  }, []);

  const handleResetLayout = useCallback(() => {
    persistLayout({
      sizes3: DEFAULT_3PANE_SIZES,
      sizes2: DEFAULT_2PANE_SIZES,
    });
  }, [persistLayout]);

  const handleCommitSizes = useCallback(
    (newSizes: ReadonlyArray<number>) => {
      if (isDetailOpen && newSizes.length === 3) {
        persistLayout({
          ...layoutPrefs,
          sizes3: [newSizes[0], newSizes[1], newSizes[2]],
        });
      } else if (!isDetailOpen && newSizes.length === 2) {
        persistLayout({
          ...layoutPrefs,
          sizes2: [newSizes[0], newSizes[1]],
        });
      }
    },
    [isDetailOpen, layoutPrefs, persistLayout],
  );

  const currentSizes = isDetailOpen ? layoutPrefs.sizes3 : layoutPrefs.sizes2;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Workspace Sub-header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/30 bg-card/40 px-4 py-1.5">
        <div className="flex items-center gap-3">
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

          <Button
            variant="ghost"
            size="xs"
            onClick={handleResetLayout}
            aria-label="Reset workspace layout"
          >
            <Sliders className="size-3 text-muted-foreground" />
            <span className="text-micro text-muted-foreground">
              Reset layout
            </span>
          </Button>

          {!isDetailOpen && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setIsDetailOpen(true)}
              aria-label="Open detail pane"
            >
              <FileText className="size-3 text-muted-foreground" />
              <span className="text-micro text-muted-foreground">
                Detail pane
              </span>
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Badge variant="outline" size="xs">
            {isDetailOpen ? "3-Pane Workspace" : "2-Pane Workspace"}
          </Badge>
        </div>
      </div>

      {/* Fluid Resizable Multi-Pane Work Area */}
      <main
        aria-label="Task, chat, and detail panes"
        className="flex min-h-0 flex-1 flex-row overflow-hidden"
      >
        {/* Left Pane: Kanban Tasks */}
        <div
          data-split-child
          style={{
            flexGrow: currentSizes[0],
            flexShrink: 1,
            flexBasis: "0%",
            minWidth: 0,
          }}
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <UaoPaneBoundary label="Tasks">
            <UaoKanbanTasksPane
              selectedTaskId={selectedTaskId}
              selectedBoardSlug={selectedBoardSlug}
              onSelectTask={handleSelectTask}
              activeBoard={activeBoard}
            />
          </UaoPaneBoundary>
        </div>

        {/* Divider 0: between Tasks and Chat */}
        <WorkspaceResizeDivider
          index={0}
          sizes={currentSizes}
          minFraction={MIN_PANE_FRACTION}
          onCommitSizes={handleCommitSizes}
          onReset={handleResetLayout}
        />

        {/* Center Pane: Persistent Dedicated Backend-Served Chat */}
        <div
          data-split-child
          style={{
            flexGrow: currentSizes[1],
            flexShrink: 1,
            flexBasis: "0%",
            minWidth: 0,
          }}
          className="flex h-full min-h-0 flex-col overflow-hidden"
        >
          <UaoEmbeddedPane
            activePaneId="chat"
            onChildNavigate={onNavigateAway}
            chatOnly
          />
        </div>

        {/* Optional Right Pane: Selected Task Detail */}
        {isDetailOpen ? (
          <>
            <WorkspaceResizeDivider
              index={1}
              sizes={currentSizes}
              minFraction={MIN_PANE_FRACTION}
              onCommitSizes={handleCommitSizes}
              onReset={handleResetLayout}
            />
            <div
              data-split-child
              style={{
                flexGrow: currentSizes[2],
                flexShrink: 1,
                flexBasis: "0%",
                minWidth: 0,
              }}
              className="flex h-full min-h-0 flex-col overflow-hidden"
            >
              <UaoTaskDetailPane
                taskId={selectedTaskId}
                boardSlug={selectedBoardSlug}
                onClose={handleCloseDetail}
              />
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}

function UaoStandaloneScreenInner() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      try {
        return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
      } catch {
        // ignore storage read error
      }
    }
    return false;
  });

  const [tabsState, setTabsState] = useState<PersistedWorktabsState>(() => {
    const initialHash =
      typeof window !== "undefined" && window.location.hash
        ? normalizeNavId(window.location.hash)
        : null;

    let savedParsed: PersistedWorktabsState | null = null;
    if (typeof window !== "undefined") {
      try {
        const raw = localStorage.getItem(WORKTABS_STORAGE_KEY);
        if (raw) savedParsed = sanitizePersistedWorktabs(JSON.parse(raw));
      } catch {
        // ignore parse error
      }
    }

    if (initialHash) {
      // New nav hash takes precedence over restore
      const baseTabs = savedParsed ? savedParsed.tabs : [];
      return openWorktab(
        baseTabs.length > 0
          ? baseTabs
          : [{ ownerId: DEFAULT_PANE_ID, routeTarget: DEFAULT_PANE_ID }],
        initialHash,
      );
    }

    if (savedParsed) {
      return savedParsed;
    }

    return {
      tabs: [{ ownerId: DEFAULT_PANE_ID, routeTarget: DEFAULT_PANE_ID }],
      activeOwnerId: DEFAULT_PANE_ID,
      activeRouteId: DEFAULT_PANE_ID,
    };
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(WORKTABS_STORAGE_KEY, JSON.stringify(tabsState));
      } catch {
        // ignore storage error
      }
    }
  }, [tabsState]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(
          SIDEBAR_COLLAPSED_STORAGE_KEY,
          String(sidebarCollapsed),
        );
      } catch {
        // ignore storage error
      }
    }
  }, [sidebarCollapsed]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

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

  // Active target pane metadata
  const activePane = useMemo(
    () => findNavPane(tabsState.activeRouteId),
    [tabsState.activeRouteId],
  );

  // Keep URL hash in sync with active route
  useEffect(() => {
    if (typeof window !== "undefined") {
      const targetHash = `#/${tabsState.activeRouteId}`;
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
      }
    }
  }, [tabsState.activeRouteId]);

  // Sync state on user tab open/switch
  const handleSelectPane = useCallback((paneId: string) => {
    setTabsState((prev) =>
      isFeatureOwner(paneId)
        ? selectWorktab(prev.tabs, paneId)
        : openWorktab(prev.tabs, paneId),
    );
  }, []);

  const handleSelectTab = useCallback((ownerId: string) => {
    setTabsState((prev) => selectWorktab(prev.tabs, ownerId));
  }, []);

  const handleCloseTab = useCallback((ownerId: string) => {
    setTabsState((prev) =>
      closeWorktab(prev.tabs, prev.activeOwnerId, ownerId),
    );
    // Closing discards the tab's unsent drafts. Wait until its document has
    // been removed, because removal flushes one last snapshot.
    setTimeout(() => discardDrafts(ownerId, window.localStorage), 0);
  }, []);

  const handleChildNavigate = useCallback((ownerId: string, paneId: string) => {
    setTabsState((prev) =>
      prev.activeOwnerId === ownerId
        ? updateWorktabRoute(prev.tabs, paneId)
        : prev,
    );
  }, []);

  // Like Traycer's tab host, mount on first activation and retain while open.
  // Restoring a strip must not start every embedded application at once.
  const [visitedOwners, setVisitedOwners] = useState<ReadonlySet<string>>(
    () => new Set([tabsState.activeOwnerId]),
  );
  if (!visitedOwners.has(tabsState.activeOwnerId)) {
    setVisitedOwners(new Set([...visitedOwners, tabsState.activeOwnerId]));
  }

  useEffect(() => {
    Object.defineProperty(window, "__uaoActivitySource", {
      value: UaoActivitySource,
      configurable: true,
    });
    return () => {
      Reflect.deleteProperty(window, "__uaoActivitySource");
    };
  }, []);

  // Listen to browser / Electron back/forward navigation
  useEffect(() => {
    const handleHashChange = () => {
      const target = normalizeNavId(window.location.hash);
      setTabsState((prev) => {
        if (prev.activeRouteId === target) return prev;
        return openWorktab(prev.tabs, target);
      });
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
              {activePane?.label ?? tabsState.activeRouteId}
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
              <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="muted" />
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
          activePaneId={tabsState.activeRouteId}
          onSelectPane={handleSelectPane}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={handleToggleSidebar}
        />

        {/* Content Area with Worktabs Bar */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {/* Top Content Bar: Feature Worktabs */}
          <UaoWorktabsBar
            tabs={tabsState.tabs}
            activeOwnerId={tabsState.activeOwnerId}
            onSelectTab={handleSelectTab}
            onCloseTab={handleCloseTab}
          />

          {tabsState.activeRouteId === "pwa-hitl" && (
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

          {/* Persistent Task Workspace (Kanban + Dedicated Chat + Detail) */}
          <div
            id={`uao-panel-${WORKSPACE_PANE_ID}`}
            role="tabpanel"
            aria-labelledby={`uao-tab-${WORKSPACE_PANE_ID}`}
            hidden={tabsState.activeOwnerId !== WORKSPACE_PANE_ID}
            className="h-full min-h-0"
          >
            <UaoTasksWorkspace
              boards={boards}
              activeBoard={activeBoard}
              onSelectBoard={setActiveBoardSelection}
              onNavigateAway={(paneId) =>
                handleChildNavigate(WORKSPACE_PANE_ID, paneId)
              }
            />
          </div>

          {/* Persistent Orca Terminal Workspaces */}
          <div
            id={`uao-panel-${ORCA_PANE_ID}`}
            role="tabpanel"
            aria-labelledby={`uao-tab-${ORCA_PANE_ID}`}
            hidden={tabsState.activeOwnerId !== ORCA_PANE_ID}
            className="h-full min-h-0"
          >
            <UaoPaneBoundary label="Orca Workspaces">
              <UaoOrcaWorkspacesPane
                active={tabsState.activeOwnerId === ORCA_PANE_ID}
              />
            </UaoPaneBoundary>
          </div>

          {visitedOwners.has(OFFICE_PANE_ID) ? (
            <div id={`uao-panel-${OFFICE_PANE_ID}`} role="tabpanel"
              aria-labelledby={`uao-tab-${OFFICE_PANE_ID}`}
              hidden={tabsState.activeOwnerId !== OFFICE_PANE_ID}
              className="h-full min-h-0">
              <UaoPaneBoundary label="Office">
                <UaoOfficePane active={tabsState.activeOwnerId === OFFICE_PANE_ID} />
              </UaoPaneBoundary>
            </div>
          ) : null}
          {/* Stable feature documents preserve drafts, drawers and scroll. */}
          {tabsState.tabs
            .filter(
              (tab) =>
                !isNativeUaoPane(tab.ownerId) &&
                visitedOwners.has(tab.ownerId),
            )
            .map((tab) => (
              <div
                key={tab.ownerId}
                id={`uao-panel-${tab.ownerId}`}
                role="tabpanel"
                aria-labelledby={`uao-tab-${tab.ownerId}`}
                hidden={tabsState.activeOwnerId !== tab.ownerId}
                className="h-full min-h-0"
              >
                <UaoEmbeddedPane
                  activePaneId={tab.routeTarget}
                  onChildNavigate={(paneId) =>
                    handleChildNavigate(tab.ownerId, paneId)
                  }
                />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

export function UaoStandaloneScreen() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <UaoStandaloneScreenInner />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
