import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  Info,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DEFAULT_CHAT_PROFILES,
  newSessionId,
  streamUaoChat,
  type HermesSSEEvent,
} from "@/lib/uao/adapter";
import { uaoMutationKeys } from "@/lib/query-keys/uao-mutation-keys";

export interface DisplayChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: number;
  readonly providerLabel: string;
  readonly isCancelled?: boolean | undefined;
}

interface ToolActivity {
  readonly tool_name?: string | undefined;
  readonly preview?: string | undefined;
}

const SLASH_LOOKUP = new Map<string, string>([
  ["jarvis", "jarvis"],
  ["spynel", "spynel"],
  ["hermes", "hermes"],
  ["codex", "codex"],
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["agy", "antigravity"],
  ["antigravity", "antigravity"],
  ["mavis", "mavis"],
  ["opencode", "opencode"],
]);

function resolveTurnProviderId(message: string, currentProfileId: string): string {
  const match = message.trim().match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
  if (match === null) return currentProfileId;
  const alias = match[1].toLowerCase();
  return SLASH_LOOKUP.get(alias) ?? currentProfileId;
}

function CopyMessageButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState<boolean>(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);

  if (text.length === 0) return null;

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      aria-label="Copy message"
    >
      {copied ? (
        <Check className="size-3 text-success" />
      ) : (
        <Copy className="size-3 text-muted-foreground" />
      )}
    </Button>
  );
}

export function UaoChatPane() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<readonly DisplayChatMessage[]>([]);
  const [draft, setDraft] = useState<string>("");
  const [activeProfileId, setActiveProfileId] = useState<string>("jarvis");
  const [toolActivity, setToolActivity] = useState<ToolActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const {
    isPending: streaming,
    mutateAsync: mutateStream,
    reset: resetStream,
  } = useMutation({
    mutationKey: uaoMutationKeys.chatStream(),
    mutationFn: streamUaoChat,
    retry: false,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<number>(0);

  const activeProfile = useMemo(() => {
    return (
      DEFAULT_CHAT_PROFILES.find((p) => p.id === activeProfileId) ??
      DEFAULT_CHAT_PROFILES[0]
    );
  }, [activeProfileId]);

  // Auto-scroll on new messages or stream updates
  useEffect(() => {
    if (scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming, toolActivity]);

  // Auto-resize composer textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    }
  }, [draft]);

  const handleStartNewChat = useCallback(() => {
    activeRequestIdRef.current += 1;
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    resetStream();
    setSessionId(null);
    setMessages([]);
    setError(null);
    setToolActivity(null);
    setDraft("");
    if (textareaRef.current !== null) {
      textareaRef.current.focus();
    }
  }, [resetStream]);

  const handleCancelStreaming = useCallback(() => {
    activeRequestIdRef.current += 1;
    if (abortRef.current !== null) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    resetStream();
    setToolActivity(null);
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      const updated: DisplayChatMessage = {
        ...last,
        isCancelled: true,
      };
      return [...prev.slice(0, -1), updated];
    });
  }, [resetStream]);

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || streaming) return;

    const targetProfileId = resolveTurnProviderId(trimmed, activeProfileId);
    const targetProfile =
      DEFAULT_CHAT_PROFILES.find((p) => p.id === targetProfileId) ??
      activeProfile;

    if (!targetProfile.streaming) {
      setError(
        `Cannot stream with ${targetProfile.label}: provider does not support streaming`,
      );
      return;
    }

    setDraft("");
    setError(null);
    setToolActivity(null);

    const now = Date.now();
    const userMsg: DisplayChatMessage = {
      id: `usr_${now}`,
      role: "user",
      content: trimmed,
      timestamp: now,
      providerLabel: "You",
    };
    const assistantMsg: DisplayChatMessage = {
      id: `asst_${now}`,
      role: "assistant",
      content: "",
      timestamp: now,
      providerLabel: targetProfile.label,
    };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    // Track request identity to prevent stale events/finally handlers
    const requestId = ++activeRequestIdRef.current;

    // Reuse one client session identifier until the user starts a new chat.
    const currentSessionId = sessionId ?? newSessionId();
    if (sessionId === null) {
      setSessionId(currentSessionId);
    }

    mutateStream({
      sessionId: currentSessionId,
      message: trimmed,
      provider: targetProfile.id,
      target: undefined,
      signal: controller.signal,
      onEvent: (evt: HermesSSEEvent) => {
        if (activeRequestIdRef.current !== requestId) return;
        if (evt.event === "assistant.delta") {
          const delta = typeof evt.data.delta === "string" ? evt.data.delta : "";
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const updated: DisplayChatMessage = {
              ...last,
              content: last.content + delta,
            };
            return [...prev.slice(0, -1), updated];
          });
        } else if (
          evt.event === "tool.progress" ||
          evt.event === "tool.started"
        ) {
          setToolActivity({
            tool_name:
              typeof evt.data.tool_name === "string"
                ? evt.data.tool_name
                : undefined,
            preview:
              typeof evt.data.preview === "string"
                ? evt.data.preview
                : undefined,
          });
        } else if (evt.event === "assistant.completed") {
          setToolActivity(null);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const finalContent =
              typeof evt.data.content === "string"
                ? evt.data.content
                : last.content;
            const updated: DisplayChatMessage = {
              ...last,
              content: finalContent,
            };
            return [...prev.slice(0, -1), updated];
          });
        } else if (evt.event === "error") {
          const msg =
            typeof evt.data.message === "string"
              ? evt.data.message
              : `${targetProfile.label} chat error`;
          setError(msg);
        }
      },
    }).catch((err: unknown) => {
        if (activeRequestIdRef.current !== requestId) return;
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const raw =
          err instanceof Error ? err.message : "Failed to communicate with UAO";
        setError(raw);
      })
      .finally(() => {
        if (activeRequestIdRef.current === requestId) {
          setToolActivity(null);
          abortRef.current = null;
        }
      });
  }, [
    draft,
    streaming,
    activeProfileId,
    activeProfile,
    sessionId,
    mutateStream,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  function renderEmptyState(): ReactNode {
    return (
      <div className="m-auto flex max-w-md flex-col items-center justify-center p-6 text-center">
        <div className="mb-3 flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
          <Bot className="size-6 text-primary" />
        </div>
        <h3 className="text-ui font-semibold text-foreground">
          {activeProfile.label}
        </h3>
        <p className="mt-1 text-ui-xs text-muted-foreground">
          {activeProfile.description}
        </p>

        <div className="mt-4 rounded-lg border border-border/40 bg-foreground/5 p-3 text-left">
          <div className="flex items-center gap-1.5 text-ui-xs font-semibold text-foreground">
            <Sparkles className="size-3.5 text-primary" />
            Quick tips
          </div>
          <ul className="mt-1.5 flex flex-col gap-1 font-mono text-micro text-muted-foreground">
            <li>• Press Enter to send, Shift+Enter for newline</li>
            <li>• Route a turn: /hermes, /claude, /codex, /agy</li>
            <li>• Preview mode: turns are fresh and held in memory</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <section className="flex h-full w-[85vw] min-w-0 shrink-0 flex-col bg-background md:w-auto md:flex-1">
      {/* Profile Switcher Strip */}
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {DEFAULT_CHAT_PROFILES.map((profile) => {
            const isSelected = profile.id === activeProfileId;
            const isNonStreaming = !profile.streaming;
            return (
              <button
                key={profile.id}
                type="button"
                onClick={() => setActiveProfileId(profile.id)}
                disabled={streaming || isNonStreaming}
                aria-pressed={isSelected}
                aria-label={`${profile.label}${isNonStreaming ? ", non-streaming" : ""}`}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-ui-xs font-medium transition-all",
                  isSelected
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border/40 bg-card text-muted-foreground hover:border-border hover:text-foreground",
                  isNonStreaming ? "cursor-not-allowed opacity-40" : "",
                )}
              >
                {profile.label}
                {isNonStreaming ? <span className="font-mono text-micro opacity-70">
                    (no stream)
                  </span> : null}
              </button>
            );
          })}
        </div>

        <Button
          variant="ghost"
          size="xs"
          onClick={handleStartNewChat}
          disabled={messages.length === 0 && sessionId === null}
          aria-label="New chat session"
        >
          <RotateCcw className="size-3" />
          New chat
        </Button>
      </div>

      {/* Fresh Turn Notice Banner */}
      <div className="flex items-center gap-2 border-b border-border/20 bg-foreground/5 px-3 py-1.5 text-micro text-muted-foreground">
        <Info className="size-3 text-info" />
        <span>
          Local CLI turns (Claude, Codex, Antigravity) execute fresh per turn and
          are non-resumable. Messages are preserved in preview memory.
        </span>
      </div>

      {/* Messages Scroll Area */}
      <div
        ref={scrollRef}
        className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
      >
        {messages.length === 0 ? renderEmptyState() : null}

        {messages.map((msg) => {
          const isUser = msg.role === "user";
          return (
            <div
              key={msg.id}
              className={cn(
                "flex flex-col gap-1 max-w-xl",
                isUser ? "self-end items-end" : "self-start items-start",
              )}
            >
              <div className="flex items-center gap-2 font-mono text-micro text-muted-foreground">
                <span className="font-semibold">{msg.providerLabel}</span>
                <span className="opacity-60">
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {!isUser && msg.content.length > 0 && (
                  <CopyMessageButton text={msg.content} />
                )}
              </div>

              <div
                className={cn(
                  "rounded-xl px-3.5 py-2.5 text-ui-sm leading-relaxed whitespace-pre-wrap shadow-xs",
                  isUser
                    ? "bg-primary text-primary-foreground"
                    : "border border-border/40 bg-card text-card-foreground",
                )}
              >
                {msg.content}
                {streaming &&
                  !isUser &&
                  msg === messages[messages.length - 1] ? <span className="ml-1 inline-flex items-center">
                      <AgentSpinningDots tone="inherit" />
                    </span> : null}
                {msg.isCancelled === true && (
                  <span className="ml-1 font-mono text-micro text-muted-foreground italic">
                    (interrupted)
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {/* Tool Activity Indicator */}
        {toolActivity !== null && (
          <div className="flex items-center gap-2 self-start rounded-md border border-border/40 bg-foreground/5 px-2.5 py-1.5 font-mono text-ui-xs text-muted-foreground">
            <Wrench className="size-3.5 text-primary" />
            <span className="font-semibold text-foreground">
              {toolActivity.tool_name ?? "tool"}
            </span>
            {toolActivity.preview !== undefined && (
              <span className="truncate max-w-sm opacity-80">
                {toolActivity.preview}
              </span>
            )}
            <AgentSpinningDots tone="muted" />
          </div>
        )}

        {/* Error Callout */}
        {error !== null && (
          <div className="flex items-center gap-2 self-start rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-ui-xs text-destructive">
            <AlertCircle className="size-4 shrink-0 text-destructive" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Composer Input Area */}
      <div className="border-t border-border/40 p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border/60 bg-card p-2 shadow-xs focus-within:border-ring">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${activeProfile.label}...`}
            aria-label={`Message ${activeProfile.label}...`}
            rows={1}
            disabled={streaming}
            className="flex-1 resize-none bg-transparent px-2 py-1 font-mono text-ui-sm text-foreground outline-hidden placeholder:text-muted-foreground disabled:opacity-50"
          />

          {streaming ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleCancelStreaming}
              aria-label="Stop generation"
            >
              <Square className="size-3" />
              Stop
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleSend()}
              disabled={draft.trim().length === 0 || !activeProfile.streaming}
              aria-label="Send message"
            >
              <Send className="size-3" />
              Send
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
