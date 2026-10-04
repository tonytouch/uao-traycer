import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { URL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { StringDecoder } from "node:string_decoder";
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  decodeTerminalStreamFrame,
  encodeTerminalStreamJson,
} from "@traycer-clients/shared/uao/orca-stream-protocol";
import {
  createWebSocketAccept,
  encodeWebSocketFrame,
  encodeWebSocketCloseFrame,
  WebSocketFrameParser,
  WebSocketProtocolError,
  WS_MAX_SOCKET_BUFFER_BYTES,
  WsOpcode,
  type WsParsedFrame,
} from "./uao-rfc6455";

export const ORCA_MAX_BODY_BYTES = 64 * 1024;
export const ORCA_DEFAULT_TIMEOUT_MS = 15_000;
export const ORCA_OPEN_TIMEOUT_MS = 30_000;

export const ORCA_ALLOWED_AGENTS = new Set([
  "shell",
  "claude",
  "codex",
  "hermes",
] as const);

export type OrcaAllowedAgent = "shell" | "claude" | "codex" | "hermes";

export function resolveOrcaBin(): string {
  const envBin = process.env.ORCA_BIN;
  if (envBin && envBin.trim().length > 0 && fs.existsSync(envBin)) {
    return envBin;
  }
  const defaultLocalBin = path.join(os.homedir(), ".local", "bin", "orca");
  if (fs.existsSync(defaultLocalBin)) {
    return defaultLocalBin;
  }
  return defaultLocalBin;
}

/**
 * Orca reports why a terminal ended as an object ({ kind, exitCode?, reason? }).
 * The UI shows it as a badge, so reduce it to a short string here; handing the
 * object to React as a child unmounts the whole app.
 */
export function describeExitCause(cause: unknown): string | undefined {
  if (typeof cause === "string") return cause.slice(0, 80) || undefined;
  if (typeof cause !== "object" || cause === null) return undefined;
  const record = cause as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind.replace(/_/g, " ") : "exited";
  if (typeof record.exitCode === "number") return `${kind} (code ${String(record.exitCode)})`.slice(0, 80);
  if (typeof record.reason === "string" && record.reason) return `${kind}: ${record.reason}`.slice(0, 80);
  return kind.slice(0, 80);
}

export function normalizeTerminalList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("exitCause" in entry)) return entry;
    const { exitCause, ...rest } = entry as Record<string, unknown>;
    const label = describeExitCause(exitCause);
    return label === undefined ? rest : { ...rest, exitCause: label };
  });
}

export function sanitizeOrcaError(raw: string): string {
  let sanitized = raw
    .replace(/(bearer\s+)[a-zA-Z0-9_\-.]+/gi, "$1[REDACTED]")
    .replace(/(token["':\s=]+)[a-zA-Z0-9_\-.]+/gi, "$1[REDACTED]")
    .replace(/--text\s+"[^"]*"/gi, "--text [REDACTED]")
    .replace(/--text\s+'[^']*'/gi, "--text [REDACTED]");
  if (sanitized.length > 500) {
    sanitized = sanitized.slice(0, 500) + "… (truncated)";
  }
  return sanitized.trim();
}

export function sanitizeOrcaResult(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item: unknown) => sanitizeOrcaResult(item));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (
      key === "authToken" ||
      key === "token" ||
      key === "launchToken" ||
      key === "AGENT_OS_TOKEN"
    ) {
      continue;
    }
    result[key] = sanitizeOrcaResult(value);
  }
  return result;
}

export interface RunOrcaOptions {
  readonly binPath?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly spawnImpl?: typeof spawn | undefined;
}

export interface OrcaCliRunResult {
  readonly ok: boolean;
  readonly status?: number | undefined;
  readonly data?: unknown;
  readonly error?: string | undefined;
}

export function runOrcaCli(
  args: readonly string[],
  options: RunOrcaOptions | undefined,
): Promise<OrcaCliRunResult> {
  const bin = options?.binPath ?? resolveOrcaBin();
  const timeoutMs = options?.timeoutMs ?? ORCA_DEFAULT_TIMEOUT_MS;
  const spawnFn = options?.spawnImpl ?? spawn;

  return new Promise((resolve) => {
    let stdout = "";
    const decoder = new StringDecoder("utf8");
    let outputBytes = 0;
    let killed = false;

    let proc: ChildProcess;
    try {
      proc = spawnFn(bin, [...args], {
        shell: false,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ok: false,
        error: sanitizeOrcaError((err as Error).message),
      });
      return;
    }

    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({
        ok: false,
        error: `Orca CLI timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const collect = (chunk: Buffer, isStdout: boolean): void => {
      if (killed) return;
      outputBytes += chunk.length;
      if (outputBytes > 2 * 1024 * 1024) {
        killed = true;
        clearTimeout(timer);
        proc.kill("SIGKILL");
        resolve({
          ok: false,
          error: "Orca CLI output exceeded its size limit",
        });
      } else if (isStdout) {
        stdout += decoder.write(chunk);
      }
    };
    proc.stdout?.on("data", (chunk: Buffer) => collect(chunk, true));
    proc.stderr?.on("data", (chunk: Buffer) => collect(chunk, false));

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      if (!killed) {
        resolve({
          ok: false,
          error: sanitizeOrcaError(err.message),
        });
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      stdout += decoder.end();

      const trimmedStdout = stdout.trim();
      let parsedJson: unknown = null;

      if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
        try {
          parsedJson = JSON.parse(trimmedStdout);
        } catch {
          // fall through
        }
      }

      if (
        !parsedJson ||
        typeof parsedJson !== "object" ||
        Array.isArray(parsedJson)
      ) {
        resolve({
          ok: false,
          error: "Orca CLI returned an invalid RPC envelope",
        });
        return;
      }
      const envelope = parsedJson as Record<string, unknown>;
      if (code !== 0 || envelope.ok !== true) {
        const failure = envelope.error;
        const message =
          failure &&
          typeof failure === "object" &&
          "message" in failure &&
          typeof failure.message === "string"
            ? failure.message
            : "Orca CLI request failed";
        const promptIndex = args.indexOf("--text");
        const prompt = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
        const errMsg = sanitizeOrcaError(
          prompt ? message.replaceAll(prompt, "[REDACTED]") : message,
        );
        resolve({
          ok: false,
          status: code ?? undefined,
          error: errMsg,
        });
        return;
      }
      if (
        !envelope.result ||
        typeof envelope.result !== "object" ||
        Array.isArray(envelope.result)
      ) {
        resolve({ ok: false, error: "Orca CLI returned an invalid result" });
        return;
      }
      const inner = envelope.result as Record<string, unknown>;
      const listKey =
        args[0] === "repo"
          ? "repos"
          : args[0] === "worktree"
            ? "worktrees"
            : args[1] === "list"
              ? "terminals"
              : null;
      const objectKey =
        args[0] === "status" || args[0] === "open"
          ? "runtime"
          : args[1] === "send"
            ? "send"
            : args[0] === "terminal" && listKey === null
              ? "terminal"
              : null;
      if (
        (listKey !== null && !Array.isArray(inner[listKey])) ||
        (objectKey !== null &&
          (!inner[objectKey] || typeof inner[objectKey] !== "object"))
      ) {
        resolve({ ok: false, error: "Orca CLI returned an incomplete result" });
        return;
      }

      resolve({
        ok: true,
        data: sanitizeOrcaResult(envelope),
      });
    });
  });
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function isValidWorktreeSelector(selector: string): boolean {
  if (!selector.startsWith("id:")) return false;
  const idPart = selector.slice(3).trim();
  if (idPart.length === 0 || idPart.length > 500) return false;
  return !/[\r\n\0\t\x1b]/.test(idPart);
}

function isValidTerminalHandle(handle: string): boolean {
  if (
    typeof handle !== "string" ||
    handle.length === 0 ||
    handle.length > 128
  ) {
    return false;
  }
  return /^[a-zA-Z0-9_\-.:@]+$/.test(handle);
}

export function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string }
> {
  return new Promise((resolve) => {
    const contentLength = req.headers["content-length"];
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      resolve({
        ok: false,
        status: 413,
        error: "Payload Too Large: Exceeds 64KB limit",
      });
      return;
    }

    const chunks: Buffer[] = [];
    let bytesReceived = 0;
    let exceeded = false;

    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        exceeded = true;
        resolve({
          ok: false,
          status: 413,
          error: "Payload Too Large: Exceeds 64KB limit",
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (exceeded) return;
      const buffer = Buffer.concat(chunks).toString("utf8");
      if (buffer.trim().length === 0) {
        resolve({ ok: true, body: {} });
        return;
      }
      try {
        const parsed = JSON.parse(buffer);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          resolve({
            ok: false,
            status: 400,
            error: "Bad Request: JSON body must be an object",
          });
          return;
        }
        resolve({ ok: true, body: parsed as Record<string, unknown> });
      } catch {
        resolve({
          ok: false,
          status: 400,
          error: "Bad Request: Malformed JSON",
        });
      }
    });

    req.on("error", (err) => {
      resolve({
        ok: false,
        status: 400,
        error: `Bad Request: ${err.message}`,
      });
    });
    req.on("aborted", () =>
      resolve({ ok: false, status: 400, error: "Request cancelled" }),
    );
  });
}

export interface HandleOrcaRequestOptions {
  readonly port?: number | undefined;
  readonly serverOrigin?: string | undefined;
  readonly parsedUrl?: URL | undefined;
  readonly binPath?: string | undefined;
  readonly spawnImpl?: typeof spawn | undefined;
}

async function startOrcaRuntime(
  options: RunOrcaOptions,
): Promise<OrcaCliRunResult> {
  const statusOptions = { ...options, timeoutMs: 2000 };
  const status = await runOrcaCli(["status", "--json"], statusOptions);
  const isReady = (result: OrcaCliRunResult): boolean => {
    if (
      !result.ok ||
      !result.data ||
      typeof result.data !== "object" ||
      !("result" in result.data)
    )
      return false;
    const inner = result.data.result;
    if (!inner || typeof inner !== "object" || !("runtime" in inner))
      return false;
    const runtime = inner.runtime;
    return (
      !!runtime &&
      typeof runtime === "object" &&
      "reachable" in runtime &&
      runtime.reachable === true
    );
  };
  if (isReady(status)) return status;
  let launchError: Error | undefined;
  const proc = (options.spawnImpl ?? spawn)(
    options.binPath ?? resolveOrcaBin(),
    ["serve", "--no-pairing", "--port", "0"],
    { shell: false, detached: true, stdio: "ignore" },
  );
  proc.once("error", (error: Error) => {
    launchError = error;
  });
  proc.unref();
  // Orca owns the runtime and sessions; UAO must not kill them on window close.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(1000);
    if (launchError)
      return { ok: false, error: "Could not start the installed Orca runtime" };
    const current = await runOrcaCli(["status", "--json"], statusOptions);
    if (isReady(current)) return current;
  }
  return {
    ok: false,
    error:
      "Orca did not become reachable. Inspect the original installation before retrying.",
  };
}

export async function handleOrcaHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: HandleOrcaRequestOptions | undefined,
): Promise<boolean> {
  const port = options?.port ?? 0;
  const serverOrigin =
    options?.serverOrigin ??
    (port > 0 ? `http://127.0.0.1:${port}` : "http://127.0.0.1");

  // 1. Host and Cross-Origin Boundary Validation
  if (port <= 0 || !req.headers.host) {
    sendJson(res, 403, {
      ok: false,
      error: "Forbidden: Missing server identity",
    });
    return true;
  }
  if (port > 0 && req.headers.host) {
    const validHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!validHosts.has(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: "Forbidden: Invalid Host" });
      return true;
    }
  }

  if (req.headers["sec-fetch-site"] === "cross-site") {
    sendJson(res, 403, {
      ok: false,
      error: "Forbidden: Cross-site request rejected",
    });
    return true;
  }

  if (req.headers.origin !== undefined && req.headers.origin.length > 0) {
    const origin = req.headers.origin;
    const isAllowedOrigin =
      port > 0
        ? origin === `http://127.0.0.1:${port}` ||
          origin === `http://localhost:${port}`
        : origin.startsWith("http://127.0.0.1") ||
          origin.startsWith("http://localhost");

    if (!isAllowedOrigin) {
      sendJson(res, 403, { ok: false, error: "Forbidden: Invalid Origin" });
      return true;
    }
  }
  if (req.headers.referer) {
    try {
      const origin = new URL(req.headers.referer).origin;
      if (
        origin !== `http://127.0.0.1:${port}` &&
        origin !== `http://localhost:${port}`
      )
        throw new Error("origin");
    } catch {
      sendJson(res, 403, { ok: false, error: "Forbidden: Invalid Referer" });
      return true;
    }
  }

  // 2. Parse URL and match Orca routes
  const parsed = options?.parsedUrl ?? new URL(req.url ?? "/", serverOrigin);
  const pathname = parsed.pathname;

  let subpath = "";
  if (pathname === "/uao-api/orca" || pathname.startsWith("/uao-api/orca/")) {
    subpath = pathname.slice("/uao-api/orca".length);
  } else {
    return false; // Not an Orca route
  }

  if (subpath.length === 0) {
    subpath = "/";
  }

  const method = req.method ?? "GET";
  const runOpts: RunOrcaOptions = {
    binPath: options?.binPath,
    spawnImpl: options?.spawnImpl,
  };

  // --- GET /status ---
  if (subpath === "/status") {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const result = await runOrcaCli(["status", "--json"], runOpts);
    if (!result.ok) {
      sendJson(res, 502, { ok: false, error: result.error });
      return true;
    }
    const envelope = result.data as Record<string, unknown> | null;
    const extractedResult = envelope?.result ?? envelope;
    sendJson(res, 200, {
      ok: true,
      result: extractedResult,
    });
    return true;
  }

  // --- POST /open ---
  if (subpath === "/open" || subpath === "/start") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const result =
      subpath === "/start"
        ? await startOrcaRuntime(runOpts)
        : await runOrcaCli(["open", "--json"], {
            ...runOpts,
            timeoutMs: ORCA_OPEN_TIMEOUT_MS,
          });
    if (!result.ok) {
      sendJson(res, 502, {
        ok: false,
        error: result.error ?? "Failed to open Orca",
      });
      return true;
    }
    // Also perform immediate status refresh to report real reachability
    const statusRefresh = await runOrcaCli(["status", "--json"], runOpts);
    const envelope = statusRefresh.data as Record<string, unknown> | null;
    sendJson(res, 200, {
      ok: true,
      open: result.data,
      status: envelope?.result ?? envelope,
    });
    return true;
  }

  // --- GET /repos ---
  if (subpath === "/repos") {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const result = await runOrcaCli(["repo", "list", "--json"], runOpts);
    if (!result.ok) {
      sendJson(res, 500, {
        ok: false,
        error: result.error ?? "Failed to list repos",
      });
      return true;
    }
    const envelope = result.data as Record<string, unknown> | null;
    const inner = (envelope?.result ?? envelope) as Record<
      string,
      unknown
    > | null;
    const repos = inner?.repos ?? [];
    sendJson(res, 200, {
      ok: true,
      repos,
    });
    return true;
  }

  // --- GET /worktrees ---
  if (subpath === "/worktrees") {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const result = await runOrcaCli(
      ["worktree", "ps", "--limit", "200", "--json"],
      runOpts,
    );
    if (!result.ok) {
      sendJson(res, 500, {
        ok: false,
        error: result.error ?? "Failed to list worktrees",
      });
      return true;
    }
    const envelope = result.data as Record<string, unknown> | null;
    const inner = (envelope?.result ?? envelope) as Record<
      string,
      unknown
    > | null;
    const worktrees = inner?.worktrees ?? [];
    sendJson(res, 200, {
      ok: true,
      worktrees,
      totalCount:
        inner?.totalCount ?? (Array.isArray(worktrees) ? worktrees.length : 0),
    });
    return true;
  }

  // --- GET /terminals ---
  if (subpath === "/terminals") {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const worktree = parsed.searchParams.get("worktree");
    if (!worktree || !isValidWorktreeSelector(worktree)) {
      sendJson(res, 400, {
        ok: false,
        error: "Invalid or missing worktree selector. Expected format id:<id>",
      });
      return true;
    }
    const result = await runOrcaCli(
      ["terminal", "list", "--worktree", worktree, "--json"],
      runOpts,
    );
    if (!result.ok) {
      sendJson(res, 500, {
        ok: false,
        error: result.error ?? "Failed to list terminals",
      });
      return true;
    }
    const envelope = result.data as Record<string, unknown> | null;
    const inner = (envelope?.result ?? envelope) as Record<
      string,
      unknown
    > | null;
    const terminals = normalizeTerminalList(inner?.terminals);
    sendJson(res, 200, {
      ok: true,
      terminals,
    });
    return true;
  }

  // --- GET /terminal/read ---
  if (subpath === "/terminal/read") {
    if (method !== "GET") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const terminal = parsed.searchParams.get("terminal");
    if (!terminal || !isValidTerminalHandle(terminal)) {
      sendJson(res, 400, {
        ok: false,
        error: "Invalid or missing terminal handle",
      });
      return true;
    }
    let limit = 300;
    const rawLimit = parsed.searchParams.get("limit");
    if (rawLimit !== null) {
      const parsedLimit = Number.parseInt(rawLimit, 10);
      if (
        Number.isInteger(parsedLimit) &&
        parsedLimit > 0 &&
        parsedLimit <= 1000
      ) {
        limit = parsedLimit;
      }
    }
    const result = await runOrcaCli(
      [
        "terminal",
        "read",
        "--terminal",
        terminal,
        "--screen",
        "--limit",
        String(limit),
        "--json",
      ],
      runOpts,
    );
    if (!result.ok) {
      sendJson(res, 500, {
        ok: false,
        error: result.error ?? "Failed to read terminal screen",
      });
      return true;
    }
    const envelope = result.data as Record<string, unknown> | null;
    const inner = (envelope?.result ?? envelope) as Record<
      string,
      unknown
    > | null;
    const terminalData = inner?.terminal ?? inner;
    sendJson(res, 200, {
      ok: true,
      terminal: terminalData,
    });
    return true;
  }

  // --- POST /terminal/send ---
  if (subpath === "/terminal/send") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const bodyResult = await readJsonBody(req, ORCA_MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      sendJson(res, bodyResult.status, { ok: false, error: bodyResult.error });
      return true;
    }
    const { terminal, text, enter, interrupt } = bodyResult.body;
    if (
      Object.keys(bodyResult.body).some(
        (key) => !["terminal", "text", "enter", "interrupt"].includes(key),
      ) ||
      (text !== undefined &&
        (typeof text !== "string" ||
          text.length > 32000 ||
          text.includes("\0"))) ||
      (enter !== undefined && typeof enter !== "boolean") ||
      (interrupt !== undefined && typeof interrupt !== "boolean")
    ) {
      sendJson(res, 400, { ok: false, error: "Invalid terminal input" });
      return true;
    }
    if (typeof terminal !== "string" || !isValidTerminalHandle(terminal)) {
      sendJson(res, 400, {
        ok: false,
        error: "Invalid or missing terminal handle",
      });
      return true;
    }

    const isInterrupt = interrupt === true;
    const hasText = typeof text === "string" && text.length > 0;

    if (!isInterrupt && !hasText) {
      sendJson(res, 400, {
        ok: false,
        error:
          "Bad Request: send requires either interrupt=true or non-empty text",
      });
      return true;
    }

    const args: string[] = [
      "terminal",
      "send",
      "--terminal",
      terminal,
      "--json",
    ];
    if (isInterrupt) {
      args.push("--interrupt");
    } else {
      args.push("--text", String(text));
      if (enter !== false) {
        args.push("--enter");
      }
    }

    const result = await runOrcaCli(args, runOpts);
    if (!result.ok) {
      sendJson(res, 500, {
        ok: false,
        error: result.error ?? "Terminal send failed",
      });
      return true;
    }

    const envelope = result.data as Record<string, unknown> | null;
    const inner = (envelope?.result ?? envelope) as Record<
      string,
      unknown
    > | null;
    const sendData = inner?.send as Record<string, unknown> | undefined;
    const warnings = (inner?.warnings as string[] | undefined) ?? [];

    sendJson(res, 200, {
      ok: sendData?.accepted === true,
      send: sendData,
      warnings,
    });
    return true;
  }

  // --- POST /terminal/create ---
  if (subpath === "/terminal/create") {
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
      return true;
    }
    const bodyResult = await readJsonBody(req, ORCA_MAX_BODY_BYTES);
    if (!bodyResult.ok) {
      sendJson(res, bodyResult.status, { ok: false, error: bodyResult.error });
      return true;
    }
    const { worktree, agent } = bodyResult.body;
    if (
      Object.keys(bodyResult.body).some(
        (key) => !["worktree", "agent"].includes(key),
      )
    ) {
      sendJson(res, 400, {
        ok: false,
        error: "Unknown terminal creation option",
      });
      return true;
    }
    if (typeof worktree !== "string" || !isValidWorktreeSelector(worktree)) {
      sendJson(res, 400, {
        ok: false,
        error: "Invalid or missing worktree selector. Expected format id:<id>",
      });
      return true;
    }

    let command: string | undefined;
    if (agent !== undefined && agent !== null && agent !== "shell") {
      if (
        typeof agent !== "string" ||
        !ORCA_ALLOWED_AGENTS.has(agent as OrcaAllowedAgent)
      ) {
        sendJson(res, 400, {
          ok: false,
          error: `Invalid agent choice. Allowed choices: ${Array.from(ORCA_ALLOWED_AGENTS).join(", ")}`,
        });
        return true;
      }
      command = agent;
    }

    const args: string[] = [
      "terminal",
      "create",
      "--worktree",
      worktree,
      "--json",
    ];
    if (command !== undefined) {
      args.push("--command", command);
    }

    const result = await runOrcaCli(args, runOpts);
    if (!result.ok) {
      sendJson(res, 500, {
        ok: false,
        error: result.error ?? "Terminal creation failed",
      });
      return true;
    }

    const envelope = result.data as Record<string, unknown> | null;
    const inner = (envelope?.result ?? envelope) as Record<
      string,
      unknown
    > | null;
    const terminalData = inner?.terminal ?? inner;

    sendJson(res, 200, {
      ok: true,
      terminal: terminalData,
    });
    return true;
  }

  // Any other subpath is rejected
  sendJson(res, 404, {
    ok: false,
    error: `Not Found: Unknown Orca action '${subpath}'`,
  });
  return true;
}

export interface OrcaRuntimePairingInfo {
  readonly loopbackEndpoint: string;
  readonly deviceToken: string;
  readonly publicKeyB64: string;
  readonly runtimeId: string;
  readonly pid: number;
}

export interface RemoteRuntimeSubscriptionHandle {
  readonly requestId: string;
  readonly close: () => void;
  readonly sendBinary: (bytes: Uint8Array) => boolean;
}

export interface RemoteRuntimeSubscriptionCallbacks {
  readonly onResponse: (response: {
    readonly id?: string;
    readonly ok?: boolean;
    readonly result?: unknown;
    readonly error?: { readonly code?: string; readonly message?: string };
    readonly _meta?: { readonly runtimeId?: string };
  }) => void;
  readonly onBinary?: ((bytes: Uint8Array) => void) | undefined;
  readonly onError: (error: Error) => void;
  readonly onClose?: (() => void) | undefined;
}

export type SubscribeRemoteRuntimeFn = (
  pairing: {
    readonly endpoint: string;
    readonly deviceToken: string;
    readonly publicKeyB64: string;
  },
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  callbacks: RemoteRuntimeSubscriptionCallbacks,
) => Promise<RemoteRuntimeSubscriptionHandle>;

export interface OrcaTerminalStreamUpgradeOptions {
  readonly port: number;
  readonly serverOrigin: string;
  readonly parsedUrl: URL;
  readonly userDataPath?: string | undefined;
  readonly subscribeRuntimeImpl?: SubscribeRemoteRuntimeFn | undefined;
  readonly initialViewport?:
    | { readonly cols: number; readonly rows: number }
    | undefined;
}

export function getOrcaUserDataPath(overridePath: string | undefined): string {
  if (overridePath !== undefined && overridePath.trim().length > 0) {
    return overridePath;
  }
  if (process.env.ORCA_USER_DATA_PATH) {
    return process.env.ORCA_USER_DATA_PATH;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "orca");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "orca",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "orca",
  );
}

function readBoundedRegularFile(filePath: string): string {
  const limit = 1024 * 1024;
  const fd = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > limit)
      throw new Error("Invalid Orca metadata file");
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const n = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (n === 0) break;
      used += n;
    }
    if (used > limit) throw new Error("Orca metadata exceeds limit");
    return bytes.subarray(0, used).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function readOrcaRuntimePairing(
  userDataPath: string | undefined,
): OrcaRuntimePairingInfo {
  const dir = getOrcaUserDataPath(userDataPath);
  const runtimeFile = path.join(dir, "orca-runtime.json");

  const runtimeText = readBoundedRegularFile(runtimeFile);
  const runtimeRaw = JSON.parse(runtimeText) as {
    readonly runtimeId?: unknown;
    readonly pid?: unknown;
    readonly transports?: readonly {
      readonly kind?: unknown;
      readonly endpoint?: unknown;
    }[];
  };

  if (
    typeof runtimeRaw.runtimeId !== "string" ||
    runtimeRaw.runtimeId.length === 0
  ) {
    throw new Error("Invalid orca-runtime.json: missing or invalid runtimeId");
  }

  if (
    typeof runtimeRaw.pid !== "number" ||
    !Number.isSafeInteger(runtimeRaw.pid) ||
    runtimeRaw.pid <= 0
  ) {
    throw new Error("Invalid orca-runtime.json: missing or invalid pid");
  }

  try {
    process.kill(runtimeRaw.pid, 0);
  } catch {
    throw new Error(`Orca runtime PID ${runtimeRaw.pid} is not running`);
  }

  if (!Array.isArray(runtimeRaw.transports)) {
    throw new Error("Invalid orca-runtime.json: missing or invalid transports");
  }

  const wsTransport = runtimeRaw.transports.find(
    (t) => t && typeof t === "object" && t.kind === "websocket",
  );
  if (!wsTransport || typeof wsTransport.endpoint !== "string") {
    throw new Error(
      "Orca runtime metadata does not contain a websocket transport",
    );
  }

  let parsedWsUrl: URL;
  try {
    parsedWsUrl = new URL(wsTransport.endpoint);
  } catch {
    throw new Error(
      `Malformed Orca WebSocket endpoint URL: ${wsTransport.endpoint}`,
    );
  }

  if (parsedWsUrl.protocol !== "ws:" && parsedWsUrl.protocol !== "wss:") {
    throw new Error(
      `Invalid Orca WebSocket URL scheme: ${parsedWsUrl.protocol}`,
    );
  }

  const hostName = parsedWsUrl.hostname.toLowerCase();
  const isLoopbackOrWildcard =
    hostName === "127.0.0.1" ||
    hostName === "localhost" ||
    hostName === "0.0.0.0" ||
    hostName === "[::1]" ||
    hostName === "::1";

  if (!isLoopbackOrWildcard) {
    throw new Error(
      `Non-loopback Orca WebSocket host: ${parsedWsUrl.hostname}`,
    );
  }

  const wsPort = Number(parsedWsUrl.port);
  if (!Number.isSafeInteger(wsPort) || wsPort < 1 || wsPort > 65535) {
    throw new Error(`Invalid Orca WebSocket port: ${parsedWsUrl.port}`);
  }

  const devicesFile = path.join(dir, "orca-devices.json");
  const devicesText = readBoundedRegularFile(devicesFile);
  const devicesRaw = JSON.parse(devicesText) as readonly {
    readonly token?: unknown;
    readonly scope?: unknown;
  }[];
  if (!Array.isArray(devicesRaw)) {
    throw new Error("Invalid orca-devices.json format");
  }
  const runtimeDevice = devicesRaw
    .filter(
      (d) =>
        (d.scope === "runtime" || !d.scope) &&
        typeof d.token === "string" &&
        d.token.length > 0,
    )
    .at(-1);

  if (!runtimeDevice || typeof runtimeDevice.token !== "string") {
    throw new Error("No valid runtime device token found in orca-devices.json");
  }

  const keypairFile = path.join(dir, "orca-e2ee-keypair.json");
  const keypairText = readBoundedRegularFile(keypairFile);
  const keypairRaw = JSON.parse(keypairText) as {
    readonly publicKeyB64?: unknown;
  };
  if (
    typeof keypairRaw.publicKeyB64 !== "string" ||
    keypairRaw.publicKeyB64.length === 0
  ) {
    throw new Error("Invalid orca-e2ee-keypair.json: missing publicKeyB64");
  }

  return {
    loopbackEndpoint: `ws://127.0.0.1:${wsPort}`,
    deviceToken: runtimeDevice.token,
    publicKeyB64: keypairRaw.publicKeyB64,
    runtimeId: runtimeRaw.runtimeId,
    pid: runtimeRaw.pid,
  };
}

export function resolveSubscribeRemoteRuntimeFn(): SubscribeRemoteRuntimeFn | null {
  try {
    const binPath = resolveOrcaBin();
    if (!fs.existsSync(binPath)) return null;
    const realBin = fs.realpathSync(binPath);
    const clientPath = path.resolve(
      path.dirname(realBin),
      "../app.asar.unpacked/out/shared/remote-runtime-client.js",
    );
    if (!fs.existsSync(clientPath)) return null;
    const nodeRequire = createRequire(realBin);
    const mod = nodeRequire(clientPath) as {
      readonly subscribeRemoteRuntimeRequest?: SubscribeRemoteRuntimeFn;
    };
    return typeof mod.subscribeRemoteRuntimeRequest === "function"
      ? mod.subscribeRemoteRuntimeRequest
      : null;
  } catch {
    return null;
  }
}

export async function handleOrcaTerminalStreamUpgrade(
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
  options: OrcaTerminalStreamUpgradeOptions,
): Promise<void> {
  const terminal = options.parsedUrl.searchParams.get("terminal");
  if (!terminal || !isValidTerminalHandle(terminal)) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\nInvalid terminal handle",
    );
    socket.destroy();
    return;
  }

  if (req.headers["sec-websocket-version"] !== "13") {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nSec-WebSocket-Version: 13\r\n\r\nUnsupported WebSocket version",
    );
    socket.destroy();
    return;
  }
  const secKey = req.headers["sec-websocket-key"];
  if (
    typeof secKey !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(secKey) ||
    Buffer.from(secKey, "base64").length !== 16
  ) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\n\r\nMissing Sec-WebSocket-Key",
    );
    socket.destroy();
    return;
  }

  let pairing: OrcaRuntimePairingInfo;
  try {
    pairing = readOrcaRuntimePairing(options.userDataPath);
  } catch {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nOrca runtime unavailable",
    );
    socket.destroy();
    return;
  }

  const subscribeFn =
    options.subscribeRuntimeImpl ?? resolveSubscribeRemoteRuntimeFn();
  if (typeof subscribeFn !== "function") {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nOrca stream client unavailable",
    );
    socket.destroy();
    return;
  }

  const pinnedRuntimeId = pairing.runtimeId;
  let clientClosed = false;
  let http101Sent = false;
  let upstreamSub: RemoteRuntimeSubscriptionHandle | null = null;
  const parser = new WebSocketFrameParser();

  const cleanup = (): void => {
    if (upstreamSub !== null) {
      try {
        const unsubPayload = encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Unsubscribe,
          streamId: 1,
          seq: 0,
          payload: new Uint8Array(0),
        });
        upstreamSub.sendBinary(unsubPayload);
      } catch {
        // best effort unsubscribe frame
      }
      try {
        upstreamSub.close();
      } catch {
        // ignore best effort close
      }
      upstreamSub = null;
    }
  };

  const closeClient = (closeCode: number | undefined): void => {
    if (clientClosed) return;
    clientClosed = true;
    cleanup();
    if (http101Sent) {
      try {
        socket.write(encodeWebSocketCloseFrame(closeCode ?? 1000));
        socket.end();
      } catch {
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
  };

  // Register close/error cleanup BEFORE awaiting upstream subscription
  socket.once("close", () => {
    clientClosed = true;
    cleanup();
  });

  socket.on("error", () => {
    clientClosed = true;
    cleanup();
    socket.destroy();
  });

  // Verify runtime identity freshness
  try {
    const currentPairing = readOrcaRuntimePairing(options.userDataPath);
    if (currentPairing.runtimeId !== pinnedRuntimeId) {
      throw new Error("Stale runtime identity");
    }
  } catch {
    socket.write(
      "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nStale runtime identity",
    );
    socket.destroy();
    return;
  }

  let resolveReady: (ok: boolean) => void = () => {};
  const readyPromise = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  try {
    upstreamSub = await subscribeFn(
      {
        endpoint: pairing.loopbackEndpoint,
        deviceToken: pairing.deviceToken,
        publicKeyB64: pairing.publicKeyB64,
      },
      "terminal.multiplex",
      {},
      10_000,
      {
        onResponse: (response: {
          readonly id?: string;
          readonly ok?: boolean;
          readonly result?: unknown;
          readonly error?: {
            readonly code?: string;
            readonly message?: string;
          };
          readonly _meta?: { readonly runtimeId?: string };
        }) => {
          if (clientClosed) return;
          if (http101Sent) {
            const event = response.result;
            if (
              !response.ok ||
              response._meta?.runtimeId !== pinnedRuntimeId ||
              (event &&
                typeof event === "object" &&
                "type" in event &&
                ["end", "error"].includes(String(event.type)))
            )
              closeClient(1011);
            return;
          }
          if (response.ok !== true) {
            resolveReady(false);
            return;
          }
          if (response._meta?.runtimeId !== pinnedRuntimeId) {
            resolveReady(false);
            return;
          }
          resolveReady(true);
        },
        onBinary: (bytes: Uint8Array) => {
          if (clientClosed || !http101Sent) return;
          const frame = decodeTerminalStreamFrame(bytes);
          if (frame === null) return;
          if (frame.streamId !== 1) return;

          if (
            bytes.byteLength > 1024 * 1024 ||
            socket.writableLength + bytes.byteLength >
              WS_MAX_SOCKET_BUFFER_BYTES
          ) {
            closeClient(1008);
            return;
          }

          try {
            const wsFrame = encodeWebSocketFrame(bytes, WsOpcode.Binary);
            socket.write(wsFrame);
          } catch {
            closeClient(undefined);
          }
        },
        onError: () => {
          resolveReady(false);
          closeClient(1011);
        },
        onClose: () => {
          resolveReady(false);
          closeClient(1000);
        },
      },
    );
  } catch {
    socket.write(
      "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nUpstream subscription failed",
    );
    socket.destroy();
    cleanup();
    return;
  }

  if (clientClosed) {
    cleanup();
    return;
  }

  let readyTimer: NodeJS.Timeout | undefined;
  const isReady = await Promise.race([
    readyPromise,
    new Promise<boolean>((resolve) => {
      readyTimer = setTimeout(() => resolve(false), 10000);
    }),
  ]);
  clearTimeout(readyTimer);
  try {
    const currentPairing = readOrcaRuntimePairing(options.userDataPath);
    if (
      currentPairing.runtimeId !== pinnedRuntimeId ||
      currentPairing.pid !== pairing.pid ||
      currentPairing.deviceToken !== pairing.deviceToken ||
      currentPairing.publicKeyB64 !== pairing.publicKeyB64 ||
      currentPairing.loopbackEndpoint !== pairing.loopbackEndpoint
    ) {
      closeClient(1011);
      return;
    }
  } catch {
    closeClient(1011);
    return;
  }
  if (!isReady || clientClosed) {
    cleanup();
    if (!http101Sent) {
      socket.write(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nUpstream multiplex handshake failed",
      );
      socket.destroy();
    } else {
      closeClient(1011);
    }
    return;
  }

  // Complete WebSocket handshake with client BEFORE any binary frames
  const acceptKey = createWebSocketAccept(secKey);
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
  );
  http101Sent = true;

  // Send initial Subscribe frame to upstream for the resolved terminal handle
  const subscribePayload = encodeTerminalStreamJson({
    streamId: 1,
    terminal,
    client: {
      id: `uao-desktop-${crypto.randomUUID()}`,
      type: "desktop",
    },
    viewport: options.initialViewport ?? {
      cols: Math.min(
        500,
        Math.max(
          2,
          Math.floor(Number(options.parsedUrl.searchParams.get("cols"))) || 80,
        ),
      ),
      rows: Math.min(
        300,
        Math.max(
          2,
          Math.floor(Number(options.parsedUrl.searchParams.get("rows"))) || 24,
        ),
      ),
    },
    capabilities: {
      ackOutput: 1,
      desktopViewportClaims: 1,
      writeUnavailable: 1,
    },
  });
  const subscribeFrame = encodeTerminalStreamFrame({
    opcode: TerminalStreamOpcode.Subscribe,
    streamId: 0,
    seq: 0,
    payload: subscribePayload,
  });

  const subSent = upstreamSub.sendBinary(subscribeFrame);
  if (!subSent) {
    closeClient(1011);
    return;
  }

  const handleClientFrames = (frames: readonly WsParsedFrame[]): void => {
    for (const frame of frames) {
      if (frame.opcode === WsOpcode.Close) {
        closeClient(undefined);
        return;
      }
      if (frame.opcode === WsOpcode.Ping) {
        try {
          socket.write(encodeWebSocketFrame(frame.payload, WsOpcode.Pong));
        } catch {
          closeClient(undefined);
        }
        continue;
      }
      if (frame.opcode === WsOpcode.Binary) {
        const termFrame = decodeTerminalStreamFrame(frame.payload);
        if (termFrame === null) continue;
        if (termFrame.streamId !== 1) continue;
        const allowedOpcodes =
          termFrame.opcode === TerminalStreamOpcode.Input ||
          termFrame.opcode === TerminalStreamOpcode.Resize ||
          termFrame.opcode === TerminalStreamOpcode.Ack ||
          termFrame.opcode === TerminalStreamOpcode.ClaimViewport ||
          termFrame.opcode === TerminalStreamOpcode.SnapshotRequest ||
          termFrame.opcode === TerminalStreamOpcode.Unsubscribe;
        if (!allowedOpcodes) continue;

        if (termFrame.opcode === TerminalStreamOpcode.Unsubscribe) {
          closeClient(undefined);
          return;
        }

        try {
          const sent = upstreamSub?.sendBinary(frame.payload);
          if (sent === false) {
            closeClient(1011);
            return;
          }
        } catch {
          closeClient(1011);
          return;
        }
      }
    }
  };

  if (head.length > 0) {
    try {
      const initialFrames = parser.push(head);
      handleClientFrames(initialFrames);
    } catch (err) {
      const closeCode =
        err instanceof WebSocketProtocolError ? err.closeCode : 1002;
      closeClient(closeCode);
      return;
    }
  }

  socket.on("data", (chunk: Buffer) => {
    if (clientClosed) return;
    try {
      const parsedFrames = parser.push(chunk);
      handleClientFrames(parsedFrames);
    } catch (err) {
      const closeCode =
        err instanceof WebSocketProtocolError ? err.closeCode : 1002;
      closeClient(closeCode);
    }
  });
}
