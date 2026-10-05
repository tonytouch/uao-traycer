import type http from "node:http";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Socket } from "node:net";
import type { URL } from "node:url";
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
} from "@traycer-clients/shared/uao/terminal-stream-protocol";
import {
  WebSocketFrameParser,
  WebSocketProtocolError,
  WsOpcode,
  createWebSocketAccept,
  encodeWebSocketCloseFrame,
  encodeWebSocketFrame,
  type WsParsedFrame,
} from "./uao-rfc6455";
import {
  WORKSPACE_AGENTS,
  WorkspaceError,
  decodeTmuxOutput,
  type WorkspaceAgent,
  type WorkspaceRuntime,
} from "./uao-workspace-runtime";

/** URL prefix of the runtime on this machine, and on the paired server. */
export const UAO_WORKSPACES_PREFIX = "/uao-api/workspaces";
export const UAO_WORKSPACES_SERVER_PREFIX = "/uao-api/workspaces-server";

const MAX_BODY_BYTES = 64 * 1024;
const SNAPSHOT_CHUNK_BYTES = 64 * 1024;
const MAX_QUEUED_SOCKET_BYTES = 8 * 1024 * 1024;

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function isValidWorktreeSelector(selector: string): boolean {
  if (!selector.startsWith("id:")) return false;
  const id = selector.slice(3).trim();
  return id.length > 0 && id.length <= 500 && !/[\r\n\0\t\x1b]/.test(id);
}

export function isValidTerminalHandle(handle: string): boolean {
  return /^term_[A-Za-z0-9-]{1,100}$/.test(handle);
}

function readJsonBody(
  req: http.IncomingMessage,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (
      value: { ok: true; body: Record<string, unknown> } | { ok: false; error: string; status: number },
    ): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, error: "Payload too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        finish({ ok: true, body: {} });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          finish({ ok: false, status: 400, error: "JSON body must be an object" });
          return;
        }
        finish({ ok: true, body: parsed as Record<string, unknown> });
      } catch {
        finish({ ok: false, status: 400, error: "Malformed JSON" });
      }
    });
    req.on("error", () => finish({ ok: false, status: 400, error: "Bad request" }));
  });
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

export interface WorkspaceHttpOptions {
  readonly runtime: WorkspaceRuntime;
  readonly parsedUrl: URL;
}

/** Handles `/uao-api/workspaces/*`. Returns false for any other path. */
export async function handleWorkspaceHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: WorkspaceHttpOptions,
): Promise<boolean> {
  const { runtime, parsedUrl } = options;
  const pathname = parsedUrl.pathname;
  if (pathname !== UAO_WORKSPACES_PREFIX && !pathname.startsWith(`${UAO_WORKSPACES_PREFIX}/`)) {
    return false;
  }
  const subpath = pathname.slice(UAO_WORKSPACES_PREFIX.length) || "/";
  const method = req.method ?? "GET";
  const fail = (status: number, error: string): true => {
    sendJson(res, status, { ok: false, error });
    return true;
  };
  const wrongMethod = (): true => fail(405, "Method Not Allowed");

  try {
    if (subpath === "/status" || subpath === "/start") {
      if (method !== (subpath === "/start" ? "POST" : "GET")) return wrongMethod();
      const status = await runtime.status();
      const body = {
        ok: true,
        result: {
          target: { kind: "local" },
          app: { running: status.reachable },
          runtime: {
            state: status.state,
            reachable: status.reachable,
            connectionState: status.reachable ? "connected" : "unavailable",
            runtimeId: runtime.runtimeId,
            appVersion: "UAO workspaces",
          },
        },
      };
      sendJson(res, 200, subpath === "/start" ? { ...body, open: body } : body);
      return true;
    }

    if (subpath === "/repos") {
      if (method === "GET") {
        sendJson(res, 200, { ok: true, repos: runtime.listRepos() });
        return true;
      }
      if (method !== "POST") return wrongMethod();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      if (!onlyKeys(parsed.body, ["path"]) || typeof parsed.body.path !== "string") {
        return fail(400, "Expected {path}");
      }
      sendJson(res, 200, { ok: true, repo: await runtime.addRepo(parsed.body.path) });
      return true;
    }

    if (subpath === "/repos/remove") {
      if (method !== "POST") return wrongMethod();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      if (!onlyKeys(parsed.body, ["repo"]) || typeof parsed.body.repo !== "string") {
        return fail(400, "Expected {repo}");
      }
      await runtime.removeRepo(parsed.body.repo);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (subpath === "/worktrees") {
      if (method === "GET") {
        const worktrees = await runtime.listWorktrees();
        sendJson(res, 200, { ok: true, worktrees, totalCount: worktrees.length });
        return true;
      }
      if (method !== "POST") return wrongMethod();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      const { repo, branch, base } = parsed.body;
      if (
        !onlyKeys(parsed.body, ["repo", "branch", "base"]) ||
        typeof repo !== "string" ||
        typeof branch !== "string" ||
        (base !== undefined && typeof base !== "string")
      ) {
        return fail(400, "Expected {repo, branch, base?}");
      }
      sendJson(res, 200, {
        ok: true,
        worktree: await runtime.createWorktree({ repoId: repo, branch, base }),
      });
      return true;
    }

    if (subpath === "/worktrees/remove") {
      if (method !== "POST") return wrongMethod();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      const { worktree, force } = parsed.body;
      if (
        !onlyKeys(parsed.body, ["worktree", "force"]) ||
        typeof worktree !== "string" ||
        !isValidWorktreeSelector(worktree) ||
        (force !== undefined && typeof force !== "boolean")
      ) {
        return fail(400, "Expected {worktree: id:<id>, force?}");
      }
      await runtime.removeWorktree(worktree, force === true);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (subpath === "/terminals") {
      if (method !== "GET") return wrongMethod();
      const worktree = parsedUrl.searchParams.get("worktree");
      if (worktree === null || !isValidWorktreeSelector(worktree)) {
        return fail(400, "Invalid or missing worktree selector. Expected format id:<id>");
      }
      sendJson(res, 200, { ok: true, terminals: await runtime.listTerminals(worktree) });
      return true;
    }

    if (subpath === "/terminal/read") {
      if (method !== "GET") return wrongMethod();
      const terminal = parsedUrl.searchParams.get("terminal");
      if (terminal === null || !isValidTerminalHandle(terminal)) {
        return fail(400, "Invalid or missing terminal handle");
      }
      const rawLimit = Number.parseInt(parsedUrl.searchParams.get("limit") ?? "", 10);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 1000 ? rawLimit : 300;
      sendJson(res, 200, { ok: true, terminal: await runtime.readTerminal(terminal, limit) });
      return true;
    }

    if (subpath === "/terminal/send") {
      if (method !== "POST") return wrongMethod();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      const { terminal, text, enter, interrupt } = parsed.body;
      if (
        !onlyKeys(parsed.body, ["terminal", "text", "enter", "interrupt"]) ||
        typeof terminal !== "string" ||
        !isValidTerminalHandle(terminal) ||
        (text !== undefined &&
          (typeof text !== "string" || text.length > 32000 || text.includes("\0"))) ||
        (enter !== undefined && typeof enter !== "boolean") ||
        (interrupt !== undefined && typeof interrupt !== "boolean")
      ) {
        return fail(400, "Invalid terminal input");
      }
      if (interrupt !== true && (typeof text !== "string" || text.length === 0)) {
        return fail(400, "send requires either interrupt=true or non-empty text");
      }
      const send = await runtime.sendToTerminal(terminal, {
        text: typeof text === "string" ? text : undefined,
        enter: typeof enter === "boolean" ? enter : undefined,
        interrupt: interrupt === true,
      });
      sendJson(res, 200, { ok: send.accepted, send, warnings: [] });
      return true;
    }

    if (subpath === "/terminal/create") {
      if (method !== "POST") return wrongMethod();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      const { worktree, agent } = parsed.body;
      if (!onlyKeys(parsed.body, ["worktree", "agent"])) {
        return fail(400, "Unknown terminal creation option");
      }
      if (typeof worktree !== "string" || !isValidWorktreeSelector(worktree)) {
        return fail(400, "Invalid or missing worktree selector. Expected format id:<id>");
      }
      const choice = agent ?? "shell";
      if (typeof choice !== "string" || !WORKSPACE_AGENTS.includes(choice as WorkspaceAgent)) {
        return fail(400, `Invalid agent choice. Allowed choices: ${WORKSPACE_AGENTS.join(", ")}`);
      }
      sendJson(res, 200, {
        ok: true,
        terminal: await runtime.createTerminal(worktree, choice as WorkspaceAgent),
      });
      return true;
    }

    if (subpath === "/terminal/close") {
      if (method !== "POST") return wrongMethod();
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return fail(parsed.status, parsed.error);
      const { terminal } = parsed.body;
      if (
        !onlyKeys(parsed.body, ["terminal"]) ||
        typeof terminal !== "string" ||
        !isValidTerminalHandle(terminal)
      ) {
        return fail(400, "Invalid or missing terminal handle");
      }
      await runtime.closeTerminal(terminal);
      sendJson(res, 200, { ok: true });
      return true;
    }

    return fail(404, `Not Found: Unknown workspace action '${subpath}'`);
  } catch (error) {
    if (error instanceof WorkspaceError) return fail(error.status, error.message);
    return fail(500, "Workspace request failed");
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Live view of one terminal over the Workspace-compatible binary multiplex the
 * renderer's xterm already speaks: a snapshot, then output frames, with
 * keystrokes and viewport changes coming back. Output comes from a tmux
 * control-mode client; input goes to it as `send-keys -H`.
 */
export async function handleWorkspaceStreamUpgrade(
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
  options: WorkspaceHttpOptions,
): Promise<void> {
  const { runtime, parsedUrl } = options;
  const reject = (line: string): void => {
    socket.write(`HTTP/1.1 ${line}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  const handle = parsedUrl.searchParams.get("terminal");
  if (handle === null || !isValidTerminalHandle(handle)) return reject("400 Bad Request");
  const key = req.headers["sec-websocket-key"];
  if (
    req.headers["sec-websocket-version"] !== "13" ||
    typeof key !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)
  ) {
    return reject("400 Bad Request");
  }
  if (!(await runtime.hasTerminal(handle))) return reject("404 Not Found");

  const initialCols = clampInt(Number(parsedUrl.searchParams.get("cols")), 2, 500, 120);
  const initialRows = clampInt(Number(parsedUrl.searchParams.get("rows")), 2, 300, 32);

  const control = spawn("tmux", runtime.controlArgs(handle), {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let closed = false;
  let live = false;
  let seq = 0;
  const decoder = new StringDecoder("utf8");

  const frame = (
    opcode: TerminalStreamOpcode,
    payload: Uint8Array,
    frameSeq: number | undefined,
  ): void => {
    if (closed || socket.destroyed) return;
    if (socket.writableLength > MAX_QUEUED_SOCKET_BYTES) {
      close(1013);
      return;
    }
    socket.write(
      encodeWebSocketFrame(
        encodeTerminalStreamFrame({ opcode, streamId: 1, seq: frameSeq ?? 0, payload }),
        WsOpcode.Binary,
      ),
    );
  };
  const close = (code: number): void => {
    if (closed) return;
    closed = true;
    try {
      control.stdin.end();
      control.kill();
    } catch {
      // already gone
    }
    try {
      socket.write(encodeWebSocketCloseFrame(code));
      socket.end();
    } catch {
      socket.destroy();
    }
  };
  const command = (line: string): void => {
    if (!closed && control.stdin.writable) control.stdin.write(`${line}\n`);
  };

  socket.once("close", () => {
    closed = true;
    control.kill();
  });
  socket.on("error", () => {
    closed = true;
    control.kill();
    socket.destroy();
  });
  control.on("error", () => close(1011));
  control.on("exit", () => close(1000));

  let buffered = "";
  control.stdout.setEncoding("utf8");
  control.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      if (line.startsWith("%output ") && live) {
        const rest = line.slice(8);
        const space = rest.indexOf(" ");
        if (space !== -1) {
          const text = decoder.write(decodeTmuxOutput(rest.slice(space + 1)));
          if (text.length > 0) {
            seq += text.length;
            frame(TerminalStreamOpcode.Output, Buffer.from(text, "utf8"), seq);
          }
        }
      } else if (line.startsWith("%exit")) {
        close(1000);
      }
      newline = buffered.indexOf("\n");
    }
  });

  // Handshake first so the client is listening before any frames.
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}\r\n\r\n`,
  );

  command(`resize-window -t ${handle} -x ${initialCols} -y ${initialRows}`);
  try {
    const snap = await runtime.snapshot(handle);
    if (closed) return;
    frame(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ cols: snap.cols, rows: snap.rows, seq: 0 }),
      undefined,
    );
    const bytes = Buffer.from(snap.ansi, "utf8");
    for (let offset = 0; offset < bytes.length; offset += SNAPSHOT_CHUNK_BYTES) {
      frame(
        TerminalStreamOpcode.SnapshotChunk,
        bytes.subarray(offset, offset + SNAPSHOT_CHUNK_BYTES),
        undefined,
      );
    }
    frame(TerminalStreamOpcode.SnapshotEnd, new Uint8Array(0), undefined);
    live = true;
  } catch {
    close(1011);
    return;
  }

  const hex = (data: Buffer): string[] =>
    Array.from(data, (byte) => byte.toString(16).padStart(2, "0"));

  const onFrames = (frames: readonly WsParsedFrame[]): void => {
    for (const ws of frames) {
      if (ws.opcode === WsOpcode.Close) return close(1000);
      if (ws.opcode === WsOpcode.Ping) {
        socket.write(encodeWebSocketFrame(ws.payload, WsOpcode.Pong));
        continue;
      }
      if (ws.opcode !== WsOpcode.Binary) continue;
      const term = decodeTerminalStreamFrame(ws.payload);
      if (term === null || term.streamId !== 1) continue;
      if (term.opcode === TerminalStreamOpcode.Unsubscribe) return close(1000);
      if (term.opcode === TerminalStreamOpcode.Input) {
        const bytes = Buffer.from(term.payload);
        for (let offset = 0; offset < bytes.length; offset += 256) {
          command(
            `send-keys -t ${handle} -H ${hex(bytes.subarray(offset, offset + 256)).join(" ")}`,
          );
        }
      } else if (
        term.opcode === TerminalStreamOpcode.Resize ||
        term.opcode === TerminalStreamOpcode.ClaimViewport
      ) {
        const size = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(term.payload);
        if (size !== null) {
          const cols = clampInt(size.cols, 2, 500, 0);
          const rows = clampInt(size.rows, 2, 300, 0);
          if (cols > 0 && rows > 0) command(`resize-window -t ${handle} -x ${cols} -y ${rows}`);
        }
      }
    }
  };

  const parser = new WebSocketFrameParser();
  const feed = (chunk: Buffer): void => {
    if (closed) return;
    try {
      onFrames(parser.push(chunk));
    } catch (error) {
      close(error instanceof WebSocketProtocolError ? error.closeCode : 1002);
    }
  };
  if (head.length > 0) feed(head);
  socket.on("data", feed);
}
