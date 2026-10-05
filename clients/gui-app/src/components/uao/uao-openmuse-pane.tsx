import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { uaoQueryKeys } from "@/lib/query-keys/uao-query-keys";
import {
  openmuseConfigQueryOptions,
  openmuseHealthQueryOptions,
} from "@/lib/uao/openmuse";
import {
  OPENMUSE_DEFAULT_API_URL,
  OPENMUSE_DEFAULT_WEB_URL,
  OPENMUSE_PARTITION,
  type OpenMuseEndpointConfig,
  type OpenMuseHealth,
} from "@traycer-clients/shared/openmuse";
import { mountRemoteHttpGuest } from "@/lib/uao/remote-guest";
import { UaoOpenMuseEndpoints } from "./uao-openmuse-endpoints";
import {
  useReportEndpointsChrome,
  type UaoEndpointsChrome,
} from "./uao-endpoints-chrome";

function queryErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "OpenMuse could not be reached.";
}

function embedWebUrl(health: OpenMuseHealth | undefined): string {
  if (health?.status === "ready" || health?.status === "degraded") {
    return health.webUrl;
  }
  return "";
}

function pageIsWaiting(input: {
  readonly failure: string | null;
  readonly unconfigured: boolean;
  readonly configLoading: boolean;
  readonly healthLoading: boolean;
  readonly showGuest: boolean;
  readonly guestReady: boolean;
}): boolean {
  if (input.failure !== null || input.unconfigured) return false;
  if (input.configLoading || input.healthLoading) return true;
  return input.showGuest && !input.guestReady;
}

function settingsAreOpen(
  showSettings: boolean,
  unconfigured: boolean,
  dismissed: boolean,
): boolean {
  return showSettings || (unconfigured && !dismissed);
}

function unconfiguredMessage(
  health: OpenMuseHealth | undefined,
): string | null {
  if (health?.status !== "unconfigured") return null;
  return health.message;
}

function degradedMessage(
  health: OpenMuseHealth | undefined,
  failure: string | null,
): string | null {
  if (failure !== null || health?.status !== "degraded") return null;
  return health.message;
}

function toggleOpenMuseSettings(input: {
  readonly settingsOpen: boolean;
  readonly setShowSettings: (value: boolean) => void;
  readonly setDismissedUnconfigured: (value: boolean) => void;
}): void {
  if (input.settingsOpen) {
    input.setShowSettings(false);
    input.setDismissedUnconfigured(true);
    return;
  }
  input.setShowSettings(true);
  input.setDismissedUnconfigured(false);
}

function shownWebUrl(
  health: OpenMuseHealth | undefined,
  configuredWebUrl: string,
): string {
  if (
    health !== undefined &&
    health.status !== "unconfigured" &&
    health.webUrl !== ""
  ) {
    return health.webUrl;
  }
  if (configuredWebUrl !== "") return configuredWebUrl;
  return OPENMUSE_DEFAULT_WEB_URL;
}

function pageFailure(input: {
  readonly configIsError: boolean;
  readonly configError: unknown;
  readonly healthIsError: boolean;
  readonly healthError: unknown;
  readonly health: OpenMuseHealth | undefined;
  readonly guestFailure: {
    readonly key: string;
    readonly message: string;
  } | null;
  readonly guestKey: string;
}): string | null {
  if (input.configIsError) return queryErrorMessage(input.configError);
  if (input.healthIsError) return queryErrorMessage(input.healthError);
  if (input.health?.status === "unreachable") return input.health.message;
  if (
    input.guestFailure !== null &&
    input.guestFailure.key === input.guestKey
  ) {
    return input.guestFailure.message;
  }
  return null;
}

function UaoOpenMuseGuest({
  webUrl,
  onReady,
  onError,
}: {
  readonly webUrl: string;
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
      url: webUrl,
      title: "OpenMuse",
      partition: OPENMUSE_PARTITION,
      onReady: () => onReadyRef.current(),
      onError: (message) => onErrorRef.current(message),
    });
  }, [webUrl]);
  return <div ref={containerRef} className="h-full w-full" />;
}

function OpenMuseSettingsForm({
  open,
  config,
  onSaved,
}: {
  readonly open: boolean;
  readonly config: OpenMuseEndpointConfig | undefined;
  readonly onSaved: () => Promise<void>;
}) {
  if (!open || config === undefined) return null;
  return <UaoOpenMuseEndpoints config={config} onSaved={onSaved} />;
}

function OpenMuseDegradedBanner({
  message,
  pending,
  onRetry,
}: {
  readonly message: string | null;
  readonly pending: boolean;
  readonly onRetry: () => void;
}) {
  if (message === null) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-3 py-2 text-ui-sm text-warning-foreground"
    >
      <p>{message}</p>
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

function OpenMuseFailure({
  message,
  url,
  pending,
  onRetry,
}: {
  readonly message: string | null;
  readonly url: string;
  readonly pending: boolean;
  readonly onRetry: () => void;
}) {
  if (message === null) return null;
  return (
    <div
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6"
    >
      <AlertCircle className="size-6 text-destructive" />
      <h2 className="font-heading text-ui-md font-bold">
        OpenMuse unavailable
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

function OpenMuseUnconfigured({
  message,
}: {
  readonly message: string | null;
}) {
  if (message === null) return null;
  return (
    <div
      role="status"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6"
    >
      <p className="max-w-lg text-center text-ui-sm text-muted-foreground">
        {message}
      </p>
    </div>
  );
}

function OpenMuseWaiting({ show }: { readonly show: boolean }) {
  if (!show) return null;
  return (
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
      <p className="text-ui-sm text-muted-foreground">Checking OpenMuse…</p>
    </div>
  );
}

function OpenMuseGuestSlot({
  show,
  guestKey,
  webUrl,
  onReady,
  onError,
}: {
  readonly show: boolean;
  readonly guestKey: string;
  readonly webUrl: string;
  readonly onReady: () => void;
  readonly onError: (message: string) => void;
}) {
  if (!show) return null;
  return (
    <UaoOpenMuseGuest
      key={guestKey}
      webUrl={webUrl}
      onReady={onReady}
      onError={onError}
    />
  );
}

function useOpenMusePaneModel() {
  const queryClient = useQueryClient();
  const configQuery = useQuery(openmuseConfigQueryOptions());
  const webUrl = configQuery.data?.webUrl ?? "";
  const apiUrl = configQuery.data?.apiUrl ?? OPENMUSE_DEFAULT_API_URL;
  const healthQuery = useQuery(
    openmuseHealthQueryOptions(webUrl, apiUrl, configQuery.isSuccess),
  );
  const [showSettings, setShowSettings] = useState(false);
  const [dismissedUnconfigured, setDismissedUnconfigured] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const [guestFailure, setGuestFailure] = useState<{
    readonly key: string;
    readonly message: string;
  } | null>(null);
  const health = healthQuery.data;
  const embedUrl = embedWebUrl(health);
  const guestKey = `${embedUrl}:${String(attempt)}`;
  const failure = pageFailure({
    configIsError: configQuery.isError,
    configError: configQuery.error,
    healthIsError: healthQuery.isError,
    healthError: healthQuery.error,
    health,
    guestFailure,
    guestKey,
  });
  const blank = unconfiguredMessage(health);
  const showGuest = embedUrl !== "" && failure === null;
  const waiting = pageIsWaiting({
    failure,
    unconfigured: blank !== null,
    configLoading: configQuery.isLoading,
    healthLoading: healthQuery.isLoading,
    showGuest,
    guestReady: readyKey === guestKey,
  });
  const settingsOpen = settingsAreOpen(
    showSettings,
    blank !== null,
    dismissedUnconfigured,
  );
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({
      queryKey: uaoQueryKeys.openmuse(),
    });
  };
  const retry = (): void => {
    setGuestFailure(null);
    setAttempt((value) => value + 1);
    void configQuery.refetch();
    void healthQuery.refetch();
  };
  return {
    config: configQuery.data,
    settingsOpen,
    settingsLabel: settingsOpen ? "Hide endpoints" : "Endpoints",
    degraded: degradedMessage(health, failure),
    healthPending: healthQuery.isFetching,
    failure,
    url: shownWebUrl(health, webUrl),
    pending: configQuery.isFetching || healthQuery.isFetching,
    blank,
    waiting,
    showGuest,
    guestKey,
    embedUrl,
    refresh,
    retry,
    retryHealth: () => {
      setAttempt((value) => value + 1);
      void healthQuery.refetch();
    },
    toggleSettings: () => {
      toggleOpenMuseSettings({
        settingsOpen,
        setShowSettings,
        setDismissedUnconfigured,
      });
    },
    onReady: () => setReadyKey(guestKey),
    onError: (message: string) => setGuestFailure({ key: guestKey, message }),
  };
}

export function UaoOpenMusePane({
  endpointsChrome,
}: {
  readonly endpointsChrome: UaoEndpointsChrome | null;
}) {
  const model = useOpenMusePaneModel();
  useReportEndpointsChrome(
    endpointsChrome,
    model.settingsOpen,
    model.settingsLabel,
    model.toggleSettings,
  );
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      {endpointsChrome === null ? (
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1">
          <h1 className="font-heading text-ui-sm font-bold">OpenMuse</h1>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={model.settingsOpen}
            onClick={model.toggleSettings}
          >
            {model.settingsLabel}
          </Button>
        </div>
      ) : null}
      <OpenMuseSettingsForm
        open={model.settingsOpen}
        config={model.config}
        onSaved={model.refresh}
      />
      <OpenMuseDegradedBanner
        message={model.degraded}
        pending={model.healthPending}
        onRetry={model.retryHealth}
      />
      <div className="relative min-h-0 flex-1">
        <OpenMuseGuestSlot
          show={model.showGuest}
          guestKey={model.guestKey}
          webUrl={model.embedUrl}
          onReady={model.onReady}
          onError={model.onError}
        />
        <OpenMuseFailure
          message={model.failure}
          url={model.url}
          pending={model.pending}
          onRetry={model.retry}
        />
        <OpenMuseUnconfigured message={model.blank} />
        <OpenMuseWaiting show={model.waiting} />
      </div>
    </div>
  );
}
