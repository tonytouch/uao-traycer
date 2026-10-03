import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  FolderGit2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Square,
  Terminal as TerminalIcon,
  XCircle,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import { uaoQueryOptions } from "@/lib/uao/query-options";
import {
  createOrcaTerminal,
  openOrca,
  sendOrcaTerminalInput,
  type OrcaAllowedAgent,
  type OrcaOpenResult,
  type OrcaRepo,
  type OrcaTerminalCreateResult,
  type OrcaTerminalSendResult,
  type OrcaTerminalSummary,
  type OrcaWorktree,
} from "@/lib/uao/orca-adapter";
import { cn } from "@/lib/utils";

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

const AGENT_OPTIONS: readonly { readonly id: OrcaAllowedAgent; readonly label: string }[] = [
  { id: "shell", label: "Shell (Default)" },
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "hermes", label: "Hermes" },
];

const EMPTY_REPOS: readonly OrcaRepo[] = [];
const EMPTY_WORKTREES: readonly OrcaWorktree[] = [];
const EMPTY_TERMINALS: readonly OrcaTerminalSummary[] = [];

interface LastReceiptState {
  readonly handle: string;
  readonly accepted: boolean;
  readonly turnStarted: boolean;
  readonly requestId: string | undefined;
  readonly warnings: readonly string[] | undefined;
  readonly error: string | undefined;
}

function createSendReceipt(
  terminal: string,
  data: OrcaTerminalSendResult,
): LastReceiptState {
  const promptStages = data.send?.prompt?.stages ?? [];
  const turnStarted = promptStages.includes("turn_started");
  return {
    handle: terminal,
    accepted: data.send?.accepted ?? data.ok,
    turnStarted,
    requestId: data.send?.prompt?.requestId,
    warnings: data.warnings,
    error: data.error ?? (data.send?.accepted === false ? data.send.refusedReason : undefined),
  };
}

function createErrorReceipt(
  terminal: string,
  errorMessage: string,
): LastReceiptState {
  return {
    handle: terminal,
    accepted: false,
    turnStarted: false,
    requestId: undefined,
    warnings: undefined,
    error: errorMessage,
  };
}

function receiptForHandle(receipt: LastReceiptState | null, handle: string | null): LastReceiptState | null {
  return receipt?.handle === handle ? receipt : null;
}

function creationMessage(error: Error | null, result: OrcaTerminalCreateResult | undefined): string | undefined {
  return error?.message ?? result?.terminal?.warning;
}

function OrcaQueryError({ errors }: { readonly errors: readonly (Error | null)[] }) {
  const error = errors.find(Boolean);
  return error ? <p role="alert" className="px-4 py-2 text-ui-xs text-destructive">{error.message}</p> : null;
}

function getReceiptBannerClasses(receipt: LastReceiptState): string {
  if (receipt.error !== undefined || !receipt.accepted) {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (receipt.turnStarted) {
    return "border-success/30 bg-success/10 text-success";
  }
  return "border-info/30 bg-info/10 text-info";
}

function getTerminalStatusBadgeVariant(
  status: string | undefined,
): "success" | "destructive" {
  if (status === "running") {
    return "success";
  }
  return "destructive";
}

function matchesWorktree(
  worktree: OrcaWorktree,
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
  if (worktree.status !== undefined && worktree.status.toLowerCase().includes(q)) return true;
  if (String(worktree.liveTerminalCount).includes(q)) return true;
  return false;
}

function findActiveWorktree(
  worktrees: readonly OrcaWorktree[],
  selectedId: string | null,
): OrcaWorktree | undefined {
  if (selectedId !== null) {
    const match = worktrees.find((w) => w.worktreeId === selectedId);
    if (match) return match;
  }
  return worktrees.at(0);
}

function findActiveTerminal(
  terminals: readonly OrcaTerminalSummary[],
  selectedHandle: string | null,
): OrcaTerminalSummary | undefined {
  if (selectedHandle !== null) {
    const match = terminals.find((t) => t.handle === selectedHandle);
    if (match) return match;
  }
  return terminals.at(0);
}

function checkSessionUnusable(
  terminal: OrcaTerminalSummary | undefined,
  screenStatus: string | undefined,
): boolean {
  if (!terminal) return true;
  if (!terminal.connected) return true;
  if (!terminal.writable) return true;
  if (screenStatus !== "running") return true;
  return false;
}

interface OrcaSubHeaderProps {
  readonly isReachable: boolean;
  readonly runtimeState: string;
  readonly appVersion: string | undefined;
  readonly isOpenPending: boolean;
  readonly isStatusFetching: boolean;
  readonly onOpen: () => void;
  readonly onRefresh: () => void;
}

function OrcaSubHeader(props: OrcaSubHeaderProps) {
  const {
    isReachable,
    runtimeState,
    appVersion,
    isOpenPending,
    isStatusFetching,
    onOpen,
    onRefresh,
  } = props;

  const versionLabel = appVersion !== undefined ? appVersion : "version unknown";
  const statusLabel = isReachable
    ? `Orca live (${versionLabel})`
    : `Orca offline (${runtimeState})`;

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/30 bg-card/40 px-4 py-2">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Boxes className="size-4 text-primary" />
          <span className="font-heading text-ui-sm font-semibold text-foreground">
            Orca Workspaces & Agent Terminals
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
              <AgentSpinningDots tone="primary" />
            ) : (
              <Play className="size-3" />
            )}
            <span>Start Orca Runtime</span>
          </Button>
        )}

        <Button
          variant="ghost"
          size="xs"
          onClick={onRefresh}
          disabled={isStatusFetching}
          aria-label="Refresh Orca status"
        >
          {isStatusFetching ? (
            <AgentSpinningDots tone="muted" />
          ) : (
            <RefreshCw className="size-3 text-muted-foreground" />
          )}
          <span className="text-micro text-muted-foreground">Refresh</span>
        </Button>
      </div>
    </div>
  );
}

interface OrcaOfflineCardProps {
  readonly runtimeState: string;
  readonly isOpenPending: boolean;
  readonly openError: string | undefined;
  readonly onOpen: () => void;
}

function OrcaOfflineCard(props: OrcaOfflineCardProps) {
  const { runtimeState, isOpenPending, openError, onOpen } = props;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="max-w-md rounded-lg border border-border/40 bg-card/60 p-6 shadow-sm">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full border border-warning/30 bg-warning/10">
          <AlertTriangle className="size-6 text-warning" />
        </div>
        <h2 className="mb-2 font-heading text-ui-base font-semibold text-foreground">
          Orca Runtime Offline
        </h2>
        <p className="mb-4 text-ui-xs text-muted-foreground">
          Orca is not currently reachable (state:{" "}
          <code className="font-mono text-micro text-foreground/80">
            {runtimeState}
          </code>
          ). Read-only queries do not auto-start Orca. Click below to launch or
          connect the local Orca runtime.
        </p>
        <Button
          variant="default"
          size="sm"
          onClick={onOpen}
          disabled={isOpenPending}
          className="w-full"
        >
          {isOpenPending ? (
            <AgentSpinningDots tone="primary" />
          ) : (
            <Play className="size-3.5" />
          )}
          <span>Start Orca Runtime</span>
        </Button>
        {openError !== undefined && (
          <p className="mt-3 text-micro text-destructive">
            Orca: {openError}
          </p>
        )}
      </div>
    </div>
  );
}

interface OrcaWorktreeItemProps {
  readonly worktree: OrcaWorktree;
  readonly isSelected: boolean;
  readonly onSelect: (id: string) => void;
}

function OrcaWorktreeItem(props: OrcaWorktreeItemProps) {
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
          <Badge variant="outline" size="xs">{worktree.status ?? "unknown"}</Badge>
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

interface OrcaWorkspacesSidebarProps {
  readonly repos: readonly OrcaRepo[];
  readonly worktrees: readonly OrcaWorktree[];
  readonly search: string;
  readonly selectedRepoFilter: string;
  readonly resolvedWorktreeId: string | null;
  readonly isFetching: boolean;
  readonly onSearchChange: (value: string) => void;
  readonly onRepoFilterChange: (value: string) => void;
  readonly onSelectWorktree: (id: string) => void;
}

function OrcaWorkspacesSidebar(props: OrcaWorkspacesSidebarProps) {
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
            htmlFor="orca-repo-filter"
            className="shrink-0 font-mono text-micro text-muted-foreground"
          >
            Repo:
          </label>
          <select
            id="orca-repo-filter"
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
          {isFetching ? <AgentSpinningDots tone="muted" /> : null}
        </div>

        {worktrees.length === 0 ? (
          <div className="p-4 text-center text-ui-xs text-muted-foreground">
            No matching workspaces found.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {worktrees.map((wt) => (
              <OrcaWorktreeItem
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

interface OrcaTerminalItemProps {
  readonly terminal: OrcaTerminalSummary;
  readonly isSelected: boolean;
  readonly onSelect: (handle: string) => void;
}

function OrcaTerminalItem(props: OrcaTerminalItemProps) {
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
        {terminal.exitCause ? (
          <Badge variant="destructive" size="xs">
            {terminal.exitCause}
          </Badge>
        ) : null}
      </div>

      {terminal.preview ? <div className="mt-1 truncate font-mono text-micro text-muted-foreground/70">
          {terminal.preview}
        </div> : null}
    </button>
  );
}

interface OrcaTerminalsSidebarProps {
  readonly terminals: readonly OrcaTerminalSummary[];
  readonly selectedTerminalHandle: string | null;
  readonly resolvedWorktreeId: string | null;
  readonly agentChoice: OrcaAllowedAgent;
  readonly isCreating: boolean;
  readonly createError: string | undefined;
  readonly onSelectTerminal: (handle: string) => void;
  readonly onAgentChoiceChange: (agent: OrcaAllowedAgent) => void;
  readonly onCreateTerminal: () => void;
}

function OrcaTerminalsSidebar(props: OrcaTerminalsSidebarProps) {
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
          <label htmlFor="orca-new-term-agent" className="sr-only">
            Agent choice
          </label>
          <select
            id="orca-new-term-agent"
            aria-label="Select agent type for new terminal"
            value={agentChoice}
            onChange={(e) =>
              onAgentChoiceChange(e.currentTarget.value as OrcaAllowedAgent)
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
              <AgentSpinningDots tone="primary" />
            ) : (
              <Plus className="size-3" />
            )}
            <span>New</span>
          </Button>
        </div>

        {createError !== undefined && (
          <p className="text-micro text-destructive">
            Orca: {createError}
          </p>
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
              <OrcaTerminalItem
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

interface OrcaScreenHeaderProps {
  readonly terminalTitle: string;
  readonly source: string;
  readonly status: string;
  readonly statusBadgeVariant: "success" | "destructive";
  readonly isTruncated: boolean;
  readonly isFetching: boolean;
  readonly onRefresh: () => void;
}

function OrcaScreenHeader(props: OrcaScreenHeaderProps) {
  const {
    terminalTitle,
    source,
    status,
    statusBadgeVariant,
    isTruncated,
    isFetching,
    onRefresh,
  } = props;

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border/30 bg-card/60 px-4 py-2 text-micro">
      <div className="flex items-center gap-2">
        <TerminalIcon className="size-3.5 text-primary" />
        <span className="font-heading font-semibold text-foreground">
          {terminalTitle}
        </span>
        <Badge variant="outline" size="xs">
          source: {source}
        </Badge>
        <Badge variant={statusBadgeVariant} size="xs">
          status: {status}
        </Badge>
        {isTruncated ? (
          <Badge variant="warning" size="xs">
            Truncated (limit 300)
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center gap-2 font-mono text-muted-foreground">
        <span>{isFetching ? "Refreshing…" : "Screen polled"}</span>
        <Button
          variant="ghost"
          size="xs"
          onClick={onRefresh}
          disabled={isFetching}
          aria-label="Refresh terminal screen"
        >
          {isFetching ? <AgentSpinningDots tone="muted" /> : <RefreshCw className="size-3" />}
        </Button>
      </div>
    </div>
  );
}

interface OrcaReceiptBannerProps {
  readonly receipt: LastReceiptState;
  readonly onDismiss: () => void;
}

function OrcaReceiptBanner(props: OrcaReceiptBannerProps) {
  const { receipt, onDismiss } = props;

  function renderReceiptContent() {
    if (receipt.error !== undefined || !receipt.accepted) {
      return (
        <>
          <XCircle className="size-3" />
          <span>Send failed: {receipt.error ?? "Input was not accepted"}</span>
        </>
      );
    }
    if (receipt.turnStarted) {
      return (
        <>
          <CheckCircle2 className="size-3" />
          <span>Turn started (Receipt: {receipt.requestId ?? "received"})</span>
        </>
      );
    }
    return (
      <>
        <CheckCircle2 className="size-3" />
        <span>Input accepted</span>
      </>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center justify-between border-t px-4 py-1.5 text-micro",
        getReceiptBannerClasses(receipt),
      )}
    >
      <div className="flex items-center gap-2">
        {renderReceiptContent()}
        {receipt.warnings !== undefined && receipt.warnings.length > 0 && (
          <span className="font-semibold text-warning">
            [Warning: {receipt.warnings.join("; ")}]
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onDismiss}
        className="text-muted-foreground hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}

interface OrcaComposerProps {
  readonly currentDraft: string;
  readonly isSessionUnusable: boolean;
  readonly isSendPending: boolean;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: () => void;
  readonly onInterrupt: () => void;
}

function OrcaComposer(props: OrcaComposerProps) {
  const {
    currentDraft,
    isSessionUnusable,
    isSendPending,
    onDraftChange,
    onSend,
    onInterrupt,
  } = props;

  const canSend = !isSessionUnusable && !isSendPending && currentDraft.trim().length > 0;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border/40 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="orca-terminal-prompt-composer" className="sr-only">
          Command or prompt
        </label>
        <input
          id="orca-terminal-prompt-composer"
          type="text"
          value={currentDraft}
          onChange={(e) => onDraftChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && canSend) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={isSessionUnusable || isSendPending}
          placeholder={
            isSessionUnusable
              ? "Session disconnected / unwritable"
              : "Type a prompt or command (Enter to send)…"
          }
          className="flex-1 rounded-md border border-border/60 bg-foreground/5 px-3 py-1.5 font-mono text-ui-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />

        <Button
          variant="default"
          size="sm"
          onClick={onSend}
          disabled={!canSend}
        >
          {isSendPending ? (
            <AgentSpinningDots tone="primary" />
          ) : (
            <Send className="size-3.5" />
          )}
          <span>Send</span>
        </Button>

        <Button
          variant="destructive-ghost"
          size="sm"
          onClick={onInterrupt}
          disabled={isSessionUnusable || isSendPending}
          aria-label="Send interrupt signal"
        >
          <Square className="size-3" />
          <span>Interrupt</span>
        </Button>
      </div>
    </div>
  );
}

interface OrcaTerminalScreenViewerProps {
  readonly activeTerminal: OrcaTerminalSummary | undefined;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly errorMessage: string | undefined;
  readonly tail: readonly string[] | undefined;
  readonly source: string | undefined;
  readonly status: string | undefined;
  readonly truncated: boolean | undefined;
  readonly isTerminalSessionUnusable: boolean;
  readonly lastReceipt: LastReceiptState | null;
  readonly currentDraft: string;
  readonly isSendPending: boolean;
  readonly onRefetch: () => void;
  readonly onDismissReceipt: () => void;
  readonly onDraftChange: (text: string) => void;
  readonly onSend: () => void;
  readonly onInterrupt: () => void;
}

function OrcaTerminalScreenViewer(props: OrcaTerminalScreenViewerProps) {
  const {
    activeTerminal,
    isFetching,
    isError,
    errorMessage,
    tail,
    source,
    status,
    truncated,
    isTerminalSessionUnusable,
    lastReceipt,
    currentDraft,
    isSendPending,
    onRefetch,
    onDismissReceipt,
    onDraftChange,
    onSend,
    onInterrupt,
  } = props;

  if (!activeTerminal) {
    return (
      <main
        aria-label="Terminal screen and composer"
        className="flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center text-ui-sm text-muted-foreground"
      >
        Select a terminal or create a new one to inspect its rendered screen.
      </main>
    );
  }

  const resolvedSource = source !== undefined ? source : "unknown";
  const defaultStatus = activeTerminal.connected ? "running" : "disconnected";
  const resolvedStatus = status !== undefined ? status : defaultStatus;

  function renderScreenContent() {
    if (isError) {
      return (
        <div className="text-destructive">
          Failed to read screen: {errorMessage ?? "Unknown error"}
        </div>
      );
    }
    if (tail !== undefined && tail.length > 0) {
      return <pre className="whitespace-pre-wrap">{tail.join("\n")}</pre>;
    }
    return (
      <div className="text-muted-foreground">
        (No screen output rendered yet)
      </div>
    );
  }

  return (
    <main
      aria-label="Terminal screen and composer"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div className="flex h-full flex-col overflow-hidden">
        <OrcaScreenHeader
          terminalTitle={activeTerminal.title || activeTerminal.handle}
          source={resolvedSource}
          status={resolvedStatus}
          statusBadgeVariant={getTerminalStatusBadgeVariant(resolvedStatus)}
          isTruncated={truncated === true}
          isFetching={isFetching}
          onRefresh={onRefetch}
        />

        {isTerminalSessionUnusable ? (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-ui-xs text-warning"
          >
            <AlertTriangle className="size-3.5" />
            <span>
              Terminal session is disconnected, unwritable, or exited. Input
              controls are disabled.
            </span>
          </div>
        ) : null}

        <div
          role="region"
          aria-label="Rendered screen content"
          className="flex-1 overflow-auto bg-black p-3 font-mono text-ui-xs text-success select-text"
        >
          {renderScreenContent()}
        </div>

        {lastReceipt ? <OrcaReceiptBanner receipt={lastReceipt} onDismiss={onDismissReceipt} /> : null}

        <OrcaComposer
          currentDraft={currentDraft}
          isSessionUnusable={isTerminalSessionUnusable}
          isSendPending={isSendPending}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onInterrupt={onInterrupt}
        />
      </div>
    </main>
  );
}

interface OrcaWorkspacesConnectedPaneProps {
  readonly active: boolean;
  readonly appVersion: string | undefined;
  readonly runtimeState: string;
  readonly isOpenPending: boolean;
  readonly isStatusFetching: boolean;
  readonly onOpenOrca: () => void;
  readonly onRefetchStatus: () => void;
}

function OrcaWorkspacesConnectedPane(props: OrcaWorkspacesConnectedPaneProps) {
  const queryClient = useQueryClient();
  const {
    appVersion,
    runtimeState,
    isOpenPending,
    isStatusFetching,
    onOpenOrca,
    onRefetchStatus,
  } = props;

  const isPageVisible = usePageVisibility() && props.active;

  // 1. Repos & Worktrees
  const {
    data: reposData,
    error: reposError,
    refetch: refetchRepos,
  } = useQuery(uaoQueryOptions.orcaRepos(isPageVisible));

  const {
    data: worktreesData,
    error: worktreesError,
    isFetching: isWorktreesFetching,
    refetch: refetchWorktrees,
  } = useQuery(uaoQueryOptions.orcaWorktrees(isPageVisible));

  const repos: readonly OrcaRepo[] = reposData ?? EMPTY_REPOS;
  const worktrees: readonly OrcaWorktree[] = worktreesData ?? EMPTY_WORKTREES;

  // Filter & Search State
  const [search, setSearch] = useState("");
  const [selectedRepoFilter, setSelectedRepoFilter] = useState("all");
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string | null>(
    null,
  );
  const [selectedTerminalHandle, setSelectedTerminalHandle] = useState<
    string | null
  >(null);
  const [draftsByHandle, setDraftsByHandle] = useState<Record<string, string>>(
    {},
  );
  const [agentChoice, setAgentChoice] = useState<OrcaAllowedAgent>("shell");
  const [lastReceipt, setLastReceipt] = useState<LastReceiptState | null>(null);

  const filteredWorktrees = useMemo(() => {
    const trimmed = search.trim();
    return worktrees.filter((w) =>
      matchesWorktree(w, selectedRepoFilter, trimmed),
    );
  }, [worktrees, selectedRepoFilter, search]);

  const activeWorktree = useMemo((): OrcaWorktree | undefined => {
    return findActiveWorktree(filteredWorktrees, selectedWorktreeId);
  }, [filteredWorktrees, selectedWorktreeId]);

  const resolvedWorktreeId = activeWorktree ? activeWorktree.worktreeId : null;

  // 2. Terminals for Selected Workspace
  const {
    data: terminalsData,
    error: terminalsError,
  } = useQuery({ ...uaoQueryOptions.orcaTerminals(resolvedWorktreeId), enabled: isPageVisible });
  const terminals: readonly OrcaTerminalSummary[] =
    terminalsData ?? EMPTY_TERMINALS;

  const activeTerminal = useMemo((): OrcaTerminalSummary | undefined => {
    return findActiveTerminal(terminals, selectedTerminalHandle);
  }, [terminals, selectedTerminalHandle]);

  const resolvedTerminalHandle = activeTerminal ? activeTerminal.handle : null;

  // 3. Terminal Rendered Screen
  const {
    data: screenData,
    isFetching: isScreenFetching,
    isError: isScreenError,
    error: screenError,
    refetch: refetchScreen,
  } = useQuery(
    uaoQueryOptions.orcaTerminalScreen(resolvedTerminalHandle, isPageVisible),
  );

  const currentDraft =
    resolvedTerminalHandle !== null
      ? (draftsByHandle[resolvedTerminalHandle] ?? "")
      : "";

  const handleDraftChange = useCallback(
    (text: string) => {
      if (resolvedTerminalHandle === null) return;
      setDraftsByHandle((prev) => ({
        ...prev,
        [resolvedTerminalHandle]: text,
      }));
    },
    [resolvedTerminalHandle],
  );

  // 4. Send Input Mutation (never auto-retry)
  const {
    mutate: mutateSend,
    isPending: isSendPending,
  } = useMutation<
    OrcaTerminalSendResult,
    Error,
    {
      readonly terminal: string;
      readonly text: string | undefined;
      readonly enter: boolean | undefined;
      readonly interrupt: boolean | undefined;
    }
  >({
    mutationKey: uaoQueryKeys.orcaTerminalSendMutation(),
    retry: false,
    mutationFn: async (payload) => {
      return sendOrcaTerminalInput(payload, undefined);
    },
    onSuccess: (data, variables) => {
      if (
        data.ok &&
        variables.text !== undefined &&
        variables.terminal !== ""
      ) {
        setDraftsByHandle((prev) => ({
          ...prev,
          [variables.terminal]: prev[variables.terminal] === variables.text ? "" : (prev[variables.terminal] ?? ""),
        }));
      }
      setLastReceipt(createSendReceipt(variables.terminal, data));
      void refetchScreen();
    },
    onError: (err, variables) => {
      setLastReceipt(
        createErrorReceipt(variables.terminal, `${err.message}. Delivery may be uncertain; inspect the screen before resending.`),
      );
    },
  });

  // 5. Create Terminal Mutation
  const {
    mutate: mutateCreateTerminal,
    data: createResult,
    isPending: isCreateTerminalPending,
    error: createTerminalError,
  } = useMutation<
    OrcaTerminalCreateResult,
    Error,
    {
      readonly worktree: string;
      readonly agent: OrcaAllowedAgent;
    }
  >({
    mutationKey: uaoQueryKeys.orcaTerminalCreateMutation(),
    retry: false,
    mutationFn: async (payload) => {
      return createOrcaTerminal(payload, undefined);
    },
    onSuccess: async (data, variables) => {
      const workspaceId = variables.worktree.slice(3);
      await queryClient.invalidateQueries({ queryKey: uaoQueryKeys.orcaTerminals(workspaceId) });
      if (data.terminal?.handle && resolvedWorktreeId === workspaceId) {
        setSelectedTerminalHandle(data.terminal.handle);
      }
    },
  });

  const isTerminalSessionUnusable = checkSessionUnusable(
    activeTerminal,
    screenData?.status,
  );

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

  const handleSendDraft = useCallback(() => {
    if (resolvedTerminalHandle !== null && currentDraft.trim().length > 0) {
      mutateSend({
        terminal: resolvedTerminalHandle,
        text: currentDraft,
        enter: true,
        interrupt: undefined,
      });
    }
  }, [resolvedTerminalHandle, currentDraft, mutateSend]);

  const handleInterrupt = useCallback(() => {
    if (resolvedTerminalHandle !== null) {
      mutateSend({
        terminal: resolvedTerminalHandle,
        text: undefined,
        enter: undefined,
        interrupt: true,
      });
    }
  }, [resolvedTerminalHandle, mutateSend]);

  const handleDismissReceipt = useCallback(() => {
    setLastReceipt(null);
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <OrcaSubHeader
        isReachable
        runtimeState={runtimeState}
        appVersion={appVersion}
        isOpenPending={isOpenPending}
        isStatusFetching={isStatusFetching}
        onOpen={onOpenOrca}
        onRefresh={handleRefresh}
      />

      <OrcaQueryError errors={[reposError, worktreesError, terminalsError]} />

      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <OrcaWorkspacesSidebar
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

        <OrcaTerminalsSidebar
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

        <OrcaTerminalScreenViewer
          activeTerminal={activeTerminal}
          isFetching={isScreenFetching}
          isError={isScreenError}
          errorMessage={screenError?.message}
          tail={screenData?.tail}
          source={screenData?.source}
          status={screenData?.status}
          truncated={screenData?.truncated}
          isTerminalSessionUnusable={isTerminalSessionUnusable}
          lastReceipt={receiptForHandle(lastReceipt, resolvedTerminalHandle)}
          currentDraft={currentDraft}
          isSendPending={isSendPending}
          onRefetch={() => void refetchScreen()}
          onDismissReceipt={handleDismissReceipt}
          onDraftChange={handleDraftChange}
          onSend={handleSendDraft}
          onInterrupt={handleInterrupt}
        />
      </div>
    </div>
  );
}

export function UaoOrcaWorkspacesPane({ active }: { readonly active: boolean }) {
  const queryClient = useQueryClient();

  const {
    data: statusData,
    error: statusError,
    isFetching: isStatusFetching,
    refetch: refetchStatus,
  } = useQuery({ ...uaoQueryOptions.orcaStatus(), enabled: active });

  const runtime = statusData?.result?.runtime;
  const isReachable = runtime?.reachable === true;
  const runtimeState = runtime?.state ?? (isStatusFetching ? "checking" : "unknown");

  const {
    mutate: mutateOpen,
    isPending: isOpenPending,
    error: openError,
  } = useMutation<OrcaOpenResult>({
    mutationKey: uaoQueryKeys.orcaOpenMutation(),
    retry: false,
    mutationFn: async () => {
      return openOrca(undefined);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.orcaStatus(),
      });
      await queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.orcaWorktrees(),
      });
      await queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.orcaRepos(),
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
        <OrcaSubHeader
          isReachable={false}
          runtimeState={runtimeState}
          appVersion={runtime?.appVersion}
          isOpenPending={isOpenPending}
          isStatusFetching={isStatusFetching}
          onOpen={handleOpen}
          onRefresh={handleRefreshStatus}
        />
        <OrcaOfflineCard
          runtimeState={runtimeState}
          isOpenPending={isOpenPending}
          openError={openError?.message ?? statusError?.message}
          onOpen={handleOpen}
        />
      </div>
    );
  }

  return (
    <OrcaWorkspacesConnectedPane
      active={active}
      appVersion={runtime.appVersion}
      runtimeState={runtimeState}
      isOpenPending={isOpenPending}
      isStatusFetching={isStatusFetching}
      onOpenOrca={handleOpen}
      onRefetchStatus={handleRefreshStatus}
    />
  );
}
