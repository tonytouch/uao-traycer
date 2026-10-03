import { fetchJson } from "./adapter";

const ORCA_API_PREFIX = "/uao-api/orca";

export type OrcaAllowedAgent = "shell" | "claude" | "codex" | "hermes";

export interface OrcaRuntimeStatus {
  readonly reachable?: boolean | undefined;
  readonly state?: string | undefined;
  readonly appVersion?: string | undefined;
  readonly connectionState?: string | undefined;
  readonly runtimeId?: string | undefined;
}

export interface OrcaStatusResult {
  readonly ok: boolean;
  readonly result?: {
    readonly runtime?: OrcaRuntimeStatus | undefined;
    readonly app?: {
      readonly running?: boolean | undefined;
    } | undefined;
  } | undefined;
  readonly error?: string | undefined;
}

export interface OrcaOpenResult {
  readonly ok: boolean;
  readonly open?: unknown;
  readonly status?: unknown;
  readonly error?: string | undefined;
}

export interface OrcaRepo {
  readonly id: string;
  readonly displayName: string;
  readonly path: string;
  readonly kind?: string | undefined;
}

export interface OrcaAgentStatus {
  readonly paneKey: string;
  readonly agentType: string | null;
  readonly state: string;
}

export interface OrcaWorktree {
  readonly worktreeId: string;
  readonly repo: string;
  readonly repoId: string;
  readonly path: string;
  readonly branch: string;
  readonly displayName: string;
  readonly workspaceStatus?: string | undefined;
  readonly status?: string | undefined;
  readonly liveTerminalCount: number;
  readonly agents?: readonly OrcaAgentStatus[] | undefined;
  readonly lastActivityAt?: number | null | undefined;
}

export interface OrcaTerminalSummary {
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

export interface OrcaTerminalRead {
  readonly handle: string;
  readonly status: "running" | "exited" | "unknown";
  readonly tail: readonly string[];
  readonly truncated: boolean;
  readonly limited?: boolean | undefined;
  readonly source?: "stream" | "screen" | "screen-unavailable" | undefined;
}

export interface OrcaTerminalPromptDelivery {
  readonly requestId: string;
  readonly stages: readonly string[];
  readonly provider?: string | undefined;
  readonly observation?: string | undefined;
}

export interface OrcaTerminalSendReceipt {
  readonly handle: string;
  readonly accepted: boolean;
  readonly bytesWritten: number;
  readonly refusedReason?: string | undefined;
  readonly prompt?: OrcaTerminalPromptDelivery | undefined;
}

export interface OrcaTerminalSendResult {
  readonly ok: boolean;
  readonly send?: OrcaTerminalSendReceipt | undefined;
  readonly warnings?: readonly string[] | undefined;
  readonly error?: string | undefined;
}

export interface OrcaTerminalCreateResult {
  readonly ok: boolean;
  readonly terminal?: {
    readonly handle: string;
    readonly worktreeId?: string | undefined;
    readonly warning?: string | undefined;
  } | undefined;
  readonly error?: string | undefined;
}

export async function fetchOrcaStatus(
  signal: AbortSignal | undefined,
): Promise<OrcaStatusResult> {
  return fetchJson<OrcaStatusResult>(
    `${ORCA_API_PREFIX}/status`,
    signal === undefined ? undefined : { signal },
  );
}

export async function openOrca(
  signal: AbortSignal | undefined,
): Promise<OrcaOpenResult> {
  return fetchJson<OrcaOpenResult>(
    `${ORCA_API_PREFIX}/start`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
    },
  );
}

export async function fetchOrcaRepos(
  signal: AbortSignal | undefined,
): Promise<readonly OrcaRepo[]> {
  const data = await fetchJson<{ readonly repos?: readonly OrcaRepo[] }>(
    `${ORCA_API_PREFIX}/repos`,
    signal === undefined ? undefined : { signal },
  );
  return data.repos ?? [];
}

export async function fetchOrcaWorktrees(
  signal: AbortSignal | undefined,
): Promise<readonly OrcaWorktree[]> {
  const data = await fetchJson<{ readonly worktrees?: readonly OrcaWorktree[] }>(
    `${ORCA_API_PREFIX}/worktrees`,
    signal === undefined ? undefined : { signal },
  );
  return data.worktrees ?? [];
}

export async function fetchOrcaTerminals(
  worktreeSelector: string,
  signal: AbortSignal | undefined,
): Promise<readonly OrcaTerminalSummary[]> {
  const qs = new URLSearchParams({ worktree: worktreeSelector });
  const data = await fetchJson<{ readonly terminals?: readonly OrcaTerminalSummary[] }>(
    `${ORCA_API_PREFIX}/terminals?${qs.toString()}`,
    signal === undefined ? undefined : { signal },
  );
  return data.terminals ?? [];
}

export async function readOrcaTerminalScreen(
  terminalHandle: string,
  limit: number | undefined,
  signal: AbortSignal | undefined,
): Promise<OrcaTerminalRead> {
  const qs = new URLSearchParams({
    terminal: terminalHandle,
    limit: String(limit ?? 300),
  });
  const data = await fetchJson<{ readonly terminal: OrcaTerminalRead }>(
    `${ORCA_API_PREFIX}/terminal/read?${qs.toString()}`,
    signal === undefined ? undefined : { signal },
  );
  return data.terminal;
}

export interface SendOrcaTerminalInputOptions {
  readonly terminal: string;
  readonly text?: string | undefined;
  readonly enter?: boolean | undefined;
  readonly interrupt?: boolean | undefined;
}

export async function sendOrcaTerminalInput(
  options: SendOrcaTerminalInputOptions,
  signal: AbortSignal | undefined,
): Promise<OrcaTerminalSendResult> {
  return fetchJson<OrcaTerminalSendResult>(
    `${ORCA_API_PREFIX}/terminal/send`,
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

export interface CreateOrcaTerminalOptions {
  readonly worktree: string;
  readonly agent?: "shell" | "claude" | "codex" | "hermes" | undefined;
}

export async function createOrcaTerminal(
  options: CreateOrcaTerminalOptions,
  signal: AbortSignal | undefined,
): Promise<OrcaTerminalCreateResult> {
  return fetchJson<OrcaTerminalCreateResult>(
    `${ORCA_API_PREFIX}/terminal/create`,
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
