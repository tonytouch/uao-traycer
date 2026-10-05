import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import {
  agentOsConfigQueryOptions,
  agentOsProbeQueryOptions,
} from "@/lib/uao/agent-os";
import {
  AGENT_OS_DEFAULT_BASE_URL,
  AGENT_OS_WEBVIEW_PARTITION,
  agentOsEmbedUrl,
  type AgentOsProbe,
} from "@traycer-clients/shared/agent-os-endpoints";
import { mountRemoteHttpGuest } from "@/lib/uao/remote-guest";
import { UaoAgentOsEndpoints } from "./uao-agent-os-endpoints";

function queryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "Agent OS could not be reached.";
}

function probeErrorMessage(
  isError: boolean,
  error: unknown,
  data: AgentOsProbe | undefined,
): string | null {
  if (isError) return queryErrorMessage(error);
  if (data !== undefined && !data.ok) return data.error;
  return null;
}

function guestErrorForKey(
  failure: { readonly key: string; readonly message: string } | null,
  guestKey: string,
): string | null {
  if (failure === null || failure.key !== guestKey) return null;
  return failure.message;
}

function pageFailure(input: {
  readonly configIsError: boolean;
  readonly configError: unknown;
  readonly probeIsError: boolean;
  readonly probeError: unknown;
  readonly probeData: AgentOsProbe | undefined;
  readonly guestFailure: {
    readonly key: string;
    readonly message: string;
  } | null;
  readonly guestKey: string;
}): string | null {
  if (input.configIsError) return queryErrorMessage(input.configError);
  const probed = probeErrorMessage(
    input.probeIsError,
    input.probeError,
    input.probeData,
  );
  if (probed !== null) return probed;
  return guestErrorForKey(input.guestFailure, input.guestKey);
}

function pageIsWaiting(input: {
  readonly failure: string | null;
  readonly configLoading: boolean;
  readonly probeLoading: boolean;
  readonly showGuest: boolean;
  readonly guestReady: boolean;
}): boolean {
  if (input.failure !== null) return false;
  if (input.configLoading || input.probeLoading) return true;
  return input.showGuest && !input.guestReady;
}

function UaoAgentOsGuest({
  embedUrl,
  onReady,
  onError,
}: {
  readonly embedUrl: string;
  readonly onReady: () => void;
  readonly onError: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
  }, [onReady, onError]);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    return mountRemoteHttpGuest({
      container,
      url: embedUrl,
      title: "Agent OS",
      partition: AGENT_OS_WEBVIEW_PARTITION,
      onReady: () => onReadyRef.current(),
      onError: (message) => onErrorRef.current(message),
    });
  }, [embedUrl]);
  return <div ref={containerRef} className="h-full w-full" />;
}

export function UaoAgentOsPane() {
  const queryClient = useQueryClient();
  const configQuery = useQuery(agentOsConfigQueryOptions());
  const embedUrl =
    configQuery.data?.embedUrl ?? agentOsEmbedUrl(AGENT_OS_DEFAULT_BASE_URL);
  const probeQuery = useQuery(
    agentOsProbeQueryOptions(embedUrl, configQuery.isSuccess),
  );
  const [showSettings, setShowSettings] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [guestFailure, setGuestFailure] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  const guestKey = `${embedUrl}:${String(attempt)}`;
  const failure = pageFailure({
    configIsError: configQuery.isError,
    configError: configQuery.error,
    probeIsError: probeQuery.isError,
    probeError: probeQuery.error,
    probeData: probeQuery.data,
    guestFailure,
    guestKey,
  });
  const showGuest = probeQuery.data?.ok === true && failure === null;
  const waiting = pageIsWaiting({
    failure,
    configLoading: configQuery.isLoading,
    probeLoading: probeQuery.isLoading,
    showGuest,
    guestReady: readyKey === guestKey,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: uaoQueryKeys.agentOs() });
  };

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex shrink-0 justify-end border-b border-border px-3 py-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={showSettings}
          onClick={() => setShowSettings((open) => !open)}
        >
          {showSettings ? "Hide endpoints" : "Endpoints"}
        </Button>
      </div>
      {showSettings && configQuery.data !== undefined ? (
        <UaoAgentOsEndpoints config={configQuery.data} onSaved={refresh} />
      ) : null}
      <div className="relative min-h-0 flex-1">
        {showGuest ? (
          <UaoAgentOsGuest
            key={guestKey}
            embedUrl={embedUrl}
            onReady={() => setReadyKey(guestKey)}
            onError={(message) => setGuestFailure({ key: guestKey, message })}
          />
        ) : null}
        {failure !== null ? (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6"
          >
            <AlertCircle className="size-6 text-destructive" />
            <h2 className="font-heading text-ui-md font-bold">
              Agent OS unavailable
            </h2>
            <p className="max-w-lg text-center text-ui-sm text-muted-foreground">
              {failure}
            </p>
            <p className="max-w-lg text-center font-mono text-ui-xs text-foreground">
              {embedUrl}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={configQuery.isFetching || probeQuery.isFetching}
              onClick={() => {
                setAttempt((value) => value + 1);
                void configQuery.refetch();
                void probeQuery.refetch();
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {waiting ? (
          <div
            role="status"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6"
          >
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
            <p className="text-ui-sm text-muted-foreground">
              Loading Agent OS…
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
