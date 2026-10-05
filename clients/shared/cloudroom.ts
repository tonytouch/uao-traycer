import {
  parseHttpOrigin,
  type AgentOsTokenWriteResult,
} from "./agent-os-endpoints";

/** cloudroom-core's port, on Keith's Tailscale host. The URL is not a secret. */
export const CLOUDROOM_DEFAULT_BASE_URL = "http://100.90.167.20:9840";

/** Harnesses the Orca CloudRoom page starts. Core also accepts `opencode`. */
export const CLOUDROOM_HARNESSES = [
  "codex",
  "claude-code",
  "pi",
  "cursor",
] as const;
export type CloudroomHarness = (typeof CLOUDROOM_HARNESSES)[number];

export const CLOUDROOM_HARNESS_LABELS: Readonly<
  Record<CloudroomHarness, string>
> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi",
  cursor: "Cursor",
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_PATTERN = /^cr_[A-Za-z0-9_-]{1,128}$/;
const PROMPT_BYTE_LIMIT = 32768;
const WORKSPACE_LIMIT = 512;
const TRANSCRIPT_LIMIT = 80_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface CloudroomPublicConfig {
  readonly baseUrl: string;
  readonly tokenSaved: boolean;
}

export interface CloudroomSessionSummary {
  readonly sessionId: string;
  readonly harness: string;
  readonly state: string;
  readonly model: string | null;
  readonly lastActivityMs: number | null;
}

export interface CloudroomEvent {
  readonly sequence: number;
  readonly kind: string;
  readonly text: string;
}

export type CloudroomHealth =
  | { readonly status: "unconfigured"; readonly message: string }
  | {
      readonly status: "unreachable";
      readonly baseUrl: string;
      readonly message: string;
    }
  | {
      readonly status: "unauthorized";
      readonly baseUrl: string;
      readonly message: string;
    }
  | {
      readonly status: "not-ready";
      readonly baseUrl: string;
      readonly message: string;
    }
  | {
      readonly status: "ready";
      readonly baseUrl: string;
      readonly message: string;
    };

export type CloudroomCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code: string | null;
      readonly sessionId: string | null;
    };

export interface CloudroomCreateInput {
  readonly harness: string;
  readonly prompt: string;
  readonly workspace: string;
}

export interface UaoCloudroomApi {
  readonly getConfig: () => Promise<CloudroomPublicConfig>;
  readonly setConfig: (draft: {
    readonly baseUrl: string;
  }) => Promise<CloudroomPublicConfig>;
  readonly setToken: (token: string) => Promise<AgentOsTokenWriteResult>;
  readonly health: () => Promise<CloudroomHealth>;
  readonly listSessions: () => Promise<
    CloudroomCallResult<readonly CloudroomSessionSummary[]>
  >;
  readonly createSession: (
    input: CloudroomCreateInput,
  ) => Promise<CloudroomCallResult<{ readonly sessionId: string }>>;
  readonly events: (
    sessionId: string,
    after: number,
  ) => Promise<CloudroomCallResult<readonly CloudroomEvent[]>>;
}

export function isCloudroomHarness(value: string): value is CloudroomHarness {
  return CLOUDROOM_HARNESSES.some((harness) => harness === value);
}

export function isCloudroomSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

/** Core accepts 1–64 of letters, digits, `_`, and `-`. `uao-` plus a UUID fits. */
export function createCloudroomRequestId(randomUuid: string): string {
  const id = `uao-${randomUuid}`;
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new Error("CloudRoom request id is invalid.");
  }
  return id;
}

export function resolveCloudroomBaseUrl(draft: unknown): string {
  if (!isRecord(draft) || typeof draft.baseUrl !== "string") {
    throw new Error("CloudRoom address is missing.");
  }
  const trimmed = draft.baseUrl.trim();
  if (trimmed === "") return "";
  const origin = parseHttpOrigin(trimmed);
  if (origin === null) {
    throw new Error("CloudRoom address must be an http(s) URL.");
  }
  return origin;
}

/** A missing file uses the Tailscale default. A blank saved value stays blank. */
export function cloudroomBaseUrlFromStored(value: unknown): string {
  if (!isRecord(value) || !Object.hasOwn(value, "baseUrl")) {
    return CLOUDROOM_DEFAULT_BASE_URL;
  }
  const raw = value.baseUrl;
  if (typeof raw !== "string" || raw.trim() === "") return "";
  return parseHttpOrigin(raw) ?? CLOUDROOM_DEFAULT_BASE_URL;
}

export function parseCloudroomPublicConfig(
  value: unknown,
): CloudroomPublicConfig {
  if (!isRecord(value) || typeof value.tokenSaved !== "boolean") {
    throw new Error("Invalid CloudRoom settings.");
  }
  if (typeof value.baseUrl !== "string") {
    throw new Error("Invalid CloudRoom settings.");
  }
  if (
    value.baseUrl !== "" &&
    parseHttpOrigin(value.baseUrl) !== value.baseUrl
  ) {
    throw new Error("Invalid CloudRoom settings.");
  }
  return { baseUrl: value.baseUrl, tokenSaved: value.tokenSaved };
}

export function parseCloudroomHealth(value: unknown): CloudroomHealth {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    typeof value.message !== "string" ||
    value.message.trim() === ""
  ) {
    throw new Error("Invalid CloudRoom status.");
  }
  const status = value.status;
  const message = value.message;
  if (status === "unconfigured") return { status, message };
  if (
    status === "unreachable" ||
    status === "unauthorized" ||
    status === "not-ready" ||
    status === "ready"
  ) {
    if (typeof value.baseUrl !== "string") {
      throw new Error("Invalid CloudRoom status.");
    }
    return { status, baseUrl: value.baseUrl, message };
  }
  throw new Error("Invalid CloudRoom status.");
}

function parseSessionSummary(value: unknown): CloudroomSessionSummary {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    throw new Error("Invalid CloudRoom sessions.");
  }
  if (!isCloudroomSessionId(value.sessionId)) {
    throw new Error("Invalid CloudRoom sessions.");
  }
  return {
    sessionId: value.sessionId,
    harness: typeof value.harness === "string" ? value.harness : "unknown",
    state: typeof value.state === "string" ? value.state : "unknown",
    model: typeof value.model === "string" ? value.model : null,
    lastActivityMs:
      typeof value.lastActivityMs === "number" &&
      Number.isFinite(value.lastActivityMs)
        ? value.lastActivityMs
        : null,
  };
}

export function parseCloudroomSessions(
  value: unknown,
): readonly CloudroomSessionSummary[] {
  if (!Array.isArray(value)) throw new Error("Invalid CloudRoom sessions.");
  return value.map(parseSessionSummary);
}

function parseEvent(value: unknown): CloudroomEvent {
  if (
    !isRecord(value) ||
    typeof value.sequence !== "number" ||
    !Number.isFinite(value.sequence)
  ) {
    throw new Error("Invalid CloudRoom events.");
  }
  return {
    sequence: value.sequence,
    kind: typeof value.kind === "string" ? value.kind : "record",
    text: typeof value.text === "string" ? value.text : "",
  };
}

export function parseCloudroomEvents(
  value: unknown,
): readonly CloudroomEvent[] {
  if (!Array.isArray(value)) throw new Error("Invalid CloudRoom events.");
  return value.map(parseEvent);
}

function parseCreatedSession(value: unknown): { readonly sessionId: string } {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    !isCloudroomSessionId(value.sessionId)
  ) {
    throw new Error("Invalid CloudRoom session.");
  }
  return { sessionId: value.sessionId };
}

export function parseCloudroomCallResult<T>(
  value: unknown,
  parseValue: (value: unknown) => T,
): CloudroomCallResult<T> {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Invalid CloudRoom result.");
  }
  if (value.ok) return { ok: true, value: parseValue(value.value) };
  if (typeof value.error !== "string" || value.error.trim() === "") {
    throw new Error("Invalid CloudRoom result.");
  }
  return {
    ok: false,
    error: value.error,
    code: typeof value.code === "string" ? value.code : null,
    sessionId:
      typeof value.sessionId === "string" &&
      isCloudroomSessionId(value.sessionId)
        ? value.sessionId
        : null,
  };
}

export function parseCloudroomSessionsResult(
  value: unknown,
): CloudroomCallResult<readonly CloudroomSessionSummary[]> {
  return parseCloudroomCallResult(value, parseCloudroomSessions);
}

export function parseCloudroomEventsResult(
  value: unknown,
): CloudroomCallResult<readonly CloudroomEvent[]> {
  return parseCloudroomCallResult(value, parseCloudroomEvents);
}

export function parseCloudroomCreateResult(
  value: unknown,
): CloudroomCallResult<{ readonly sessionId: string }> {
  return parseCloudroomCallResult(value, parseCreatedSession);
}

/**
 * Page forward. Events at or below `cursor` are already on screen, so a
 * repeated poll cannot append them twice.
 */
export function mergeCloudroomEvents(
  cursor: number,
  text: string,
  events: readonly CloudroomEvent[],
): { readonly cursor: number; readonly text: string } {
  const fresh = events
    .filter((event) => event.sequence > cursor)
    .sort((left, right) => left.sequence - right.sequence);
  let nextCursor = cursor;
  let nextText = text;
  for (const event of fresh) {
    if (event.sequence > nextCursor) nextCursor = event.sequence;
    if (event.text.length > 0) {
      nextText = (nextText + event.text).slice(-TRANSCRIPT_LIMIT);
    }
  }
  return { cursor: nextCursor, text: nextText };
}

export class CloudroomClientError extends Error {
  readonly kind: "unreachable" | "unauthorized" | "http";
  readonly code: string | null;
  readonly status: number | null;

  constructor(
    kind: "unreachable" | "unauthorized" | "http",
    message: string,
    code: string | null,
    status: number | null,
  ) {
    super(message);
    this.name = "CloudroomClientError";
    this.kind = kind;
    this.code = code;
    this.status = status;
  }
}

type FetchLike = (
  input: string,
  init: RequestInit | undefined,
) => Promise<Response>;

export interface CloudroomClient {
  readonly ready: () => Promise<{ readonly ready: boolean }>;
  readonly listSessions: () => Promise<CloudroomSessionSummary[]>;
  readonly createSession: (input: {
    readonly requestId: string;
    readonly harness: CloudroomHarness;
    readonly workspace: string | null;
  }) => Promise<{ readonly sessionId: string }>;
  readonly sendPrompt: (
    sessionId: string,
    input: { readonly requestId: string; readonly text: string },
  ) => Promise<void>;
  readonly events: (
    sessionId: string,
    after: number,
  ) => Promise<CloudroomEvent[]>;
}

function failure(error: unknown): {
  readonly ok: false;
  readonly error: string;
  readonly code: string | null;
  readonly sessionId: string | null;
} {
  if (error instanceof CloudroomClientError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      sessionId: null,
    };
  }
  return {
    ok: false,
    error: "CloudRoom request failed.",
    code: null,
    sessionId: null,
  };
}

function eventText(item: Record<string, unknown>): string {
  const data = item.data;
  if (typeof data === "string") return data;
  if (!isRecord(data)) return "";
  for (const key of ["text", "delta", "message", "content"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function wireErrorMessage(parsed: unknown, status: number): string {
  if (
    isRecord(parsed) &&
    typeof parsed.error === "string" &&
    parsed.error.trim() !== ""
  ) {
    return parsed.error.slice(0, 300);
  }
  return `CloudRoom returned HTTP ${status}.`;
}

function wireErrorCode(parsed: unknown): string | null {
  if (isRecord(parsed) && typeof parsed.code === "string") return parsed.code;
  return null;
}

export function createCloudroomClient(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl: FetchLike | undefined;
}): CloudroomClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/$/, "");

  async function request(
    path: string,
    init: { readonly method: string; readonly body: unknown } | undefined,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.token !== "") headers.authorization = `Bearer ${options.token}`;
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : null,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "network error";
      throw new CloudroomClientError(
        "unreachable",
        `Can't reach CloudRoom at ${base}. ${detail}`,
        null,
        null,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelUnread(response);
      throw new CloudroomClientError(
        "http",
        `CloudRoom returned HTTP ${response.status}.`,
        null,
        response.status,
      );
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      throw new CloudroomClientError(
        response.status === 401 ? "unauthorized" : "http",
        wireErrorMessage(parsed, response.status),
        wireErrorCode(parsed),
        response.status,
      );
    }
    return parsed;
  }

  return {
    ready: async () => {
      try {
        const body = await request("/v1/ready", undefined);
        return { ready: isRecord(body) && body.ready === true };
      } catch (error) {
        if (error instanceof CloudroomClientError && error.status === 503) {
          return { ready: false };
        }
        throw error;
      }
    },
    listSessions: async () => {
      const body = await request("/v1/sessions", undefined);
      if (!isRecord(body) || !Array.isArray(body.sessions)) return [];
      const sessions: CloudroomSessionSummary[] = [];
      for (const item of body.sessions) {
        if (!isRecord(item) || typeof item.session_id !== "string") continue;
        if (!isCloudroomSessionId(item.session_id)) continue;
        sessions.push({
          sessionId: item.session_id,
          harness: typeof item.harness === "string" ? item.harness : "unknown",
          state: typeof item.state === "string" ? item.state : "unknown",
          model: typeof item.model === "string" ? item.model : null,
          lastActivityMs:
            typeof item.last_activity_ms === "number"
              ? item.last_activity_ms
              : null,
        });
      }
      return sessions;
    },
    createSession: async (input) => {
      if (!REQUEST_ID_PATTERN.test(input.requestId)) {
        throw new CloudroomClientError(
          "http",
          "CloudRoom request id is invalid.",
          null,
          null,
        );
      }
      const body: Record<string, string> = {
        request_id: input.requestId,
        harness: input.harness,
      };
      if (input.workspace !== null) body.workspace = input.workspace;
      const parsed = await request("/v1/sessions", { method: "POST", body });
      if (
        !isRecord(parsed) ||
        typeof parsed.session_id !== "string" ||
        !isCloudroomSessionId(parsed.session_id)
      ) {
        throw new CloudroomClientError(
          "http",
          "CloudRoom did not return a session id.",
          null,
          null,
        );
      }
      return { sessionId: parsed.session_id };
    },
    sendPrompt: async (sessionId, input) => {
      assertSessionId(sessionId);
      if (!REQUEST_ID_PATTERN.test(input.requestId)) {
        throw new CloudroomClientError(
          "http",
          "CloudRoom request id is invalid.",
          null,
          null,
        );
      }
      if (new TextEncoder().encode(input.text).length > PROMPT_BYTE_LIMIT) {
        throw new CloudroomClientError(
          "http",
          "That prompt is too long for CloudRoom.",
          null,
          null,
        );
      }
      await request(`/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
        method: "POST",
        body: { request_id: input.requestId, text: input.text },
      });
    },
    events: async (sessionId, after) => {
      assertSessionId(sessionId);
      const cursor =
        Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
      const parsed = await request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/events?after=${String(cursor)}`,
        undefined,
      );
      const records = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.events)
          ? parsed.events
          : [];
      const events: CloudroomEvent[] = [];
      for (const item of records) {
        if (!isRecord(item) || typeof item.sequence !== "number") continue;
        events.push({
          sequence: item.sequence,
          kind: typeof item.kind === "string" ? item.kind : "record",
          text: eventText(item),
        });
      }
      return events;
    },
  };
}

function assertSessionId(sessionId: string): void {
  if (!isCloudroomSessionId(sessionId)) {
    throw new CloudroomClientError(
      "http",
      "Missing CloudRoom session.",
      null,
      null,
    );
  }
}

function optionalWorkspace(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > WORKSPACE_LIMIT || /[\u0000\r\n]/.test(trimmed)) {
    throw new CloudroomClientError(
      "http",
      "That workspace id cannot be sent.",
      null,
      null,
    );
  }
  return trimmed;
}

export interface CloudroomEnvironment {
  readonly health: () => Promise<CloudroomHealth>;
  readonly listSessions: () => Promise<
    CloudroomCallResult<CloudroomSessionSummary[]>
  >;
  readonly createSession: (
    input: CloudroomCreateInput,
  ) => Promise<CloudroomCallResult<{ readonly sessionId: string }>>;
  readonly events: (
    sessionId: string,
    after: number,
  ) => Promise<CloudroomCallResult<CloudroomEvent[]>>;
}

export function createCloudroomEnvironment(options: {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl: FetchLike | undefined;
  readonly requestId: () => string;
}): CloudroomEnvironment {
  const baseUrl = options.baseUrl.trim();

  function client(): CloudroomClient {
    return createCloudroomClient({
      baseUrl,
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
  }

  return {
    health: async () => {
      if (baseUrl === "") {
        return {
          status: "unconfigured",
          message: "Set a CloudRoom URL in Endpoints to launch agents there.",
        };
      }
      try {
        const ready = await client().ready();
        if (ready.ready) {
          return {
            status: "ready",
            baseUrl,
            message: `Connected to CloudRoom at ${baseUrl}.`,
          };
        }
        return {
          status: "not-ready",
          baseUrl,
          message: `CloudRoom at ${baseUrl} is up but not ready. Check Postgres and the service logs.`,
        };
      } catch (error) {
        if (
          error instanceof CloudroomClientError &&
          error.kind === "unauthorized"
        ) {
          return {
            status: "unauthorized",
            baseUrl,
            message:
              "CloudRoom refused the token. Enter the CLOUDROOM_TOKEN from the server.",
          };
        }
        const detail =
          error instanceof Error ? error.message : "CloudRoom is unreachable.";
        return { status: "unreachable", baseUrl, message: detail };
      }
    },
    listSessions: async () => {
      if (baseUrl === "") {
        return {
          ok: false,
          error: "CloudRoom is not configured.",
          code: null,
          sessionId: null,
        };
      }
      try {
        return { ok: true, value: await client().listSessions() };
      } catch (error) {
        return failure(error);
      }
    },
    createSession: async (input) => {
      if (baseUrl === "") {
        return {
          ok: false,
          error: "CloudRoom is not configured.",
          code: null,
          sessionId: null,
        };
      }
      if (!isCloudroomHarness(input.harness)) {
        return {
          ok: false,
          error:
            "CloudRoom runs Codex, Claude Code, Pi, and Cursor. Pick one of those.",
          code: null,
          sessionId: null,
        };
      }
      const harness: CloudroomHarness = input.harness;
      let workspace: string | null;
      try {
        workspace = optionalWorkspace(input.workspace);
      } catch (error) {
        return failure(error);
      }
      try {
        const created = await client().createSession({
          requestId: options.requestId(),
          harness,
          workspace,
        });
        const prompt = input.prompt.trim();
        if (prompt !== "") {
          try {
            await client().sendPrompt(created.sessionId, {
              requestId: options.requestId(),
              text: prompt,
            });
          } catch (error) {
            const failed = failure(error);
            return { ...failed, sessionId: created.sessionId };
          }
        }
        return { ok: true, value: created };
      } catch (error) {
        return failure(error);
      }
    },
    events: async (sessionId, after) => {
      if (baseUrl === "") {
        return {
          ok: false,
          error: "CloudRoom is not configured.",
          code: null,
          sessionId: null,
        };
      }
      try {
        return { ok: true, value: await client().events(sessionId, after) };
      } catch (error) {
        return failure(error);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function cancelUnread(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // The status is the result. Failing to cancel the body is not the outage.
  }
}
