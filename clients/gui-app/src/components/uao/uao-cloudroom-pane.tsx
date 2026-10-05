import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import {
  cloudroomConfigQueryOptions,
  cloudroomEventsQueryOptions,
  cloudroomHealthQueryOptions,
  cloudroomSessionsQueryOptions,
  getCloudroomApi,
} from "@/lib/uao/cloudroom";
import {
  CLOUDROOM_DEFAULT_BASE_URL,
  CLOUDROOM_HARNESSES,
  CLOUDROOM_HARNESS_LABELS,
  type CloudroomCallResult,
  type CloudroomHarness,
  type CloudroomHealth,
  type CloudroomSessionSummary,
} from "@traycer-clients/shared/cloudroom";
import { UaoCloudroomEndpoints } from "./uao-cloudroom-endpoints";
import {
  endpointsChromeLabel,
  useReportEndpointsChrome,
  type UaoEndpointsChrome,
} from "./uao-endpoints-chrome";

function queryErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return fallback;
}

function healthFailure(
  isError: boolean,
  error: unknown,
  health: CloudroomHealth | undefined,
): string | null {
  if (isError) {
    return queryErrorMessage(error, "CloudRoom could not be reached.");
  }
  if (health === undefined || health.status === "ready") return null;
  return health.message;
}

function healthUrl(
  health: CloudroomHealth | undefined,
  configured: string,
): string {
  if (
    health !== undefined &&
    health.status !== "unconfigured" &&
    health.baseUrl !== ""
  ) {
    return health.baseUrl;
  }
  if (configured !== "") return configured;
  return "No CloudRoom URL";
}

function readyMessage(health: CloudroomHealth | undefined): string {
  if (health !== undefined && health.status === "ready") return health.message;
  return "Connected to CloudRoom.";
}

function sessionsFailure(
  query: UseQueryResult<
    CloudroomCallResult<readonly CloudroomSessionSummary[]>
  >,
): string | null {
  if (query.isError) {
    return queryErrorMessage(
      query.error,
      "CloudRoom sessions could not be listed.",
    );
  }
  if (query.data !== undefined && !query.data.ok) return query.data.error;
  return null;
}

function sessionLabel(session: CloudroomSessionSummary): string {
  return `${session.sessionId} · ${session.harness} · ${session.state}`;
}

function CloudroomTranscript({ sessionId }: { readonly sessionId: string }) {
  const eventsQuery = useQuery(cloudroomEventsQueryOptions(sessionId));
  const error = eventsQuery.isError
    ? queryErrorMessage(
        eventsQuery.error,
        "CloudRoom events could not be read.",
      )
    : (eventsQuery.data?.error ?? null);
  const text = eventsQuery.data?.text ?? "";

  return (
    <div className="flex min-h-0 flex-col overflow-auto p-4">
      {error !== null ? (
        <p role="alert" className="pb-2 text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      <pre className="font-mono text-ui-sm whitespace-pre-wrap text-foreground">
        {text !== "" ? text : "Waiting for session output…"}
      </pre>
    </div>
  );
}

function CloudroomHarnesses({
  harness,
  pending,
  onSelect,
}: {
  readonly harness: CloudroomHarness;
  readonly pending: boolean;
  readonly onSelect: (harness: CloudroomHarness) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {CLOUDROOM_HARNESSES.map((id) => (
        <Button
          key={id}
          type="button"
          variant={harness === id ? "default" : "outline"}
          size="sm"
          disabled={pending}
          aria-pressed={harness === id}
          onClick={() => onSelect(id)}
        >
          {CLOUDROOM_HARNESS_LABELS[id]}
        </Button>
      ))}
    </div>
  );
}

function CloudroomSessionList({
  sessions,
  error,
  loading,
  fetching,
  shownUrl,
  attached,
  onAttach,
  onRetry,
}: {
  readonly sessions: readonly CloudroomSessionSummary[];
  readonly error: string | null;
  readonly loading: boolean;
  readonly fetching: boolean;
  readonly shownUrl: string;
  readonly attached: string | null;
  readonly onAttach: (sessionId: string) => void;
  readonly onRetry: () => void;
}) {
  return (
    <div className="min-h-0 overflow-auto border-b border-border p-2 md:border-r md:border-b-0">
      {error !== null ? (
        <div role="alert" className="flex flex-col gap-2 p-2">
          <p className="text-ui-sm text-destructive">{error}</p>
          <p className="font-mono text-ui-xs text-foreground">{shownUrl}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={fetching}
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {error === null && sessions.length === 0 ? (
        <p className="p-2 text-ui-sm text-muted-foreground">
          {loading ? "Loading sessions…" : "No CloudRoom sessions yet."}
        </p>
      ) : null}
      {sessions.map((session) => (
        <Button
          key={session.sessionId}
          type="button"
          variant={attached === session.sessionId ? "secondary" : "ghost"}
          size="nav-row"
          className="w-full"
          aria-pressed={attached === session.sessionId}
          onClick={() => onAttach(session.sessionId)}
        >
          <span className="min-w-0 flex-1 truncate">
            {sessionLabel(session)}
          </span>
        </Button>
      ))}
    </div>
  );
}

function CloudroomDesk({
  baseUrl,
  banner,
  shownUrl,
}: {
  readonly baseUrl: string;
  readonly banner: string;
  readonly shownUrl: string;
}) {
  const queryClient = useQueryClient();
  const sessionsQuery = useQuery(cloudroomSessionsQueryOptions(baseUrl, true));
  const [harness, setHarness] = useState<CloudroomHarness>("codex");
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [attached, setAttached] = useState<string | null>(null);
  const start = useMutation({
    mutationKey: uaoQueryKeys.cloudroomStart(),
    mutationFn: () =>
      getCloudroomApi().createSession({ harness, prompt, workspace }),
    onSuccess: (result) => {
      if (result.ok) {
        setAttached(result.value.sessionId);
        setPrompt("");
      } else if (result.sessionId !== null) {
        setAttached(result.sessionId);
      }
      void queryClient.invalidateQueries({
        queryKey: uaoQueryKeys.cloudroomSessions(baseUrl),
      });
    },
  });
  const sessions =
    sessionsQuery.data !== undefined && sessionsQuery.data.ok
      ? sessionsQuery.data.value
      : [];
  const startError =
    start.data !== undefined && !start.data.ok ? start.data.error : null;

  return (
    <>
      <p className="border-b border-border px-4 py-2 text-ui-sm text-foreground">
        {banner}
      </p>
      <div className="flex flex-col gap-3 border-b border-border p-4">
        <CloudroomHarnesses
          harness={harness}
          pending={start.isPending}
          onSelect={setHarness}
        />
        <label
          className="flex flex-col gap-1 text-ui-sm"
          htmlFor="uao-cloudroom-workspace"
        >
          Workspace id (optional)
          <input
            id="uao-cloudroom-workspace"
            value={workspace}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={start.isPending}
            onChange={(event) => setWorkspace(event.currentTarget.value)}
            className="w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
          />
        </label>
        <label
          className="flex flex-col gap-1 text-ui-sm"
          htmlFor="uao-cloudroom-prompt"
        >
          First prompt (optional)
          <textarea
            id="uao-cloudroom-prompt"
            value={prompt}
            disabled={start.isPending}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            className="min-h-24 w-full rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-ui-xs text-foreground"
          />
        </label>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={start.isPending}
            onClick={() => {
              start.mutate();
            }}
          >
            Start
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={start.isPending || sessionsQuery.isFetching}
            onClick={() => {
              void sessionsQuery.refetch();
            }}
          >
            Refresh
          </Button>
          {start.isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
        </div>
        {startError !== null ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {startError}
          </p>
        ) : null}
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
        <CloudroomSessionList
          sessions={sessions}
          error={sessionsFailure(sessionsQuery)}
          loading={sessionsQuery.isLoading}
          fetching={sessionsQuery.isFetching}
          shownUrl={shownUrl}
          attached={attached}
          onAttach={setAttached}
          onRetry={() => {
            void sessionsQuery.refetch();
          }}
        />
        {attached !== null ? (
          <CloudroomTranscript key={attached} sessionId={attached} />
        ) : (
          <p className="p-4 text-ui-sm text-muted-foreground">
            Attach a session to see its output.
          </p>
        )}
      </div>
    </>
  );
}

function useCloudroomPaneState() {
  const queryClient = useQueryClient();
  const configQuery = useQuery(cloudroomConfigQueryOptions());
  const baseUrl = configQuery.data?.baseUrl ?? CLOUDROOM_DEFAULT_BASE_URL;
  const tokenSaved = configQuery.data?.tokenSaved ?? false;
  const healthQuery = useQuery(
    cloudroomHealthQueryOptions(baseUrl, tokenSaved, configQuery.isSuccess),
  );
  const [showSettings, setShowSettings] = useState(false);
  const configFailure = configQuery.isError
    ? queryErrorMessage(
        configQuery.error,
        "CloudRoom settings could not be read.",
      )
    : null;
  const failure =
    configFailure ??
    healthFailure(healthQuery.isError, healthQuery.error, healthQuery.data);
  const waiting =
    failure === null && (configQuery.isLoading || healthQuery.isLoading);
  const ready = healthQuery.data?.status === "ready" && failure === null;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: uaoQueryKeys.cloudroom() });
  };

  return {
    configQuery,
    healthQuery,
    baseUrl,
    failure,
    waiting,
    ready,
    showSettings,
    setShowSettings,
    refresh,
  };
}

function CloudroomFailure({
  message,
  url,
  pending,
  onRetry,
}: {
  readonly message: string;
  readonly url: string;
  readonly pending: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6"
    >
      <AlertCircle className="size-6 text-destructive" />
      <h2 className="font-heading text-ui-md font-bold">
        CloudRoom unavailable
      </h2>
      <p className="max-w-lg text-center text-ui-sm text-muted-foreground">
        {message}
      </p>
      <p className="max-w-lg text-center font-mono text-ui-xs text-foreground">
        {url}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}

export function UaoCloudroomPane({
  endpointsChrome,
}: {
  readonly endpointsChrome: UaoEndpointsChrome | null;
}) {
  const {
    configQuery,
    healthQuery,
    baseUrl,
    failure,
    waiting,
    ready,
    showSettings,
    setShowSettings,
    refresh,
  } = useCloudroomPaneState();
  const toggleSettings = (): void => {
    setShowSettings((open) => !open);
  };
  useReportEndpointsChrome(
    endpointsChrome,
    showSettings,
    endpointsChromeLabel(showSettings),
    toggleSettings,
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {endpointsChrome === null ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1">
          <h1 className="font-heading text-ui-sm font-bold">CloudRoom</h1>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={showSettings}
            onClick={toggleSettings}
          >
            {endpointsChromeLabel(showSettings)}
          </Button>
        </div>
      ) : null}
      {showSettings && configQuery.data !== undefined ? (
        <UaoCloudroomEndpoints config={configQuery.data} onSaved={refresh} />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {failure !== null ? (
          <CloudroomFailure
            message={failure}
            url={healthUrl(healthQuery.data, baseUrl)}
            pending={configQuery.isFetching || healthQuery.isFetching}
            onRetry={() => {
              void configQuery.refetch();
              void healthQuery.refetch();
            }}
          />
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
              Checking CloudRoom…
            </p>
          </div>
        ) : null}
        {ready ? (
          <CloudroomDesk
            baseUrl={baseUrl}
            banner={readyMessage(healthQuery.data)}
            shownUrl={healthUrl(healthQuery.data, baseUrl)}
          />
        ) : null}
      </div>
    </div>
  );
}
