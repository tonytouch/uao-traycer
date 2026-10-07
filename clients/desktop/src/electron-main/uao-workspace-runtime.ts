/**
 * UAO's own workspace runtime: registered git repos, their worktrees, and
 * persistent agent terminals. Terminals are tmux sessions on a private socket
 * (`tmux -L uao`), so they survive the desktop restarting and need no native
 * module. Nothing here depends on Workspace.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

export const WORKSPACE_AGENTS = ["shell", "claude", "codex", "hermes"] as const;
export type WorkspaceAgent = (typeof WORKSPACE_AGENTS)[number];

const AGENT_COMMANDS: Readonly<Record<Exclude<WorkspaceAgent, "shell">, string>> = {
  claude: "claude",
  codex: "codex",
  hermes: "hermes",
};

const EXEC_TIMEOUT_MS = 15_000;
const SEP = "\u001f";

export interface WorkspaceRepo {
  readonly id: string;
  readonly path: string;
  readonly displayName: string;
  readonly kind: "git";
  readonly addedAt: number;
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
  readonly workspaceStatus: string;
  readonly isMain: boolean;
  readonly liveTerminalCount: number;
  readonly agents: readonly WorkspaceAgentStatus[];
  readonly lastActivityAt: number | null;
}

export interface WorkspaceTerminal {
  readonly handle: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly title: string | null;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly lastOutputAt: number | null;
  readonly preview: string;
  readonly agentIdentity?: string;
  readonly exitCause?: string;
}

export class WorkspaceError extends Error {
  readonly status: number;

  constructor(message: string, status: number | undefined) {
    super(message);
    this.status = status ?? 400;
  }
}

export type ExecResult = {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
};
export interface ExecFn {
  (
    file: string,
    args: readonly string[],
    ...options: readonly [] | readonly [{ readonly cwd?: string }]
  ): Promise<ExecResult>;
}

export const defaultExec = (
  file: string,
  args: readonly string[],
  ...options: readonly [] | readonly [{ readonly cwd?: string }]
): Promise<ExecResult> =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        cwd: options[0]?.cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8" },
      },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, stdout, stderr });
      },
    );
  });

export interface TerminalColors {
  readonly fg: string;
  readonly bg: string;
}

/** Dark default so a program that asks never sees tmux's black-on-black. */
export const DEFAULT_TERMINAL_COLORS: TerminalColors = { fg: "#d4d4d4", bg: "#1e1e1e" };

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function terminalWindowStyle(colors: TerminalColors): string {
  return `fg=${colors.fg.toLowerCase()},bg=${colors.bg.toLowerCase()}`;
}

/** Decode a tmux control-mode `%output` payload (octal-escaped bytes). */
export function decodeTmuxOutput(escaped: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    const code = escaped.charCodeAt(i);
    if (
      code === 0x5c &&
      i + 3 < escaped.length + 0 &&
      /^[0-7]{3}$/.test(escaped.slice(i + 1, i + 4))
    ) {
      out.push(Number.parseInt(escaped.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (code < 0x80) {
      out.push(code);
    } else {
      for (const byte of Buffer.from(escaped[i] ?? "", "utf8")) out.push(byte);
    }
  }
  return Buffer.from(out);
}

export function isValidBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//")
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
}

export interface WorkspaceRuntimeOptions {
  readonly dataDir?: string;
  /** Defaults beside `dataDir` so a custom runtime root remains self-contained. */
  readonly worktreesDir?: string;
  readonly exec?: ExecFn;
  readonly tmuxSocket?: string;
  readonly shell?: string;
}

interface StoredState {
  readonly repos: readonly WorkspaceRepo[];
}

interface RawSession {
  readonly name: string;
  readonly worktreeId: string;
  readonly agent: string;
  readonly createdAt: number;
  readonly activity: number;
  readonly dead: boolean;
  readonly deadStatus: string;
}

export class WorkspaceRuntime {
  readonly runtimeId: string;
  readonly dataDir: string;
  readonly worktreesDir: string;
  readonly tmuxSocket: string;
  private readonly exec: ExecFn;
  private windowStyle: string = terminalWindowStyle(DEFAULT_TERMINAL_COLORS);
  private readonly shell: string;
  private serverReady: Promise<void> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceRuntimeOptions) {
    const resolvedOptions = options;
    this.dataDir =
      resolvedOptions.dataDir ??
      process.env.UAO_WORKSPACE_DIR ??
      path.join(os.homedir(), ".uao", "workspaces");
    this.worktreesDir =
      resolvedOptions.worktreesDir ??
      process.env.UAO_WORKTREES_DIR ??
      path.join(path.dirname(this.dataDir), "worktrees");
    this.exec = resolvedOptions.exec ?? defaultExec;
    this.tmuxSocket = resolvedOptions.tmuxSocket ?? process.env.UAO_TMUX_SOCKET ?? "uao";
    this.shell = resolvedOptions.shell ?? process.env.SHELL ?? "/bin/bash";
    this.runtimeId = `uao-${crypto
      .createHash("sha256")
      .update(this.dataDir)
      .digest("hex")
      .slice(0, 12)}`;
  }

  // ---- tmux ---------------------------------------------------------------

  tmuxArgs(args: readonly string[]): string[] {
    return ["-L", this.tmuxSocket, "-f", "/dev/null", ...args];
  }

  private tmux(args: readonly string[]): Promise<ExecResult> {
    return this.exec("tmux", this.tmuxArgs(args));
  }

  private ensureServer(): Promise<void> {
    this.serverReady ??= this.tmux([
      "start-server",
      ";",
      "set-option",
      "-g",
      "exit-empty",
      "off",
      ";",
      "set-option",
      "-g",
      "remain-on-exit",
      "on",
      ";",
      "set-option",
      "-g",
      "status",
      "off",
      ";",
      "set-option",
      "-g",
      "history-limit",
      "50000",
      ";",
      "set-option",
      "-g",
      "escape-time",
      "0",
      ";",
      "set-option",
      "-g",
      "mouse",
      "off",
      ";",
      "set-option",
      "-g",
      "default-terminal",
      "tmux-256color",
      ";",
      "set-option",
      "-g",
      "window-style",
      terminalWindowStyle(DEFAULT_TERMINAL_COLORS),
    ]).then(() => undefined);
    return this.serverReady;
  }

  /**
   * Tell tmux which colors the viewer paints. tmux answers a program's
   * OSC 10/11 (foreground/background) query itself, even with no client
   * attached, but only from `window-style`; unset it replies black on black
   * with a control-mode client and not at all when detached, so TUIs that
   * probe for a light or dark theme guess wrong or stall.
   */
  async setTerminalColors(colors: TerminalColors): Promise<void> {
    if (!isHexColor(colors.fg) || !isHexColor(colors.bg)) return;
    const style = terminalWindowStyle(colors);
    if (style === this.windowStyle) return;
    await this.ensureServer();
    const result = await this.tmux(["set-option", "-g", "window-style", style]);
    if (result.ok) this.windowStyle = style;
  }

  async tmuxAvailable(): Promise<boolean> {
    return (await this.exec("tmux", ["-V"])).ok;
  }

  async status(): Promise<{
    readonly reachable: boolean;
    readonly state: string;
  }> {
    if (!(await this.tmuxAvailable())) {
      return { reachable: false, state: "tmux_missing" };
    }
    return { reachable: true, state: "ready" };
  }

  // ---- repos --------------------------------------------------------------

  private get stateFile(): string {
    return path.join(this.dataDir, "workspaces.json");
  }

  private readState(): StoredState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as {
        repos?: unknown;
      };
      const repos = Array.isArray(raw.repos) ? raw.repos : [];
      return {
        repos: repos.filter(
          (repo): repo is WorkspaceRepo =>
            typeof repo === "object" &&
            repo !== null &&
            typeof (repo as WorkspaceRepo).id === "string" &&
            typeof (repo as WorkspaceRepo).path === "string",
        ),
      };
    } catch {
      return { repos: [] };
    }
  }

  private writeState(state: StoredState): void {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }

  /** Serialize read-modify-write cycles on the state file. */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  listRepos(): readonly WorkspaceRepo[] {
    return this.readState().repos;
  }

  addRepo(inputPath: string): Promise<WorkspaceRepo> {
    return this.mutate(async () => {
      if (!path.isAbsolute(inputPath) || inputPath.includes("\0")) {
        throw new WorkspaceError("Repo path must be absolute", undefined);
      }
      let real: string;
      try {
        real = fs.realpathSync(inputPath);
        if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new WorkspaceError("Repo path is not a directory", undefined);
      }
      const top = await this.exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: real,
      });
      if (!top.ok) throw new WorkspaceError("Not a git repository", undefined);
      const root = fs.realpathSync(top.stdout.trim());
      const state = this.readState();
      const existing = state.repos.find((repo) => repo.path === root);
      if (existing !== undefined) return existing;
      const repo: WorkspaceRepo = {
        id: crypto.randomUUID(),
        path: root,
        displayName: path.basename(root),
        kind: "git",
        addedAt: Date.now(),
      };
      this.writeState({ repos: [...state.repos, repo] });
      return repo;
    });
  }

  removeRepo(repoId: string): Promise<void> {
    return this.mutate(async () => {
      const state = this.readState();
      if (!state.repos.some((repo) => repo.id === repoId)) {
        throw new WorkspaceError("Unknown repo", 404);
      }
      const live = (await this.rawSessions()).filter((s) =>
        s.worktreeId.startsWith(`${repoId}::`),
      );
      if (live.length > 0) {
        throw new WorkspaceError("Close the repo's terminals first", 409);
      }
      this.writeState({ repos: state.repos.filter((repo) => repo.id !== repoId) });
    });
  }

  // ---- worktrees ----------------------------------------------------------

  private async gitWorktrees(
    repo: WorkspaceRepo,
  ): Promise<{ path: string; branch: string; isMain: boolean }[] | null> {
    const result = await this.exec("git", ["worktree", "list", "--porcelain"], {
      cwd: repo.path,
    });
    if (!result.ok) return null;
    const entries: { path: string; branch: string; isMain: boolean }[] = [];
    for (const block of result.stdout.split(/\n\n+/)) {
      let wtPath = "";
      let branch = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) wtPath = line.slice(9);
        else if (line.startsWith("branch ")) {
          branch = line.slice(7).replace(/^refs\/heads\//, "");
        } else if (line === "detached") branch = "(detached)";
      }
      if (wtPath.length > 0) {
        entries.push({
          path: wtPath,
          branch,
          isMain: entries.length === 0,
        });
      }
    }
    return entries;
  }

  async listWorktrees(): Promise<readonly WorkspaceWorktree[]> {
    const repos = this.listRepos();
    const sessions = await this.rawSessions();
    const lists = await Promise.all(repos.map((repo) => this.gitWorktrees(repo)));
    const out: WorkspaceWorktree[] = [];
    repos.forEach((repo, index) => {
      const entries = lists[index];
      if (entries === null || entries === undefined) {
        out.push(
          this.worktreeRow(repo, sessions, {
            path: repo.path,
            branch: "",
            isMain: true,
          }, "missing"),
        );
        return;
      }
      for (const entry of entries) {
        out.push(this.worktreeRow(repo, sessions, entry, "ready"));
      }
    });
    return out;
  }

  private worktreeRow(
    repo: WorkspaceRepo,
    sessions: readonly RawSession[],
    entry: { path: string; branch: string; isMain: boolean },
    status: string,
  ): WorkspaceWorktree {
    const worktreeId = `${repo.id}::${entry.path}`;
    const mine = sessions.filter((s) => s.worktreeId === worktreeId);
    const live = mine.filter((s) => !s.dead);
    const now = Date.now();
    return {
      worktreeId,
      repo: repo.displayName,
      repoId: repo.id,
      path: entry.path,
      branch: entry.branch,
      displayName: entry.branch || path.basename(entry.path),
      workspaceStatus: status,
      isMain: entry.isMain,
      liveTerminalCount: live.length,
      agents: live
        .filter((s) => s.agent !== "shell")
        .map((s) => ({
          paneKey: s.name,
          agentType: s.agent,
          state: now - s.activity * 1000 < 5000 ? "working" : "idle",
        })),
      lastActivityAt:
        mine.length === 0 ? null : Math.max(...mine.map((s) => s.activity)) * 1000,
    };
  }

  async resolveWorktree(selector: string): Promise<WorkspaceWorktree> {
    const id = selector.startsWith("id:") ? selector.slice(3) : selector;
    const found = (await this.listWorktrees()).find((wt) => wt.worktreeId === id);
    if (found === undefined) throw new WorkspaceError("Unknown worktree", 404);
    if (found.workspaceStatus !== "ready") {
      throw new WorkspaceError("Worktree is missing on disk", 409);
    }
    return found;
  }

  createWorktree(input: {
    readonly repoId: string;
    readonly branch: string;
    readonly base?: string | undefined;
  }): Promise<WorkspaceWorktree> {
    return this.mutate(async () => {
      const repo = this.listRepos().find((r) => r.id === input.repoId);
      if (repo === undefined) throw new WorkspaceError("Unknown repo", 404);
      if (!isValidBranchName(input.branch)) {
        throw new WorkspaceError("Invalid branch name", undefined);
      }
      if (input.base !== undefined && !isValidBranchName(input.base)) {
        throw new WorkspaceError("Invalid base ref", undefined);
      }
      const target = path.join(
        this.worktreesDir,
        slug(repo.displayName),
        slug(input.branch),
      );
      if (fs.existsSync(target)) {
        throw new WorkspaceError("A worktree for that branch already exists", 409);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const branchExists = (
        await this.exec(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`],
          { cwd: repo.path },
        )
      ).ok;
      const args = branchExists
        ? ["worktree", "add", target, input.branch]
        : [
            "worktree",
            "add",
            "-b",
            input.branch,
            target,
            ...(input.base !== undefined ? [input.base] : []),
          ];
      const added = await this.exec("git", args, { cwd: repo.path });
      if (!added.ok) {
        throw new WorkspaceError(
          `git worktree add failed: ${added.stderr.trim().slice(0, 300)}`,
          undefined,
        );
      }
      return this.resolveWorktree(`id:${repo.id}::${fs.realpathSync(target)}`).catch(
        () => this.resolveWorktree(`id:${repo.id}::${target}`),
      );
    });
  }

  removeWorktree(selector: string, force: boolean): Promise<void> {
    return this.mutate(async () => {
      const worktree = await this.resolveWorktree(selector);
      if (worktree.isMain) {
        throw new WorkspaceError("The main worktree cannot be removed", 409);
      }
      if (worktree.liveTerminalCount > 0) {
        throw new WorkspaceError("Close the worktree's terminals first", 409);
      }
      const repo = this.listRepos().find((r) => r.id === worktree.repoId);
      if (repo === undefined) throw new WorkspaceError("Unknown repo", 404);
      const removed = await this.exec(
        "git",
        ["worktree", "remove", ...(force ? ["--force"] : []), worktree.path],
        { cwd: repo.path },
      );
      if (!removed.ok) {
        throw new WorkspaceError(
          `git worktree remove failed: ${removed.stderr.trim().slice(0, 300)}`,
          409,
        );
      }
    });
  }

  // ---- terminals ----------------------------------------------------------

  private async rawSessions(): Promise<readonly RawSession[]> {
    const fmt = [
      "#{session_name}",
      "#{@uao_worktree}",
      "#{@uao_agent}",
      "#{@uao_created}",
      "#{session_activity}",
      "#{pane_dead}",
      "#{pane_dead_status}",
    ].join(SEP);
    const result = await this.tmux(["list-sessions", "-F", fmt]);
    if (!result.ok) return [];
    return result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split(SEP))
      .filter((f) => (f[0] ?? "").startsWith("term_"))
      .map((f) => ({
        name: f[0] ?? "",
        worktreeId: f[1] ?? "",
        agent: f[2] || "shell",
        createdAt: Number(f[3]) || 0,
        activity: Number(f[4]) || 0,
        dead: f[5] === "1",
        deadStatus: f[6] ?? "",
      }));
  }

  async listTerminals(worktreeSelector: string): Promise<readonly WorkspaceTerminal[]> {
    const worktree = await this.resolveWorktree(worktreeSelector);
    const sessions = (await this.rawSessions()).filter(
      (s) => s.worktreeId === worktree.worktreeId,
    );
    return Promise.all(
      sessions.map(async (s): Promise<WorkspaceTerminal> => {
        const preview = await this.preview(s.name);
        const base = {
          handle: s.name,
          worktreeId: worktree.worktreeId,
          worktreePath: worktree.path,
          branch: worktree.branch,
          title: s.agent === "shell" ? null : s.agent,
          connected: !s.dead,
          writable: !s.dead,
          lastOutputAt: s.activity * 1000,
          preview,
        };
        const withAgent = s.agent === "shell" ? base : { ...base, agentIdentity: s.agent };
        return s.dead
          ? { ...withAgent, exitCause: `exited (code ${s.deadStatus || "?"})` }
          : withAgent;
      }),
    );
  }

  private async preview(handle: string): Promise<string> {
    const result = await this.tmux(["capture-pane", "-p", "-J", "-t", handle]);
    if (!result.ok) return "";
    const lines = result.stdout.split("\n").map((l) => l.trimEnd());
    const last = [...lines].reverse().find((l) => l.length > 0) ?? "";
    return last.slice(0, 200);
  }

  async hasTerminal(handle: string): Promise<boolean> {
    return (await this.rawSessions()).some((s) => s.name === handle);
  }

  async createTerminal(
    worktreeSelector: string,
    agent: WorkspaceAgent,
  ): Promise<WorkspaceTerminal> {
    const worktree = await this.resolveWorktree(worktreeSelector);
    await this.ensureServer();
    const handle = `term_${crypto.randomUUID()}`;
    const command =
      agent === "shell"
        ? `exec ${shellQuote(this.shell)} -l`
        : `exec ${shellQuote(this.shell)} -l -i -c ${shellQuote(AGENT_COMMANDS[agent])}`;
    const created = await this.tmux([
      "new-session",
      "-d",
      "-s",
      handle,
      "-c",
      worktree.path,
      "-x",
      "120",
      "-y",
      "32",
      command,
      ";",
      // Per window, after creation: tmux 3.6 on macOS exits the server when a
      // session is created while `window-size manual` is set globally.
      "set-option",
      "-w",
      "-t",
      handle,
      "window-size",
      "manual",
      ";",
      "set-option",
      "-t",
      handle,
      "@uao_worktree",
      worktree.worktreeId,
      ";",
      "set-option",
      "-t",
      handle,
      "@uao_agent",
      agent,
      ";",
      "set-option",
      "-t",
      handle,
      "@uao_created",
      String(Date.now()),
    ]);
    if (!created.ok) {
      throw new WorkspaceError(
        `Could not start the terminal: ${created.stderr.trim().slice(0, 300)}`,
        500,
      );
    }
    const listed = await this.listTerminals(`id:${worktree.worktreeId}`);
    const terminal = listed.find((t) => t.handle === handle);
    if (terminal === undefined) {
      throw new WorkspaceError("The terminal exited immediately", 500);
    }
    return terminal;
  }

  async closeTerminal(handle: string): Promise<void> {
    if (!(await this.hasTerminal(handle))) {
      throw new WorkspaceError("Unknown terminal", 404);
    }
    await this.tmux(["kill-session", "-t", handle]);
  }

  async readTerminal(
    handle: string,
    limit: number,
  ): Promise<{
    readonly handle: string;
    readonly status: "running" | "exited";
    readonly tail: readonly string[];
    readonly truncated: boolean;
    readonly source: "screen";
  }> {
    const session = (await this.rawSessions()).find((s) => s.name === handle);
    if (session === undefined) throw new WorkspaceError("Unknown terminal", 404);
    const result = await this.tmux([
      "capture-pane",
      "-p",
      "-J",
      "-S",
      `-${Math.max(1, limit)}`,
      "-t",
      handle,
    ]);
    if (!result.ok) throw new WorkspaceError("Could not read the terminal", 500);
    const lines = result.stdout.split("\n").map((l) => l.trimEnd());
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return {
      handle,
      status: session.dead ? "exited" : "running",
      tail: lines.slice(-limit),
      truncated: lines.length > limit,
      source: "screen",
    };
  }

  async sendToTerminal(
    handle: string,
    input: {
      readonly text?: string | undefined;
      readonly enter?: boolean | undefined;
      readonly interrupt?: boolean | undefined;
    },
  ): Promise<{ readonly handle: string; readonly accepted: boolean; readonly bytesWritten: number }> {
    const session = (await this.rawSessions()).find((s) => s.name === handle);
    if (session === undefined) throw new WorkspaceError("Unknown terminal", 404);
    if (session.dead) throw new WorkspaceError("The terminal has exited", 409);
    let bytes = 0;
    if (input.interrupt === true) {
      await this.tmux(["send-keys", "-t", handle, "C-c"]);
      bytes = 1;
    } else if (input.text !== undefined && input.text.length > 0) {
      await this.tmux(["send-keys", "-t", handle, "-l", "--", input.text]);
      bytes = Buffer.byteLength(input.text);
      if (input.enter !== false) {
        await this.tmux(["send-keys", "-t", handle, "Enter"]);
        bytes += 1;
      }
    }
    return { handle, accepted: bytes > 0, bytesWritten: bytes };
  }

  // ---- live view ----------------------------------------------------------

  /** Visible screen plus scrollback as ANSI, with the cursor restored. */
  async snapshot(handle: string): Promise<{
    readonly cols: number;
    readonly rows: number;
    readonly ansi: string;
  }> {
    const dims = await this.tmux([
      "display-message",
      "-p",
      "-t",
      handle,
      ["#{pane_width}", "#{pane_height}", "#{cursor_x}", "#{cursor_y}"].join(SEP),
    ]);
    if (!dims.ok) throw new WorkspaceError("Unknown terminal", 404);
    const [cols, rows, cx, cy] = dims.stdout.trim().split(SEP).map(Number);
    const body = await this.tmux([
      "capture-pane",
      "-p",
      "-e",
      "-J",
      "-S",
      "-2000",
      "-t",
      handle,
    ]);
    if (!body.ok) throw new WorkspaceError("Could not read the terminal", 500);
    const screen = body.stdout.replace(/\n$/, "").replace(/\n/g, "\r\n");
    const ansi = `${screen}\u001b[0m\u001b[${(cy ?? 0) + 1};${(cx ?? 0) + 1}H`;
    return { cols: cols || 120, rows: rows || 32, ansi };
  }

  /** Arguments for a control-mode client attached to one terminal. */
  controlArgs(handle: string): string[] {
    return this.tmuxArgs(["-C", "attach-session", "-t", handle]);
  }
}
