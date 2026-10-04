import { describe, expect, it } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import {
  handleOrcaHttpRequest,
  sanitizeOrcaError,
  sanitizeOrcaResult,
  runOrcaCli,
} from "../uao-orca-adapter";

interface MockSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
}

type SpawnFn = typeof spawn;

function createMockSpawn(response: {
  readonly exitCode?: number | undefined;
  readonly stdout?: string | undefined;
  readonly stdoutParts?: readonly Buffer[] | undefined;
  readonly stderr?: string | undefined;
  readonly error?: Error | undefined;
}): {
  readonly spawnImpl: SpawnFn;
  readonly calls: MockSpawnCall[];
} {
  const calls: MockSpawnCall[] = [];

  const spawnImpl = ((command: unknown, args: unknown) => {
    calls.push({
      command: String(command),
      args: Array.isArray(args) ? [...args] : [],
    });
    const stdoutStream = new EventEmitter();
    const stderrStream = new EventEmitter();
    const proc = Object.assign(new EventEmitter(), {
      stdout: stdoutStream,
      stderr: stderrStream,
      kill: () => {},
    }) as ChildProcess;

    queueMicrotask(() => {
      if (response.error) {
        proc.emit("error", response.error);
        return;
      }
      if (response.stdout !== undefined) {
        stdoutStream.emit("data", Buffer.from(response.stdout, "utf8"));
      }
      for (const part of response.stdoutParts ?? []) stdoutStream.emit("data", part);
      if (response.stderr !== undefined) {
        stderrStream.emit("data", Buffer.from(response.stderr, "utf8"));
      }
      proc.emit("close", response.exitCode ?? 0);
    });

    return proc;
  }) as SpawnFn;

  return { spawnImpl, calls };
}

function createTestServer(spawnImpl: SpawnFn) {
  let boundPort = 0;
  const server = http.createServer(async (req, res) => {
    await handleOrcaHttpRequest(req, res, {
      port: boundPort,
      spawnImpl,
    });
  });

  return {
    server,
    listen: async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      boundPort = (server.address() as { port: number }).port;
      return boundPort;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("Orca CLI Bounded Adapter", () => {
  it("preserves Unicode terminal output across process chunk boundaries", async () => {
    const bytes = Buffer.from(JSON.stringify({ ok: true, result: { terminal: { tail: ["hello 😀"] } } }));
    const split = bytes.indexOf(Buffer.from("😀")) + 1;
    const { spawnImpl } = createMockSpawn({ stdoutParts: [bytes.subarray(0, split), bytes.subarray(split)] });
    const response = await runOrcaCli(["terminal", "read", "--json"], { spawnImpl });
    expect(response.ok).toBe(true);
    expect(response.data).toEqual({ ok: true, result: { terminal: { tail: ["hello 😀"] } } });
  });
  it.each([
    "not JSON",
    JSON.stringify({ ok: false, error: { message: "runtime unavailable" } }),
    JSON.stringify({ ok: true, result: {} }),
  ])("refuses malformed or failed CLI responses instead of inventing an empty inventory: %s", async (stdout) => {
    const { spawnImpl } = createMockSpawn({ stdout });
    const fixture = createTestServer(spawnImpl);
    const port = await fixture.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/uao-api/orca/repos`);
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.repos).toBeUndefined();
    } finally { await fixture.close(); }
  });

  it("preserves refused input and never retries it", async () => {
    const { spawnImpl, calls } = createMockSpawn({ stdout: JSON.stringify({ ok: true, result: { send: { accepted: false, refusedReason: "permission" } } }) });
    const fixture = createTestServer(spawnImpl);
    const port = await fixture.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ terminal: "term_123", text: "hello", enter: true }) });
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.send.refusedReason).toBe("permission");
      expect(calls).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  it.each([{ terminal: "term_123", text: "hello", enter: "true" }, { terminal: "term_123", text: "x".repeat(32001) }, { worktree: "id:repo::/path", agent: "shell", command: "rm" }])("rejects invalid mutation fields without spawning", async (body) => {
    const { spawnImpl, calls } = createMockSpawn({});
    const fixture = createTestServer(spawnImpl);
    const port = await fixture.listen();
    try {
      const action = "worktree" in body ? "create" : "send";
      const response = await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    } finally { await fixture.close(); }
  });

  it("does not relaunch an already reachable original runtime", async () => {
    const { spawnImpl, calls } = createMockSpawn({ stdout: JSON.stringify({ ok: true, result: { runtime: { reachable: true, state: "ready" } } }) });
    const fixture = createTestServer(spawnImpl);
    const port = await fixture.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/uao-api/orca/start`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(calls.every((call) => call.args[0] === "status")).toBe(true);
    } finally { await fixture.close(); }
  });

  describe("Sanitization & Error Redaction", () => {
    it("redacts auth tokens, bearer tokens, and prompt text from error messages", () => {
      const raw = 'Error: bearer abc123def456 failed with token="secret789" while running --text "super secret prompt"';
      const sanitized = sanitizeOrcaError(raw);
      expect(sanitized).not.toContain("abc123def456");
      expect(sanitized).not.toContain("secret789");
      expect(sanitized).not.toContain("super secret prompt");
      expect(sanitized).toContain("[REDACTED]");
    });

    it("strips authToken and sensitive tokens from result envelopes", () => {
      const resultWithTokens = {
        runtimeId: "rt-123",
        authToken: "secret-token",
        token: "another-token",
        nested: {
          launchToken: "dont-show",
          safeData: "hello",
        },
      };
      const sanitized = sanitizeOrcaResult(resultWithTokens);
      expect(sanitized).toEqual({
        runtimeId: "rt-123",
        nested: {
          safeData: "hello",
        },
      });
    });
  });

  describe("CLI Nested Envelope & Argument Formatting", () => {
    it("extracts nested result for repos", async () => {
      const { spawnImpl, calls } = createMockSpawn({
        stdout: JSON.stringify({
          id: "req-1",
          ok: true,
          result: {
            repos: [{ id: "repo-1", displayName: "my-repo" }],
          },
          _meta: { runtimeId: "rt-1" },
        }),
      });

      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/repos`, {
          headers: { Host: `127.0.0.1:${port}` },
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(data.repos).toEqual([{ id: "repo-1", displayName: "my-repo" }]);
        expect(calls[0]?.args).toEqual(["repo", "list", "--json"]);
      } finally {
        await fixture.close();
      }
    });

    it("passes screen read arguments with --screen and --limit 300", async () => {
      const { spawnImpl, calls } = createMockSpawn({
        stdout: JSON.stringify({
          id: "req-screen",
          ok: true,
          result: {
            terminal: {
              handle: "term_123",
              status: "running",
              tail: ["line 1", "line 2"],
              truncated: false,
              source: "screen",
            },
          },
          _meta: { runtimeId: "rt-1" },
        }),
      });

      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/uao-api/orca/terminal/read?terminal=term_123&limit=300`,
          { headers: { Host: `127.0.0.1:${port}` } },
        );
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(data.terminal.handle).toBe("term_123");
        expect(data.terminal.source).toBe("screen");
        expect(calls[0]?.args).toEqual([
          "terminal",
          "read",
          "--terminal",
          "term_123",
          "--screen",
          "--limit",
          "300",
          "--json",
        ]);
      } finally {
        await fixture.close();
      }
    });

    it("formats terminal send with explicit text and enter", async () => {
      const { spawnImpl, calls } = createMockSpawn({
        stdout: JSON.stringify({
          id: "req-send",
          ok: true,
          result: {
            send: {
              handle: "term_123",
              accepted: true,
              bytesWritten: 12,
              prompt: {
                requestId: "p-1",
                stages: ["input_accepted", "turn_started"],
              },
            },
            warnings: [],
          },
          _meta: { runtimeId: "rt-1" },
        }),
      });

      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/send`, {
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            terminal: "term_123",
            text: "npm test",
            enter: true,
          }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(data.send.accepted).toBe(true);
        expect(data.send.prompt.stages).toContain("turn_started");
        expect(calls[0]?.args).toEqual([
          "terminal",
          "send",
          "--terminal",
          "term_123",
          "--json",
          "--text",
          "npm test",
          "--enter",
        ]);
      } finally {
        await fixture.close();
      }
    });

    it("formats terminal send with interrupt flag", async () => {
      const { spawnImpl, calls } = createMockSpawn({
        stdout: JSON.stringify({
          id: "req-interrupt",
          ok: true,
          result: {
            send: {
              handle: "term_123",
              accepted: true,
              bytesWritten: 1,
            },
          },
        }),
      });

      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/send`, {
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            terminal: "term_123",
            interrupt: true,
          }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(calls[0]?.args).toEqual([
          "terminal",
          "send",
          "--terminal",
          "term_123",
          "--json",
          "--interrupt",
        ]);
      } finally {
        await fixture.close();
      }
    });

    it("formats terminal create for bounded agent choices and default shell", async () => {
      const { spawnImpl, calls } = createMockSpawn({
        stdout: JSON.stringify({
          id: "req-create",
          ok: true,
          result: {
            terminal: {
              handle: "term_new",
              worktreeId: "id:repo1::/path",
            },
          },
        }),
      });

      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        // 1. Default shell (no --command)
        await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/create`, {
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            worktree: "id:repo1::/path",
            agent: "shell",
          }),
        });
        expect(calls[0]?.args).toEqual([
          "terminal",
          "create",
          "--worktree",
          "id:repo1::/path",
          "--json",
        ]);

        // 2. Bounded agent claude
        await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/create`, {
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            worktree: "id:repo1::/path",
            agent: "claude",
          }),
        });
        expect(calls[1]?.args).toEqual([
          "terminal",
          "create",
          "--worktree",
          "id:repo1::/path",
          "--json",
          "--command",
          "claude",
        ]);
      } finally {
        await fixture.close();
      }
    });
  });

  describe("Bounded Bad Requests & Refusal (No Spawn)", () => {
    it("rejects disallowed agent in terminal/create without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/create`, {
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            worktree: "id:repo1::/path",
            agent: "malicious_script.sh",
          }),
        });
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toContain("Invalid agent choice");
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });

    it("rejects non-id selector in terminal/create without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/create`, {
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            worktree: "path:/not/an/id",
          }),
        });
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });

    it("rejects invalid terminal handle in terminal/read without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/uao-api/orca/terminal/read?terminal=term%20with%20spaces;rm`,
          { headers: { Host: `127.0.0.1:${port}` } },
        );
        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });

    it("rejects body larger than 64KB with 413 without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const hugePayload = JSON.stringify({
          terminal: "term_123",
          text: "x".repeat(70 * 1024),
        });

        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/terminal/send`, {
          method: "POST",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            "Content-Type": "application/json",
          },
          body: hugePayload,
        });
        expect(res.status).toBe(413);
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });

    it("rejects unknown actions with 404 without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/destructive-action`, {
          headers: { Host: `127.0.0.1:${port}` },
        });
        expect(res.status).toBe(404);
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });
  });

  describe("HTTP Cross-Origin Security (Cannot Spawn)", () => {
    it("rejects requests with untrusted Origin header without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/status`, {
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: "http://evil.attacker.com",
          },
        });
        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });

    it("rejects requests with sec-fetch-site: cross-site without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/uao-api/orca/status`, {
          headers: {
            Host: `127.0.0.1:${port}`,
            "Sec-Fetch-Site": "cross-site",
          },
        });
        expect(res.status).toBe(403);
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });

    it("rejects non-loopback Host headers without spawning", async () => {
      const { spawnImpl, calls } = createMockSpawn({});
      const fixture = createTestServer(spawnImpl);
      const port = await fixture.listen();

      try {
        const statusCode = await new Promise<number>((resolve, reject) => {
          const req = http.request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/uao-api/orca/status",
              method: "GET",
              headers: { Host: "attacker.domain.com" },
            },
            (res) => {
              resolve(res.statusCode ?? 0);
            },
          );
          req.on("error", reject);
          req.end();
        });
        expect(statusCode).toBe(403);
        expect(calls).toHaveLength(0); // NO SPAWN!
      } finally {
        await fixture.close();
      }
    });
  });
});

describe("Orca terminal exit cause", () => {
  it("reduces Orca's exit-cause object to a short label the UI can render", async () => {
    const { describeExitCause, normalizeTerminalList } = await import("../uao-orca-adapter");
    expect(describeExitCause({ kind: "exited", exitCode: 0 })).toBe("exited (code 0)");
    expect(describeExitCause({ kind: "operator_close" })).toBe("operator close");
    expect(describeExitCause({ kind: "spawn_failed", reason: "no such shell" })).toBe("spawn failed: no such shell");
    expect(describeExitCause("closed")).toBe("closed");
    expect(describeExitCause(undefined)).toBeUndefined();
    expect(describeExitCause(42)).toBeUndefined();
    const out = normalizeTerminalList([
      { handle: "a", exitCause: { kind: "exited", exitCode: 130 } },
      { handle: "b" },
      { handle: "c", exitCause: null },
    ]);
    expect(out).toEqual([
      { handle: "a", exitCause: "exited (code 130)" },
      { handle: "b" },
      { handle: "c" },
    ]);
    expect(normalizeTerminalList(undefined)).toEqual([]);
  });
});
