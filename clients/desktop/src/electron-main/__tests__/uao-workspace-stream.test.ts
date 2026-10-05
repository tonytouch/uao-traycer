// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
} from "@traycer-clients/shared/uao/terminal-stream-protocol";
import { startUaoServer, type UaoServerInstance } from "../uao-server";
import { WorkspaceRuntime } from "../uao-workspace-runtime";

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasTmux())("workspace terminal live stream", () => {
  let root: string;
  let server: UaoServerInstance;
  const socket = `uao-stream-test-${process.pid}`;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "uao-stream-"));
    const repo = path.join(root, "proj");
    fs.mkdirSync(repo);
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "t"],
      ["commit", "-q", "--allow-empty", "-m", "init"],
    ]) {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    }
    const runtime = new WorkspaceRuntime({ dataDir: path.join(root, "data"), tmuxSocket: socket });
    await runtime.addRepo(repo);
    server = await startUaoServer({ staticDir: root, backendPort: 1, workspaceRuntime: runtime });
  });

  afterAll(async () => {
    await server.close();
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function api<T>(
    route: string,
    ...args: readonly [] | readonly [unknown]
  ): Promise<T> {
    const body = args[0];
    const response = await fetch(`${server.origin}/uao-api/workspaces${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await response.json()) as T;
  }

  it("replays the screen, streams output and accepts keystrokes", async () => {
    const { worktrees } = await api<{ worktrees: { worktreeId: string }[] }>("/worktrees");
    const worktree = `id:${worktrees[0]?.worktreeId ?? ""}`;
    const { terminal } = await api<{ terminal: { handle: string } }>("/terminal/create", {
      worktree,
      agent: "shell",
    });

    const url = `${server.origin.replace("http", "ws")}/uao-api/workspaces/terminal/stream?terminal=${terminal.handle}&cols=100&rows=30`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const opcodes: number[] = [];
    let output = "";
    let lastSeq = 0;
    const decoder = new TextDecoder();
    ws.onmessage = (event) => {
      const frame = decodeTerminalStreamFrame(new Uint8Array(event.data as ArrayBuffer));
      if (frame === null) return;
      opcodes.push(frame.opcode);
      if (frame.opcode === TerminalStreamOpcode.Output) {
        output += decoder.decode(frame.payload);
        lastSeq = frame.seq;
      }
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket failed"));
    });

    const until = async (ok: () => boolean): Promise<void> => {
      for (let i = 0; i < 50 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
    };
    await until(() => opcodes.includes(TerminalStreamOpcode.SnapshotEnd));
    expect(opcodes.slice(0, 2)).toEqual([
      TerminalStreamOpcode.SnapshotStart,
      expect.any(Number),
    ]);
    expect(opcodes).toContain(TerminalStreamOpcode.SnapshotEnd);

    ws.send(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.ClaimViewport,
        streamId: 1,
        seq: 0,
        payload: encodeTerminalStreamJson({ cols: 90, rows: 25 }),
      }),
    );
    ws.send(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        streamId: 1,
        seq: 0,
        payload: encodeTerminalStreamText("echo stream-$((6*7))\r"),
      }),
    );
    await until(() => output.includes("stream-42"));
    expect(output).toContain("stream-42");
    expect(lastSeq).toBe(output.length);

    ws.close();
    await api("/terminal/close", { terminal: terminal.handle });
  });

  it("rejects a stream for an unknown terminal", async () => {
    const ws = new WebSocket(
      `${server.origin.replace("http", "ws")}/uao-api/workspaces/terminal/stream?terminal=term_nope`,
    );
    const failed = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(false);
      ws.onerror = () => resolve(true);
      ws.onclose = () => resolve(true);
    });
    expect(failed).toBe(true);
  });
});
