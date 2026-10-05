import { useCallback, useEffect, useRef, useState } from "react";
import { getWorkspaceTarget, workspaceApiPrefix } from "@/lib/uao/workspaces-target";
import { formatHex, parse } from "culori";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { useTerminalTheme } from "@/lib/terminal-theme";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import {
  Terminal as TerminalIcon,
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  decodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  decodeTerminalStreamJson,
  encodeTerminalStreamText,
  decodeTerminalStreamText,
  type TerminalStreamFrame,
} from "@traycer-clients/shared/uao/terminal-stream-protocol";

export interface UaoTerminalXtermProps {
  readonly handle: string;
  readonly title: string;
  readonly connected: boolean;
  readonly writable: boolean;
  readonly active: boolean;
  readonly agentIdentity?: string | undefined;
}

type ConnectionState = "connecting" | "streaming" | "disconnected";

const MAX_SNAPSHOT_CHUNK_BYTES = 1024 * 1024; // 1MB chunk limit
const MAX_PENDING_ACK_BYTES = 4 * 1024 * 1024; // 4MB flow-control limit

interface ValidOutputSpan {
  readonly data: string;
  readonly rawLength: number;
  readonly transformed: true;
}

function parseOutputSpan(payload: Uint8Array): ValidOutputSpan | null {
  const json = decodeTerminalStreamJson<{
    readonly data?: unknown;
    readonly rawLength?: unknown;
    readonly transformed?: unknown;
  }>(payload);
  if (
    typeof json?.data === "string" &&
    typeof json.rawLength === "number" &&
    Number.isSafeInteger(json.rawLength) &&
    json.rawLength >= 0 &&
    json.transformed === true
  ) {
    return {
      data: json.data,
      rawLength: json.rawLength,
      transformed: true,
    };
  }
  return null;
}

function sanitizeTerminalError(payload: Uint8Array): string {
  const raw = decodeTerminalStreamText(payload);
  let clean = "";
  for (let i = 0; i < raw.length && clean.length < 300; i++) {
    const code = raw.charCodeAt(i);
    clean += code >= 32 && code !== 127 ? raw[i] : " ";
  }
  return clean;
}

function getBadgeVariant(
  connState: ConnectionState,
  connected: boolean,
): "success" | "outline" | "destructive" {
  if (connState === "streaming") {
    return connected ? "success" : "destructive";
  }
  if (connState === "connecting") {
    return "outline";
  }
  return "destructive";
}

function getBadgeLabel(connState: ConnectionState, connected: boolean): string {
  if (connState === "streaming") {
    return connected ? "streaming" : "host disconnected";
  }
  if (connState === "connecting") {
    return "connecting…";
  }
  return "stream disconnected";
}

function ConnectionStatusIndicator({
  connState,
}: {
  readonly connState: ConnectionState;
}) {
  if (connState === "streaming") {
    return (
      <div className="flex items-center gap-1 text-micro text-success">
        <Wifi className="size-3" />
        <span>Live PTY</span>
      </div>
    );
  }
  if (connState === "connecting") {
    return (
      <div className="flex items-center gap-1 text-micro text-muted-foreground">
        <AgentSpinningDots className={undefined} testId={undefined} variant={undefined} tone="muted" />
        <span>Attaching…</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-micro text-destructive">
      <WifiOff className="size-3" />
      <span>Disconnected</span>
    </div>
  );
}

interface StreamContext {
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly ws: WebSocket;
  readonly updateStdinState: () => void;
  readonly fail: (message: string) => void;
  disposed: boolean;
  snapshotComplete: boolean;
  snapshotBytes: number;
  pendingEscapeTail: string;
  expectedSeq: number | undefined;
  pendingAckBytes: number;
  inputBlocked: boolean;
}

function resizeFromSnapshot(
  term: Terminal,
  cols: number | undefined,
  rows: number | undefined,
): void {
  if (
    cols !== undefined &&
    rows !== undefined &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 2 &&
    cols <= 500 &&
    rows >= 2 &&
    rows <= 300
  )
    term.resize(cols, rows);
}

function handleSnapshotFrame(
  frame: TerminalStreamFrame,
  ctx: StreamContext,
): void {
  if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
    const meta = decodeTerminalStreamJson<{
      cols?: number;
      rows?: number;
      seq?: number;
      unavailable?: string;
      pendingEscapeTailAnsi?: unknown;
    }>(frame.payload);
    if (!meta || meta.unavailable) {
      ctx.fail("Workspace could not reconstruct this terminal. Reconnect to retry.");
      return;
    }
    ctx.term.reset();
    ctx.snapshotBytes = 0;
    ctx.pendingEscapeTail =
      typeof meta.pendingEscapeTailAnsi === "string" &&
      meta.pendingEscapeTailAnsi.length <= 32 * 1024
        ? meta.pendingEscapeTailAnsi
        : "";
    ctx.snapshotComplete = false;
    ctx.updateStdinState();
    resizeFromSnapshot(ctx.term, meta.cols, meta.rows);
    ctx.expectedSeq = Number.isSafeInteger(meta.seq) ? meta.seq : undefined;
  } else if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
    ctx.snapshotBytes += frame.payload.byteLength;
    if (
      frame.payload.byteLength > MAX_SNAPSHOT_CHUNK_BYTES ||
      ctx.snapshotBytes > 8 * 1024 * 1024
    ) {
      ctx.fail("Terminal replay exceeds the viewer limit.");
      return;
    }
    ctx.term.write(frame.payload);
  } else if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
    // Stdin opens only after xterm has applied the replay, including its control sequences.
    ctx.term.write(ctx.pendingEscapeTail, () => {
      if (ctx.disposed || ctx.ws.readyState !== WebSocket.OPEN) return;
      ctx.snapshotComplete = true;
      ctx.updateStdinState();
      ctx.fitAddon.fit();
    });
  }
}

function handleOutputFrame(
  frame: TerminalStreamFrame,
  ctx: StreamContext,
): void {
  const span =
    frame.opcode === TerminalStreamOpcode.OutputSpan
      ? parseOutputSpan(frame.payload)
      : null;
  if (frame.opcode === TerminalStreamOpcode.OutputSpan && !span) {
    ctx.fail("Malformed Workspace output. Reconnect to restore the screen.");
    return;
  }
  const rawLength =
    span?.rawLength ?? decodeTerminalStreamText(frame.payload).length;
  // Workspace seq is the high-water character offset, not a frame counter.
  if (
    frame.seq > 0 &&
    ctx.expectedSeq !== undefined &&
    frame.seq - rawLength > ctx.expectedSeq
  ) {
    ctx.fail(
      "Terminal output was interrupted. Reconnect to restore the screen; input will not be replayed.",
    );
    return;
  }
  if (
    frame.seq > 0 &&
    ctx.expectedSeq !== undefined &&
    frame.seq <= ctx.expectedSeq
  ) {
    ctx.ws.send(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Ack,
        streamId: 1,
        seq: 0,
        payload: encodeTerminalStreamJson({ bytes: frame.payload.byteLength }),
      }),
    );
    return;
  }
  if (frame.seq > 0) ctx.expectedSeq = frame.seq;
  const byteLen = frame.payload.byteLength;
  ctx.pendingAckBytes += byteLen;
  if (ctx.pendingAckBytes > MAX_PENDING_ACK_BYTES) {
    ctx.fail("Terminal renderer stalled. Reconnect to restore the screen.");
    return;
  }
  ctx.term.write(span?.data ?? frame.payload, () => {
    if (ctx.disposed || ctx.ws.readyState !== WebSocket.OPEN) return;
    ctx.pendingAckBytes -= byteLen;
    ctx.ws.send(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Ack,
        streamId: 1,
        seq: 0,
        payload: encodeTerminalStreamJson({ bytes: byteLen }),
      }),
    );
  });
}

function handleTerminalControlFrame(
  frame: TerminalStreamFrame,
  ctx: StreamContext,
): void {
  if (frame.opcode === TerminalStreamOpcode.Error)
    ctx.fail(
      sanitizeTerminalError(frame.payload) ||
        "Workspace refused the terminal attachment.",
    );
  if (frame.opcode === TerminalStreamOpcode.WriteUnavailable)
    ctx.fail(
      "Workspace refused keyboard input. Check the original session before reconnecting.",
    );
}

/**
 * The viewer's colors as #rrggbb, for the runtime to answer OSC 10/11 colour
 * queries from programs in a terminal nobody is attached to.
 */
function themeColors(theme: ITheme): { fg: string; bg: string } | null {
  const fg = theme.foreground === undefined ? undefined : parse(theme.foreground);
  const bg = theme.background === undefined ? undefined : parse(theme.background);
  if (fg === undefined || bg === undefined) return null;
  return { fg: formatHex(fg), bg: formatHex(bg) };
}

export function UaoTerminalXterm(props: UaoTerminalXtermProps) {
  const { handle, title, connected, writable, active, agentIdentity } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const theme = useTerminalTheme();
  const themeRef = useRef(theme);

  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [reconnectKey, setReconnectKey] = useState(0);
  const [streamError, setStreamError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const handleManualReconnect = useCallback(() => {
    setReconnectKey((prev) => prev + 1);
  }, []);

  // Update xterm theme when resolved theme changes
  useEffect(() => {
    themeRef.current = theme;
    const term = termRef.current;
    if (term) {
      term.options.theme = theme;
      const ws = wsRef.current;
      const colors = themeColors(theme);
      if (ws?.readyState === WebSocket.OPEN && colors !== null) {
        ws.send(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Resize,
            streamId: 1,
            seq: 0,
            payload: encodeTerminalStreamJson({ cols: term.cols, rows: term.rows, ...colors }),
          }),
        );
      }
    }
  }, [theme]);

  // Terminal and streaming WebSocket lifecycle
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !active || !handle || !connected) {
      return;
    }

    const term = new Terminal({
      theme: themeRef.current,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: false, // Wire byte stream preserves CR/LF verbatim
      allowProposedApi: true,
      scrollback: 10000,
      screenReaderMode: true, // Accessibility support
      disableStdin: true, // Gated until initial snapshot completes
    });

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();

    term.loadAddon(fitAddon);
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";

    term.open(container);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const streamUrl = `${protocol}//${window.location.host}${workspaceApiPrefix(getWorkspaceTarget())}/terminal/stream?terminal=${encodeURIComponent(handle)}&cols=${term.cols}&rows=${term.rows}`;

    setConnState("connecting");
    setStreamError(null);
    const ws = new WebSocket(streamUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const sendViewport = (cols: number, rows: number, claim: boolean): void => {
      if (ws.readyState === WebSocket.OPEN) {
        const colors = themeColors(themeRef.current);
        const claimPayload = encodeTerminalStreamJson({ cols, rows, ...colors });
        const claimFrame = encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.ClaimViewport,
          streamId: 1,
          seq: 0,
          payload: claimPayload,
        });
        if (claim) ws.send(claimFrame);
        const resizeFrame = encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Resize,
          streamId: 1,
          seq: 0,
          payload: claimPayload,
        });
        ws.send(resizeFrame);
      }
    };

    const updateStdinState = (): void => {
      if (!termRef.current) return;
      const canType =
        !ctx.disposed &&
        ws.readyState === WebSocket.OPEN &&
        writable &&
        !ctx.inputBlocked &&
        ctx.snapshotComplete;
      termRef.current.options.disableStdin = !canType;
    };

    const ctx: StreamContext = {
      term,
      fitAddon,
      ws,
      updateStdinState,
      fail: (message) => {
        ctx.inputBlocked = true;
        term.options.disableStdin = true;
        setStreamError(message);
        setConnState("disconnected");
        ws.close(4008, "Terminal stream unavailable");
      },
      disposed: false,
      snapshotComplete: false,
      expectedSeq: undefined,
      snapshotBytes: 0,
      pendingEscapeTail: "",
      inputBlocked: false,
      pendingAckBytes: 0,
    };

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (!ctx.disposed && ctx.snapshotComplete && !ctx.inputBlocked) {
        sendViewport(cols, rows, container.contains(document.activeElement));
      }
    });

    ws.onopen = () => {
      if (ctx.disposed) return;
      setConnState("streaming");
      // Claim viewport for focused desktop with actual dimensions
      fitAddon.fit();
      if (container.contains(document.activeElement))
        sendViewport(term.cols, term.rows, true);
    };

    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (ctx.disposed) return;
      const bytes = new Uint8Array(event.data);
      const frame = decodeTerminalStreamFrame(bytes);
      if (frame === null || frame.streamId !== 1) {
        ctx.fail("Invalid Workspace terminal frame.");
        return;
      }

      const op = frame.opcode;
      if (
        op === TerminalStreamOpcode.SnapshotStart ||
        op === TerminalStreamOpcode.SnapshotChunk ||
        op === TerminalStreamOpcode.SnapshotEnd
      ) {
        handleSnapshotFrame(frame, ctx);
      } else if (
        op === TerminalStreamOpcode.Output ||
        op === TerminalStreamOpcode.OutputSpan
      ) {
        handleOutputFrame(frame, ctx);
      } else {
        handleTerminalControlFrame(frame, ctx);
      }
    };

    ws.onclose = () => {
      if (ctx.disposed) return;
      setConnState("disconnected");
      ctx.inputBlocked = true;
      updateStdinState();
      setStreamError(
        (previous) =>
          previous ??
          "Terminal stream closed. Reconnect to restore the screen; input is never replayed.",
      );
    };

    ws.onerror = () => {
      if (ctx.disposed) return;
      ctx.fail(
        "Terminal connection failed. Reconnect to retry; input is never replayed.",
      );
    };

    // Forward raw user keystrokes / ANSI sequences to upstream
    const dataDisposable = term.onData((data: string) => {
      if (
        ctx.disposed ||
        ctx.inputBlocked ||
        !writable ||
        !ctx.snapshotComplete
      )
        return;
      if (ws.readyState === WebSocket.OPEN) {
        const inputFrame = encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          streamId: 1,
          seq: 0,
          payload: encodeTerminalStreamText(data),
        });
        if (
          ws.bufferedAmount + inputFrame.byteLength > 64 * 1024 ||
          inputFrame.byteLength > 32 * 1024
        ) {
          ctx.fail(
            "Input exceeds the transport limit. Check delivery before sending it again.",
          );
          return;
        }
        ws.send(inputFrame);
      }
    });

    // Resize observer to refit terminal and notify PTY only when active
    const resizeObserver = new ResizeObserver(() => {
      if (ctx.disposed) return;
      try {
        fitAddon.fit();
      } catch {
        // ignore layout race
      }
    });
    resizeObserver.observe(container);
    const focusTerminal = () => sendViewport(term.cols, term.rows, true);
    container.addEventListener("focusin", focusTerminal);

    return () => {
      ctx.disposed = true;
      resizeObserver.disconnect();
      container.removeEventListener("focusin", focusTerminal);
      dataDisposable.dispose();
      resizeDisposable.dispose();

      // Gracefully detach viewer (sessions survive in Workspace background)
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const unsubFrame = encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Unsubscribe,
            streamId: 1,
            seq: 0,
            payload: new Uint8Array(0),
          });
          ws.send(unsubFrame);
        } catch {
          // ignore best effort unsubscribe
        }
      }
      ws.close();
      wsRef.current = null;

      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [handle, active, connected, writable, reconnectKey]);

  return (
    <main
      aria-label="Interactive terminal surface"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border/30 bg-card/60 px-4 py-2 text-micro">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-3.5 text-primary" />
          <span className="font-heading font-semibold text-foreground">
            {title || handle}
          </span>

          {agentIdentity ? (
            <Badge variant="accent" size="xs">
              {agentIdentity}
            </Badge>
          ) : null}

          {!writable && (
            <Badge variant="warning" size="xs">
              read-only
            </Badge>
          )}

          <Badge variant={getBadgeVariant(connState, connected)} size="xs">
            {getBadgeLabel(connState, connected)}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <ConnectionStatusIndicator connState={connState} />

          <Button
            variant="ghost"
            size="xs"
            onClick={handleManualReconnect}
            aria-label="Reconnect terminal stream"
          >
            <RefreshCw className="size-3" />
          </Button>
        </div>
      </div>

      {streamError ? (
        <p role="alert" className="px-4 py-2 text-ui-xs text-destructive">
          {streamError}
        </p>
      ) : null}
      <div
        ref={containerRef}
        role="region"
        aria-label="Interactive terminal output and input"
        className={cn(
          "flex-1 overflow-hidden bg-background p-2 font-mono text-ui-xs",
          !writable && "opacity-90",
        )}
      />
    </main>
  );
}
