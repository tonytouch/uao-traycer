import { createSseParser, type HermesSSEEvent } from "./sse-parser";

export type { HermesSSEEvent };

const UAO_API_PREFIX = "/uao-api/api";

export type KanbanStatus =
  | "triage"
  | "todo"
  | "scheduled"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "archived";

export interface KanbanTask {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly assignee: string | null;
  readonly status: KanbanStatus;
  readonly priority: number | null;
  readonly tenant?: string | null | undefined;
  readonly workspace_kind?: string | null | undefined;
  readonly workspace_path?: string | null | undefined;
  readonly created_at: number;
  readonly started_at?: number | null | undefined;
  readonly completed_at?: number | null | undefined;
  readonly board_slug?: string | undefined;
  readonly last_failure_error?: string | null | undefined;
  readonly result?: string | null | undefined;
  readonly skills?: readonly string[] | undefined;
}

export interface KanbanBoard {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly db_path?: string | undefined;
  readonly is_current?: boolean | undefined;
  readonly counts?: Record<string, number> | undefined;
  readonly total?: number | undefined;
}

export interface KanbanComment {
  readonly author: string;
  readonly body: string;
  readonly created_at: number;
}

export interface KanbanEvent {
  readonly kind: string;
  readonly payload?: unknown;
  readonly created_at: number;
  readonly run_id?: number | null | undefined;
}

export interface KanbanRun {
  readonly id: number;
  readonly profile: string;
  readonly status: string;
  readonly outcome: string;
  readonly summary?: string | null | undefined;
  readonly error?: string | null | undefined;
  readonly started_at?: number | null | undefined;
  readonly ended_at?: number | null | undefined;
}

export interface KanbanTaskDetail {
  readonly task: KanbanTask;
  readonly latest_summary: string | null;
  readonly parents: readonly string[];
  readonly children: readonly string[];
  readonly comments: readonly KanbanComment[];
  readonly events: readonly KanbanEvent[];
  readonly runs?: readonly KanbanRun[] | undefined;
}

export interface ChatProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly streaming: boolean;
}

export const DEFAULT_CHAT_PROFILES: readonly ChatProviderProfile[] = [
  {
    id: "jarvis",
    label: "Jarvis",
    description: "Butler persona — default orchestrator",
    streaming: true,
  },
  {
    id: "spynel",
    label: "Spynel",
    description: "Durable tasks, execution and review",
    streaming: true,
  },
  {
    id: "hermes",
    label: "Hermes",
    description: "Hermes gateway — council + prime",
    streaming: true,
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI Codex CLI (fresh turn)",
    streaming: true,
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "Claude Code headless (fresh turn)",
    streaming: true,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    description: "Google Antigravity CLI (agy, fresh turn)",
    streaming: true,
  },
  {
    id: "mavis",
    label: "Mavis CLI",
    description: "Mavis CLI bridge (async dispatch)",
    streaming: false,
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode CLI (fresh turn)",
    streaming: true,
  },
];

export function newSessionId(): string {
  return `agentos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function fetchJson<T>(
  url: string,
  options: RequestInit | undefined,
): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (typeof body === "object" && body !== null) {
        const errObj = body as Record<string, unknown>;
        if (typeof errObj.message === "string") {
          msg = errObj.message;
        } else if (typeof errObj.error === "string") {
          msg = errObj.error;
        }
      }
    } catch {
      // non-JSON response body
    }
    throw new Error(msg);
  }
  const data: unknown = await res.json();
  return data as T;
}

export async function fetchKanbanBoards(
  signal: AbortSignal | undefined,
): Promise<readonly KanbanBoard[]> {
  const data = await fetchJson<{ readonly boards?: readonly KanbanBoard[] }>(
    `${UAO_API_PREFIX}/hermes/kanban/boards`,
    signal === undefined ? undefined : { signal },
  );
  return data.boards ?? [];
}

export interface FetchKanbanTasksOptions {
  readonly board: string | undefined;
  readonly status: string | undefined;
  readonly assignee: string | undefined;
}

export async function fetchKanbanTasks(
  options: FetchKanbanTasksOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<readonly KanbanTask[]> {
  const qs = new URLSearchParams();
  if (options?.board !== undefined) qs.set("board", options.board);
  if (options?.status !== undefined) qs.set("status", options.status);
  if (options?.assignee !== undefined) qs.set("assignee", options.assignee);
  const query = qs.toString();
  const url =
    query.length > 0
      ? `${UAO_API_PREFIX}/hermes/kanban/tasks?${query}`
      : `${UAO_API_PREFIX}/hermes/kanban/tasks`;
  const data = await fetchJson<{ readonly tasks?: readonly KanbanTask[] }>(
    url,
    signal === undefined ? undefined : { signal },
  );
  return data.tasks ?? [];
}

export async function fetchKanbanTask(
  id: string,
  board: string | undefined,
  signal: AbortSignal | undefined,
): Promise<KanbanTaskDetail> {
  const qs = board !== undefined ? `?board=${encodeURIComponent(board)}` : "";
  return fetchJson<KanbanTaskDetail>(
    `${UAO_API_PREFIX}/hermes/kanban/tasks/${encodeURIComponent(id)}${qs}`,
    signal === undefined ? undefined : { signal },
  );
}

export async function createHermesSession(
  id: string,
  title: string | undefined,
): Promise<void> {
  await fetchJson(
    `${UAO_API_PREFIX}/hermes/sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title }),
    },
  );
}

export interface StreamUaoChatOptions {
  readonly sessionId: string;
  readonly message: string;
  readonly provider: string;
  readonly target: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onEvent: (evt: HermesSSEEvent) => void;
}

const hermesSessions = new Set<string>();

export async function streamUaoChat(
  options: StreamUaoChatOptions,
): Promise<void> {
  if (options.provider === "hermes" && !hermesSessions.has(options.sessionId)) {
    await createHermesSession(options.sessionId, `chat-${options.sessionId}`);
    hermesSessions.add(options.sessionId);
  }

  const payload: Record<string, unknown> = {
    message: options.message,
    provider: options.provider,
  };
  if (options.target !== undefined) {
    payload.target = options.target;
  }

  const res = await fetch(
    `${UAO_API_PREFIX}/hermes/sessions/${encodeURIComponent(options.sessionId)}/chat/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal,
    },
  );

  if (!res.ok || res.body === null) {
    throw new Error(`Chat stream failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(options.onEvent);

  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    parser.feed(decoder.decode(result.value, { stream: true }));
  }
}
