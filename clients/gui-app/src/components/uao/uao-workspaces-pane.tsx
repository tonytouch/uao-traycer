import {
  lazy,
  Suspense,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  FolderGit2,
  Play,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import { uaoQueryOptions } from "@/lib/uao/query-options";
import {
  createWorkspaceTerminal,
  openWorkspace,
  type WorkspaceAgent,
  type WorkspaceOpenResult,
  type WorkspaceRepo,
  type WorkspaceTerminalCreateResult,
  type WorkspaceTerminalSummary,
  type WorkspaceWorktree,
} from "@/lib/uao/workspaces-adapter";
import { cn } from "@/lib/utils";
import { setWorkspaceTarget, useWorkspaceTarget, type WorkspaceTarget } from "@/lib/uao/workspaces-target";
const UaoTerminalXterm = lazy(() =>
  import("./uao-terminal-xterm").then((module) => ({
    default: module.UaoTerminalXterm,
  })),
);

function usePageVisibility(): boolean {
  return useSyncExternalStore(
    (callback) => {
      document.addEventListener("visibilitychange", callback);
      return () => document.removeEventListener("visibilitychange", callback);
    },
    () =>
      typeof document !== "undefined"
        ? document.visibilityState === "visible"
        : true,
    () => true,
  );
}

const AGENT_OPTIONS: readonly {
  readonly id: WorkspaceAgent;
  readonly label: string;
}[] = [
  { id: "shell", label: "Shell (Default)" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "hermes", label: "Hermes" },
];

const EMPTY_REPOS: readonly WorkspaceRepo[] = [];
const EMPTY_WORKTREES: readonly WorkspaceWorktree[] = [];
const EMPTY_TERMINALS: readonly WorkspaceTerminalSummary[] = [];

function creationMessage(
  error: Error | null,
  result: WorkspaceTerminalCreateResult | undefined,
): string | undefined {
  return error?.message ?? result?.terminal?.warning;
}

function WorkspaceQueryError({
  errors,
}: {
  readonly errors: readonly (Error | null)[];
}) {
  const error = errors.find(Boolean);
  return error ? (
    <p role="alert" className="px-4 py-2 text-ui-xs text-destructive">
      {error.message}
    </p>
  ) : null;
}

function matchesWorktree(
  worktree: WorkspaceWorktree,
  repoFilter: string,
  searchQuery: string,
): boolean {
  if (repoFilter !== "all") {
    if (worktree.repoId !== repoFilter && worktree.repo !== repoFilter) {
      return false;
    }
  }
  if (searchQuery.length === 0) {
    return true;
  }
  const q = searchQuery.toLowerCase();
  if (worktree.displayName.toLowerCase().includes(q)) return true;
  if (worktree.branch.toLowerCase().includes(q)) return true;
  if (worktree.path.toLowerCase().includes(q)) return true;
  if (worktree.repo.toLowerCase().includes(q)) return true;
  if (
    worktree.status !== undefined &&
    worktree.status.toLowerCase().includes(q)
  )
    return true;
  if (String(worktree.liveTerminalCount).includes(q)) return true;
  return false;
}

function findActiveWorktree(
  worktrees: readonly WorkspaceWorktree[],
  selectedId: string | null,
): WorkspaceWorktree | undefined {
  if (selectedId !== null) {
    const match = worktrees.find((w) => w.worktreeId === selectedId);
    if (match) return match;
  }
  return worktrees.at(0);
}

function findActiveTerminal(
  terminals: readonly WorkspaceTerminalSummary[],
  selectedHandle: string | null,
): WorkspaceTerminalSummary | undefined {
  if (selectedHandle !== null) {
    const match = terminals.find((t) => t.handle === selectedHandle);
    if (match) return match;
  }
  return terminals.at(0);
}

interface WorkspaceSubHeaderProps {
  readonly isReachable: boolean;
  readonly runtimeState: string;
  readonly appVersion: string | undefined;
  readonly isOpenPending: boolean;
  readonly isStatusFetching: boolean;
  readonly onOpen: () => void;
  readonly onRefresh: () => void;
}

function WorkspaceSubHeader(props: WorkspaceSubHeaderProps) {
  const {
    isReachable,
    runtimeState,
    appVersion,
    isOpenPending,
    isStatusFetching,
    onOpen,
    onRefresh,
  } = props;

  const versionLabel =
    appVersion !== undefined ? appVersion : "version unknown";
  const statusLabel = isReachable
    ? `Workspace live (${versionLabel})`
    : `Workspace offline (${runtimeState})`;

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/30 bg-card/40 px-4 py-2">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-primary" />
          <span className="font-heading text-ui-sm font-semibold text-foreground">
            Workspaces & Agent Terminals
          </span>
        </div>

        <div className="h-4 w-px bg-border/60" />

        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              isReachable ? "bg-success" : "bg-warning",
            )}
          />
          <span className="font-mono text-micro text-muted-foreground">
            {statusLabel}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {!isReachable && (
          <Button
            variant="outline"
            size="xs"
            onClick={onOpen}
            disabled={isOpenPending}
          >
            {isOpenPending ? (
              <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="inherit" />
            ) : (
              <Play className="size-3" />
            )}
            <span>Start Workspace Runtime</span>
          </Button>
        )}

        <Button
          variant="ghost"
          size="xs"
          onClick={onRefresh}
          disabled={isStatusFetching}
          aria-label="Refresh Workspace status"
        >
          {isStatusFetching ? (
            <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="muted" />
          ) : (
            <RefreshCw className="size-3 text-muted-foreground" />
          )}
          <span className="text-micro text-muted-foreground">Refresh</span>
        </Button>
      </div>
    </div>
  );
}

interface WorkspaceOfflineCardProps {
  readonly runtimeState: string;
  readonly isOpenPending: boolean;
  readonly openError: string | undefined;
  readonly onOpen: () => void;
}

function WorkspaceOfflineCard(props: WorkspaceOfflineCardProps) {
  const { runtimeState, isOpenPending, openError, onOpen } = props;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="max-w-md rounded-lg border border-border/40 bg-card/60 p-6 shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full border border-warning/30 bg-warning/10">
          <AlertTriangle className="size-6 text-warning" />
        </div>
        <h2 className="mb-2 font-heading text-ui-base font-semibold text-foreground">
          Workspace Runtime Offline
        </h2>
        <p className="mb-4 text-ui-xs text-muted-foreground">
          Workspace is not currently reachable (state:{" "}
          <code className="font-mono text-micro text-foreground/80">
            {runtimeState}
          </code>
          ). Read-only queries do not auto-start Workspace. Click below to launch or
          connect the local Workspace runtime.
        </p>
        <Button
          variant="default"
          size="sm"
          onClick={onOpen}
          disabled={isOpenPending}
          className="w-full"
        >
          {isOpenPending ? (
            <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="inherit" />
          ) : (
            <Play className="size-3.5" />
          )}
          <span>Start Workspace Runtime</span>
        </Button>
        {openError !== undefined && (
          <p className="mt-3 text-micro text-destructive">Workspace: {openError}</p>
        )}
      </div>
    </div>
  );
}

interface WorkspaceWorktreeItemProps {
  readonly worktree: WorkspaceWorktree;
  readonly isSelected: boolean;
  readonly onSelect: (id: string) => void;
}

function WorkspaceWorktreeItem(props: WorkspaceWorktreeItemProps) {
  const { worktree, isSelected, onSelect } = props;
  const hasActiveAgent = (worktree.agents ?? []).some(
    (a) => a.state === "working",
  );

  return (
    <button
      type="button"
      onClick={() => onSelect(worktree.worktreeId)}
      aria-pressed={isSelected}
      className={cn(
        "flex flex-col rounded-md border p-2 text-left transition-colors",
        isSelected
          ? "border-primary/50 bg-foreground/10"
          : "border-border/30 bg-card/40 hover:bg-foreground/5",
      )}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-heading text-ui-xs font-semibold text-foreground">
          {worktree.displayName || worktree.branch}
        </span>
        <div className="flex items-center gap-1">
          {hasActiveAgent ? (
            <Badge variant="accent" size="xs">
              agent
            </Badge>
          ) : null}
          <Badge variant="outline" size="xs">
            {worktree.liveTerminalCount} term
          </Badge>
          <Badge variant="outline" size="xs">
            {worktree.status ?? "unknown"}
          </Badge>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
        <FolderGit2 className="size-3 shrink-0" />
        <span className="truncate">{worktree.repo}</span>
        <span>•</span>
        <span className="truncate">{worktree.branch}</span>
      </div>

      <div className="mt-0.5 truncate font-mono text-micro text-muted-foreground/80">
        {worktree.path}
      </div>
    </button>
  );
}

interface WorkspacesSidebarProps {
  readonly repos: readonly WorkspaceRepo[];
  readonly worktrees: readonly WorkspaceWorktree[];
  readonly search: string;
  readonly selectedRepoFilter: string;
  readonly resolvedWorktreeId: string | null;
  readonly isFetching: boolean;
  readonly onSearchChange: (value: string) => void;
  readonly onRepoFilterChange: (value: string) => void;
  readonly onSelectWorktree: (id: string) => void;
}

function WorkspacesSidebar(props: WorkspacesSidebarProps) {
  const {
    repos,
    worktrees,
    search,
    selectedRepoFilter,
    resolvedWorktreeId,
    isFetching,
    onSearchChange,
    onRepoFilterChange,
    onSelectWorktree,
  } = props;

  return (
    <aside
      aria-label="Workspaces inventory"
      className="flex w-1/4 min-w-0 flex-col border-r border-border/40 bg-card/20"
    >
      <div className="flex flex-col gap-2 border-b border-border/30 p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.currentTarget.value)}
            placeholder="Search branch, repo, path, status…"
            aria-label="Search workspaces"
            className="w-full rounded-md border border-border/60 bg-foreground/5 py-1 pr-2 pl-8 text-ui-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <label
            htmlFor="workspace-repo-filter"
            className="shrink-0 font-mono text-micro text-muted-foreground"
          >
            Repo:
          </label>
          <select
            id="workspace-repo-filter"
            aria-label="Filter workspaces by repository"
            value={selectedRepoFilter}
            onChange={(e) => onRepoFilterChange(e.currentTarget.value)}
            className="w-full rounded-md border border-border/60 bg-card px-2 py-1 text-ui-xs text-foreground"
          >
            <option value="all">All Repos ({repos.length})</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-1 flex items-center justify-between px-1 text-micro text-muted-foreground">
          <span>Workspaces ({worktrees.length})</span>
          {isFetching ? <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="muted" /> : null}
        </div>

        {worktrees.length === 0 ? (
          <div className="p-4 text-center text-ui-xs text-muted-foreground">
            No matching workspaces found.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {worktrees.map((wt) => (
              <WorkspaceWorktreeItem
                key={wt.worktreeId}
                worktree={wt}
                isSelected={wt.worktreeId === resolvedWorktreeId}
                onSelect={onSelectWorktree}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

interface WorkspaceTerminalItemProps {
  readonly terminal: WorkspaceTerminalSummary;
  readonly isSelected: boolean;
  readonly onSelect: (handle: string) => void;
}

function WorkspaceTerminalItem(props: WorkspaceTerminalItemProps) {
  const { terminal, isSelected, onSelect } = props;

  return (
    <button
      type="button"
      onClick={() => onSelect(terminal.handle)}
      aria-pressed={isSelected}
      className={cn(
        "flex flex-col rounded-md border p-2 text-left transition-colors",
        isSelected
          ? "border-primary/50 bg-foreground/10"
          : "border-border/30 bg-card/40 hover:bg-foreground/5",
      )}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-mono text-ui-xs font-medium text-foreground">
          {terminal.title || terminal.handle}
        </span>
        <span
          className={cn(
            "size-2 rounded-full",
            terminal.connected ? "bg-success" : "bg-destructive",
          )}
        />
      </div>

      <div className="mt-1 flex items-center gap-1 text-micro text-muted-foreground">
        {terminal.agentIdentity ? (
          <Badge variant="accent" size="xs">
            {terminal.agentIdentity}
          </Badge>
        ) : null}
        {!terminal.writable && (
          <Badge variant="warning" size="xs">
            read-only
          </Badge>
        )}
        {typeof terminal.exitCause === "string" && terminal.exitCause ? (
          <Badge variant="destructive" size="xs">
            {terminal.exitCause}
          </Badge>
        ) : null}
      </div>

      {terminal.preview ? (
        <div className="mt-1 truncate font-mono text-micro text-muted-foreground/70">
          {terminal.preview}
        </div>
      ) : null}
    </button>
  );
}

interface WorkspaceTerminalsSidebarProps {
  readonly terminals: readonly WorkspaceTerminalSummary[];
  readonly selectedTerminalHandle: string | null;
  readonly resolvedWorktreeId: string | null;
  readonly agentChoice: WorkspaceAgent;
  readonly isCreating: boolean;
  readonly createError: string | undefined;
  readonly onSelectTerminal: (handle: string) => void;
  readonly onAgentChoiceChange: (agent: WorkspaceAgent) => void;
  readonly onCreateTerminal: () => void;
}

function WorkspaceTerminalsSidebar(props: WorkspaceTerminalsSidebarProps) {
  const {
    terminals,
    selectedTerminalHandle,
    resolvedWorktreeId,
    agentChoice,
    isCreating,
    createError,
    onSelectTerminal,
    onAgentChoiceChange,
    onCreateTerminal,
  } = props;

  return (
    <section
      aria-label="Terminals list"
      className="flex w-1/4 min-w-0 flex-col border-r border-border/40 bg-card/10"
    >
      <div className="flex flex-col gap-2 border-b border-border/30 p-2.5">
        <div className="flex items-center justify-between">
          <span className="font-heading text-ui-xs font-semibold text-foreground">
            Terminals
          </span>
          <Badge variant="outline" size="xs">
            {terminals.length} sessions
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <label htmlFor="workspace-new-term-agent" className="sr-only">
            Agent choice
          </label>
          <select
            id="workspace-new-term-agent"
            aria-label="Select agent type for new terminal"
            value={agentChoice}
            onChange={(e) =>
              onAgentChoiceChange(e.currentTarget.value as WorkspaceAgent)
            }
            className="rounded-md border border-border/60 bg-card px-2 py-1 text-ui-xs text-foreground"
          >
            {AGENT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>

          <Button
            variant="default"
            size="xs"
            onClick={onCreateTerminal}
            disabled={resolvedWorktreeId === null || isCreating}
            className="shrink-0"
          >
            {isCreating ? (
              <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="inherit" />
            ) : (
              <Plus className="size-3" />
            )}
            <span>New</span>
          </Button>
        </div>

        {createError !== undefined && (
          <p className="text-micro text-destructive">Workspace: {createError}</p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {terminals.length === 0 ? (
          <div className="p-4 text-center text-ui-xs text-muted-foreground">
            No active terminals in this workspace. Create one above.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {terminals.map((t) => (
              <WorkspaceTerminalItem
                key={t.handle}
                terminal={t}
                isSelected={t.handle === selectedTerminalHandle}
                onSelect={onSelectTerminal}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

interface WorkspacesConnectedPaneProps {
  readonly active: boolean;
  readonly appVersion: string | undefined;
  readonly runtimeState: string;
  readonly isOpenPending: boolean;
  readonly isStatusFetching: boolean;
  readonly onOpenWorkspace: () => void;
  readonly onRefetchStatus: () => void;
}

function WorkspacesConnectedPane(props: WorkspacesConnectedPaneProps) {
  const queryClient = useQueryClient();
  const {
    appVersion,
    runtimeState,
    isOpenPending,
    isStatusFetching,
    onOpenWorkspace,
    onRefetchStatus,
  } = props;

  const isPageVisible = usePageVisibility() && props.active;

  // 1. Repos & Worktrees
  const {
    data: reposData,
    error: reposError,
    refetch: refetchRepos,
  } = useQuery(uaoQueryOptions.workspaceRepos(isPageVisible));

  const {
    data: worktreesData,
    error: worktreesError,
    isFetching: isWorktreesFetching,
    refetch: refetchWorktrees,
  } = useQuery(uaoQueryOptions.workspaceWorktrees(isPageVisible));

  const repos: readonly WorkspaceRepo[] = reposData ?? EMPTY_REPOS;
  const worktrees: readonly WorkspaceWorktree[] = worktreesData ?? EMPTY_WORKTREES;

  // Filter & Search State
  const [search, setSearch] = useState("");
  const [selectedRepoFilter, setSelectedRepoFilter] = useState("all");
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(
    null,
  );
  const [selectedTerminalHandle, setSelectedTerminalHandle] = useState<
    string | null
  >(null);
  const [agentChoice, setAgentChoice] = useState<WorkspaceAgent>("shell");

  const filteredWorktrees = useMemo(() => {
    const trimmed = search.trim();
    return worktrees.filter((w) =>
      matchesWorktree(w, selectedRepoFilter, trimmed),
    );
  }, [worktrees, selectedRepoFilter, search]);

  const activeWorktree = useMemo((): WorkspaceWorktree | undefined => {
    return findActiveWorktree(filteredWorktrees, selectedWorktreeId);
  }, [filteredWorktrees, selectedWorktreeId]);

  const resolvedWorktreeId = activeWorktree ? activeWorktree.worktreeId : null;

  // 2. Terminals for Selected Workspace
  const { data: terminalsData, error: terminalsError } = useQuery({
    ...uaoQueryOptions.workspaceTerminals(resolvedWorktreeId),
    enabled: isPageVisible,
  });
  const terminals: readonly WorkspaceTerminalSummary[] =
    terminalsData ?? EMPTY_TERMINALS;

  const activeTerminal = useMemo((): WorkspaceTerminalSummary | undefined => {
    return findActiveTerminal(terminals, selectedTerminalHandle);
  }, [terminals, selectedTerminalHandle]);

  const resolvedTerminalHandle = activeTerminal ? activeTerminal.handle : null;

  // 3. Create Terminal Mutation
  const {
    mutate: mutateCreateTerminal,
    data: createResult,
    isPending: isCreateTerminalPending,
    error: createTerminalError,
  } = useMutation<
    WorkspaceTerminalCreateResult,
    Error,
    {
      readonly worktree: string;
      readonly agent: WorkspaceAgent;
    }
  >({
    mutationKey: uaoQueryKeys.workspaceTerminalCreateMutation(),
    retry: false,
    mutationFn: async (payload) => {
      return createWorkspaceTerminal(payload, undefined);
    },
    onSuccess: async (data, variables) => {
      const workspaceId = variables.worktree.slice(3);
      await queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.workspaceTerminals(workspaceId),
      });
      if (data.terminal?.handle && resolvedWorktreeId === workspaceId) {
        setSelectedTerminalHandle(data.terminal.handle);
      }
    },
  });

  const handleRefresh = useCallback(() => {
    onRefetchStatus();
    void refetchWorktrees();
    void refetchRepos();
  }, [onRefetchStatus, refetchWorktrees, refetchRepos]);

  const handleCreateTerminal = useCallback(() => {
    if (resolvedWorktreeId) {
      mutateCreateTerminal({
        worktree: resolvedWorktreeId.startsWith("id:")
          ? resolvedWorktreeId
          : `id:${resolvedWorktreeId}`,
        agent: agentChoice,
      });
    }
  }, [resolvedWorktreeId, mutateCreateTerminal, agentChoice]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <WorkspaceSubHeader
        isReachable
        runtimeState={runtimeState}
        appVersion={appVersion}
        isOpenPending={isOpenPending}
        isStatusFetching={isStatusFetching}
        onOpen={onOpenWorkspace}
        onRefresh={handleRefresh}
      />

      <WorkspaceQueryError errors={[reposError, worktreesError, terminalsError]} />

      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <WorkspacesSidebar
          repos={repos}
          worktrees={filteredWorktrees}
          search={search}
          selectedRepoFilter={selectedRepoFilter}
          resolvedWorktreeId={resolvedWorktreeId}
          isFetching={isWorktreesFetching}
          onSearchChange={setSearch}
          onRepoFilterChange={setSelectedRepoFilter}
          onSelectWorktree={setSelectedWorktreeId}
        />

        <WorkspaceTerminalsSidebar
          terminals={terminals}
          selectedTerminalHandle={resolvedTerminalHandle}
          resolvedWorktreeId={resolvedWorktreeId}
          agentChoice={agentChoice}
          isCreating={isCreateTerminalPending}
          createError={creationMessage(createTerminalError, createResult)}
          onSelectTerminal={setSelectedTerminalHandle}
          onAgentChoiceChange={setAgentChoice}
          onCreateTerminal={handleCreateTerminal}
        />

        {activeTerminal ? (
          <Suspense fallback={<AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="muted" />}>
            <UaoTerminalXterm
              key={activeTerminal.handle}
              handle={activeTerminal.handle}
              title={activeTerminal.title || activeTerminal.handle}
              connected={activeTerminal.connected}
              writable={activeTerminal.writable}
              active={isPageVisible}
              agentIdentity={activeTerminal.agentIdentity}
            />
          </Suspense>
        ) : (
          <main
            aria-label="Interactive terminal surface"
            className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center text-ui-sm text-muted-foreground"
          >
            Select a terminal or create a new one to start streaming.
          </main>
        )}
      </div>
    </div>
  );
}

function UaoWorkspacesPaneForTarget({
  active,
}: {
  readonly active: boolean;
}) {
  const queryClient = useQueryClient();

  const {
    data: statusData,
    error: statusError,
    isFetching: isStatusFetching,
    refetch: refetchStatus,
  } = useQuery({ ...uaoQueryOptions.workspaceStatus(), enabled: active });

  const runtime = statusData?.result?.runtime;
  const isReachable = runtime?.reachable === true;
  const runtimeState =
    runtime?.state ?? (isStatusFetching ? "checking" : "unknown");

  const {
    mutate: mutateOpen,
    isPending: isOpenPending,
    error: openError,
  } = useMutation<WorkspaceOpenResult>({
    mutationKey: uaoQueryKeys.workspaceOpenMutation(),
    retry: false,
    mutationFn: async () => {
      return openWorkspace(undefined);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.workspaceStatus(),
      });
      await queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.workspaceWorktrees(),
      });
      await queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.workspaceRepos(),
      });
    },
  });

  const handleOpen = useCallback(() => {
    mutateOpen();
  }, [mutateOpen]);

  const handleRefreshStatus = useCallback(() => {
    void refetchStatus();
  }, [refetchStatus]);

  if (!isReachable) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        <WorkspaceSubHeader
          isReachable={false}
          runtimeState={runtimeState}
          appVersion={runtime?.appVersion}
          isOpenPending={isOpenPending}
          isStatusFetching={isStatusFetching}
          onOpen={handleOpen}
          onRefresh={handleRefreshStatus}
        />
        <WorkspaceOfflineCard
          runtimeState={runtimeState}
          isOpenPending={isOpenPending}
          openError={openError?.message ?? statusError?.message}
          onOpen={handleOpen}
        />
      </div>
    );
  }

  return (
    <WorkspacesConnectedPane
      active={active}
      appVersion={runtime.appVersion}
      runtimeState={runtimeState}
      isOpenPending={isOpenPending}
      isStatusFetching={isStatusFetching}
      onOpenWorkspace={handleOpen}
      onRefetchStatus={handleRefreshStatus}
    />
  );
}

const WORKSPACE_TARGETS: readonly { readonly id: WorkspaceTarget; readonly label: string }[] = [
  { id: "local", label: "This computer" },
  { id: "server", label: "Server" },
];

/**
 * Workspace on this computer or on the paired server. The switch only appears when
 * the desktop has a server; switching drops every cached Workspace answer and
 * remounts the pane, which closes the open terminal streams.
 */
export function UaoWorkspacesPane({
  active,
}: {
  readonly active: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: config } = useQuery(uaoQueryOptions.config());
  const stored = useWorkspaceTarget();
  const hasServer = config?.workspacesServer === true;
  const target: WorkspaceTarget = hasServer ? stored : "local";

  const choose = useCallback(
    (next: WorkspaceTarget) => {
      if (next === target) return;
      queryClient.removeQueries({ queryKey: uaoQueryKeys.workspace() });
      setWorkspaceTarget(next);
    },
    [queryClient, target],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {hasServer ? (
        <div
          role="radiogroup"
          aria-label="Workspace runs on"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-ui-xs"
        >
          <span className="text-muted-foreground">Workspace runs on</span>
          {WORKSPACE_TARGETS.map((option) => (
            <Button
              key={option.id}
              role="radio"
              aria-checked={target === option.id}
              variant={target === option.id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => choose(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <UaoWorkspacesPaneForTarget key={target} active={active} />
      </div>
    </div>
  );
}
