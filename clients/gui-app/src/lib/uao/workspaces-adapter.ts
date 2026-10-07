import { fetchJson } from "./adapter";

import { getWorkspaceTarget, workspaceApiPrefix } from "./workspaces-target";

export type WorkspaceAgent = "shell" | "claude" | "codex" | "hermes";

export interface WorkspaceRuntimeStatus {
  readonly reachable?: boolean | undefined;
  readonly state?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly connectionState?: string | undefined;
  readonly runtimeId?: string | undefined;
}

export interface WorkspaceStatusResult {
  readonly ok: boolean;
  readonly result?: {
    readonly runtime?: WorkspaceRuntimeStatus | undefined;
    readonly app?: {
      readonly running?: boolean | undefined;
    } | undefined;
  } | undefined;
  readonly error?: string | undefined;
}

export interface WorkspaceOpenResult {
  readonly ok: boolean;
  readonly open?: unknown;
  readonly status?: unknown;
  readonly error?: string | undefined;
}

export interface WorkspaceRepo {
  readonly id: string;
  readonly displayName: string;
  readonly path: string;
  readonly kind?: string | undefined;
}

export interface WorkspaceAgentStatus {
  readonly paneKey: string;
  readonly agentType: string | null;
  readonly state: string;
}

export interface WorkspaceWorktree {
  readonly worktreeId: string;
  readonly repo: string;
  readonly repoId: string;
  readonly path: string;
  readonly branch: string;
  readonly displayName: string;
  readonly workspaceStatus?: string | undefined;
  readonly status?: string | undefined;
  readonly liveTerminalCount: number;
  readonly agents?: readonly WorkspaceAgentStatus[] | undefined;
  readonly lastActivityAt?: number | null | undefined;
}

export interface WorkspaceTerminalSummary {
  readonly handle: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly title: string | null;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly lastOutputAt: number | null;
  readonly preview: string;
  readonly agentIdentity?: string | undefined;
  readonly exitCause?: string | undefined;
}

export interface WorkspaceTerminalRead {
  readonly handle: string;
  readonly status: "running" | "exited" | "unknown";
  readonly tail: readonly string[];
  readonly truncated: boolean;
  readonly limited?: boolean | undefined;
  readonly source?: "stream" | "screen" | "screen-unavailable" | undefined;
}

export interface WorkspaceTerminalPromptDelivery {
  readonly requestId: string;
  readonly stages: readonly string[];
  readonly provider?: string | undefined;
  readonly observation?: string | undefined;
}

export interface WorkspaceTerminalSendReceipt {
  readonly handle: string;
  readonly accepted: boolean;
  readonly bytesWritten: number;
  readonly refusedReason?: string | undefined;
  readonly prompt?: WorkspaceTerminalPromptDelivery | undefined;
}

export interface WorkspaceTerminalSendResult {
  readonly ok: boolean;
  readonly send?: WorkspaceTerminalSendReceipt | undefined;
  readonly warnings?: readonly string[] | undefined;
  readonly error?: string | undefined;
}

export interface WorkspaceTerminalCreateResult {
  readonly ok: boolean;
  readonly terminal?: {
    readonly handle: string;
    readonly worktreeId?: string | undefined;
    readonly warning?: string | undefined;
  } | undefined;
  readonly error?: string | undefined;
}

export async function fetchWorkspaceStatus(
  signal: AbortSignal | undefined,
): Promise<WorkspaceStatusResult> {
  return fetchJson<WorkspaceStatusResult>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/status`,
    signal === undefined ? undefined : { signal },
  );
}

export async function openWorkspace(
  signal: AbortSignal | undefined,
): Promise<WorkspaceOpenResult> {
  return fetchJson<WorkspaceOpenResult>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
    },
  );
}

export async function fetchWorkspaceRepos(
  signal: AbortSignal | undefined,
): Promise<readonly WorkspaceRepo[]> {
  const data = await fetchJson<{ readonly repos?: readonly WorkspaceRepo[] }>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/repos`,
    signal === undefined ? undefined : { signal },
  );
  return data.repos ?? [];
}

export async function fetchWorkspaceWorktrees(
  signal: AbortSignal | undefined,
): Promise<readonly WorkspaceWorktree[]> {
  const data = await fetchJson<{ readonly worktrees?: readonly WorkspaceWorktree[] }>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/worktrees`,
    signal === undefined ? undefined : { signal },
  );
  return data.worktrees ?? [];
}

export async function fetchWorkspaceTerminals(
  worktreeSelector: string,
  signal: AbortSignal | undefined,
): Promise<readonly WorkspaceTerminalSummary[]> {
  const qs = new URLSearchParams({ worktree: worktreeSelector });
  const data = await fetchJson<{ readonly terminals?: readonly WorkspaceTerminalSummary[] }>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/terminals?${qs.toString()}`,
    signal === undefined ? undefined : { signal },
  );
  return data.terminals ?? [];
}

export async function readWorkspaceTerminalScreen(
  terminalHandle: string,
  limit: number | undefined,
  signal: AbortSignal | undefined,
): Promise<WorkspaceTerminalRead> {
  const qs = new URLSearchParams({
    terminal: terminalHandle,
    limit: String(limit ?? 300),
  });
  const data = await fetchJson<{ readonly terminal: WorkspaceTerminalRead }>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/terminal/read?${qs.toString()}`,
    signal === undefined ? undefined : { signal },
  );
  return data.terminal;
}

export interface SendWorkspaceTerminalInputOptions {
  readonly terminal: string;
  readonly text?: string | undefined;
  readonly enter?: boolean | undefined;
  readonly interrupt?: boolean | undefined;
}

export async function sendWorkspaceTerminalInput(
  options: SendWorkspaceTerminalInputOptions,
  signal: AbortSignal | undefined,
): Promise<WorkspaceTerminalSendResult> {
  return fetchJson<WorkspaceTerminalSendResult>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/terminal/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        terminal: options.terminal,
        text: options.text,
        enter: options.enter,
        interrupt: options.interrupt,
      }),
      signal,
    },
  );
}

export interface CreateWorkspaceTerminalOptions {
  readonly worktree: string;
  readonly agent?: "shell" | "claude" | "codex" | "hermes" | undefined;
}

export async function createWorkspaceTerminal(
  options: CreateWorkspaceTerminalOptions,
  signal: AbortSignal | undefined,
): Promise<WorkspaceTerminalCreateResult> {
  return fetchJson<WorkspaceTerminalCreateResult>(
    `${workspaceApiPrefix(getWorkspaceTarget())}/terminal/create`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worktree: options.worktree,
        agent: options.agent,
      }),
      signal,
    },
  );
}
