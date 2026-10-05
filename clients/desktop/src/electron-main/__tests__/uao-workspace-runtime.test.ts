import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  WorkspaceError,
  WorkspaceRuntime,
  decodeTmuxOutput,
  isValidBranchName,
} from "../uao-workspace-runtime";

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

describe("decodeTmuxOutput", () => {
  it("decodes octal escapes and keeps UTF-8", () => {
    expect(decodeTmuxOutput("hi\\015\\012").toString("utf8")).toBe("hi\r\n");
    expect(decodeTmuxOutput("\\033[1mx\\033[0m").toString("utf8")).toBe("\u001b[1mx\u001b[0m");
    expect(decodeTmuxOutput("café \\134 ok").toString("utf8")).toBe("café \\ ok");
  });
});

describe("isValidBranchName", () => {
  it("accepts ordinary names and rejects option-like or traversal names", () => {
    expect(isValidBranchName("feature/login-2")).toBe(true);
    for (const bad of ["", "-x", "a..b", "/a", "a/", "a b", "a;b", "x.lock", "a//b"]) {
      expect(isValidBranchName(bad)).toBe(false);
    }
  });
});

describe.skipIf(!hasTmux())("WorkspaceRuntime (real git + tmux)", () => {
  let root: string;
  let repo: string;
  let runtime: WorkspaceRuntime;
  const socket = `uao-rt-test-${process.pid}`;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "uao-rt-"));
    repo = path.join(root, "proj");
    fs.mkdirSync(repo);
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.txt"), "a");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    runtime = new WorkspaceRuntime({ dataDir: path.join(root, "data"), tmuxSocket: socket });
  });

  afterAll(() => {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("registers a repo once and lists its main worktree", async () => {
    const a = await runtime.addRepo(repo);
    const b = await runtime.addRepo(path.join(repo, "."));
    expect(b.id).toBe(a.id);
    const worktrees = await runtime.listWorktrees();
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({ branch: "main", isMain: true, liveTerminalCount: 0 });
  });

  it("rejects non-git folders and relative paths", async () => {
    await expect(runtime.addRepo(root)).rejects.toBeInstanceOf(WorkspaceError);
    await expect(runtime.addRepo("proj")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("creates and removes a worktree", async () => {
    const repoId = runtime.listRepos()[0]?.id ?? "";
    const made = await runtime.createWorktree({ repoId, branch: "feature/x" });
    expect(made.branch).toBe("feature/x");
    expect(fs.existsSync(made.path)).toBe(true);
    await expect(runtime.createWorktree({ repoId, branch: "-bad" })).rejects.toThrow(/Invalid branch/);
    await runtime.removeWorktree(`id:${made.worktreeId}`, false);
    expect(fs.existsSync(made.path)).toBe(false);
  });

  it("runs a persistent shell terminal: create, send, read, close", async () => {
    const main = (await runtime.listWorktrees())[0];
    expect(main).toBeDefined();
    const selector = `id:${main?.worktreeId ?? ""}`;
    const terminal = await runtime.createTerminal(selector, "shell");
    expect(terminal.handle).toMatch(/^term_/);
    expect(terminal.writable).toBe(true);

    // Never global: tmux 3.6 on macOS exits the server on session creation if it is.
    const tmuxOption = (...args: string[]): string =>
      execFileSync("tmux", ["-L", socket, "show-options", ...args, "window-size"], {
        encoding: "utf8",
      }).trim();
    expect(tmuxOption("-wv", "-t", terminal.handle)).toBe("manual");
    expect(tmuxOption("-gv")).not.toBe("manual");

    const sent = await runtime.sendToTerminal(terminal.handle, {
      text: "echo uao-$((20+22))",
      enter: true,
    });
    expect(sent.accepted).toBe(true);

    let tail: readonly string[] = [];
    for (let i = 0; i < 30 && !tail.some((l) => l === "uao-42"); i++) {
      await new Promise((r) => setTimeout(r, 200));
      tail = (await runtime.readTerminal(terminal.handle, 50)).tail;
    }
    expect(tail).toContain("uao-42");

    const listed = await runtime.listTerminals(selector);
    expect(listed.map((t) => t.handle)).toContain(terminal.handle);
    expect((await runtime.listWorktrees())[0]?.liveTerminalCount).toBe(1);

    const snap = await runtime.snapshot(terminal.handle);
    expect(snap.ansi).toContain("uao-42");

    await runtime.closeTerminal(terminal.handle);
    expect(await runtime.hasTerminal(terminal.handle)).toBe(false);
  });

  it("answers terminal queries for a terminal with no viewer attached", async () => {
    const probe = path.join(root, "probe.py");
    fs.writeFileSync(
      probe,
      [
        "import os, select, sys, termios, time, tty",
        "fd = sys.stdin.fileno(); old = termios.tcgetattr(fd); tty.setraw(fd)",
        "def ask(seq):",
        "    os.write(1, seq.encode()); buf = b''; end = time.time() + 2",
        "    while time.time() < end:",
        "        if select.select([fd], [], [], 0.2)[0]:",
        "            buf += os.read(fd, 256); break",
        "    return buf.hex()",
        "da1 = ask('\\x1b[c'); bg = ask('\\x1b]11;?\\x07')",
        "termios.tcsetattr(fd, termios.TCSADRAIN, old)",
        "print('DA1=' + da1); print('BG=' + bg)",
        "",
      ].join("\n"),
    );
    const hex = (text: string): string => Buffer.from(text, "latin1").toString("hex");

    await runtime.setTerminalColors({ fg: "#112233", bg: "#aabbcc" });
    const main = (await runtime.listWorktrees())[0];
    const terminal = await runtime.createTerminal(`id:${main?.worktreeId ?? ""}`, "shell");
    await runtime.sendToTerminal(terminal.handle, { text: `python3 ${probe}`, enter: true });

    let tail: readonly string[] = [];
    for (let i = 0; i < 50 && !tail.some((l) => l.startsWith("BG=")); i++) {
      await new Promise((r) => setTimeout(r, 200));
      tail = (await runtime.readTerminal(terminal.handle, 50)).tail;
    }
    await runtime.closeTerminal(terminal.handle);

    const da1 = tail.find((l) => l.startsWith("DA1="));
    const bg = tail.find((l) => l.startsWith("BG="));
    expect(da1?.slice(4)).toBe(hex("\u001b[?1;2;4c"));
    expect(bg?.slice(3)).toBe(hex("\u001b]11;rgb:aaaa/bbbb/cccc\u0007"));
  });

  it("ignores colours that are not #rrggbb", async () => {
    await runtime.setTerminalColors({ fg: "red; kill-server", bg: "#000000" });
    const style = execFileSync("tmux", ["-L", socket, "show-options", "-gv", "window-style"], {
      encoding: "utf8",
    }).trim();
    expect(style).toBe("fg=#112233,bg=#aabbcc");
  });

  it("refuses to remove a repo that still has terminals", async () => {
    const main = (await runtime.listWorktrees())[0];
    const terminal = await runtime.createTerminal(`id:${main?.worktreeId ?? ""}`, "shell");
    await expect(runtime.removeRepo(runtime.listRepos()[0]?.id ?? "")).rejects.toThrow(/terminals/);
    await runtime.closeTerminal(terminal.handle);
  });
});
